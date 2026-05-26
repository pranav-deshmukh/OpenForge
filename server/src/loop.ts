import { callLLM, callLLMWithTools } from './agent.js';
import type { ToolDefinition } from './agent.js';
import {
  ensureWorkspaceReady,
  execInContainer,
  strReplaceInContainer,
  readFileFromContainer,
  insertAtLineInContainer,
  getPreinstalledPackages,
} from "./shell.js";
// Skills are loaded dynamically in future — not injected statically
import { 
  saveMemory, updateTask, getTask, getMemoryForTask, 
  createSubTask, updateSubTask, getSubTasksForTask, getSubTask,
  createArtifact, getArtifactsForTask, createReflection,
  getMemoryForSubTask, compressContext
} from './memory.js';
import { getSystemPrompt } from './prompts.js';
import type { Message, Task, SubTask, Artifact, AgentPersona, LoopState } from './types.js';

const MAX_ITERATIONS_PER_SUBTASK = 50;
const MAX_ITERATIONS_TOOL_MODE = 15;
const MAX_SUBTASK_RETRIES = 3;
const CONCURRENT_WORKERS = 3;

export async function processTask(task: Task): Promise<void> {
  try {
    let currentTask = getTask(task.id) || task;
    
    // 1. Routing Phase
    if (!currentTask.mode) {
      console.log(`[Router] Classifying intent for: ${currentTask.goal}`);
      const mode = await routeTask(currentTask);
      updateTask(currentTask.id, { mode });
      currentTask = getTask(currentTask.id)!;
    }

    console.log(`[Execution] Mode: ${currentTask.mode} | Goal: ${currentTask.goal}`);

    // 2. Dispatch
    switch (currentTask.mode) {
      case 'chat':
        await runChatMode(currentTask);
        break;
      case 'tool':
        await runToolMode(currentTask);
        break;
      case 'autonomous_dag':
        await runOrchestrator(currentTask);
        break;
      default:
        console.error(`[Execution] Unknown mode: ${currentTask.mode}`);
        updateTask(currentTask.id, { status: 'failed', error: `Unknown execution mode: ${currentTask.mode}` });
    }
  } catch (err: any) {
    console.error('[Execution] Fatal error:', err);
    updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: err.message || 'Fatal execution error' });
  }
}

export async function runAutonomousLoop(task: Task): Promise<void> {
  await processTask(task);
}

async function routeTask(task: Task): Promise<Task['mode']> {
  const systemPrompt = getSystemPrompt('router', { task });
  const response = await callLLM(systemPrompt, `Classify this request: ${task.goal}`);
  
  try {
    const classification = JSON.parse(cleanJsonResponse(response));
    console.log(`[Router] Decision: ${classification.mode} (${classification.reasoning})`);
    saveMemory(task.id, 'thought', `Routing to ${classification.mode} mode. Reasoning: ${classification.reasoning}`, null, 'episodic');
    return classification.mode;
  } catch (err) {
    console.error('[Router] Failed to parse classification, defaulting to tool:', err);
    return 'tool';
  }
}

async function runChatMode(task: Task) {
  updateTask(task.id, { status: 'running', startedAt: Date.now() });
  const systemPrompt = getSystemPrompt('chat', { task });
  const response = await callLLM(systemPrompt, task.goal, 'text/plain');
  
  saveMemory(task.id, 'output', response, null, 'working');
  updateTask(task.id, { status: 'done', completedAt: Date.now(), result: response });
  console.log(`[Chat] Response delivered.`);
}

async function runToolMode(task: Task) {
  updateTask(task.id, { status: 'running', startedAt: Date.now() });
  await ensureWorkspaceReady();
  
  const preinstalled = await getPreinstalledPackages();
  const envContext = `

## Environment — already installed, DO NOT reinstall these:

Node (global): ${preinstalled.npm.join(', ')}
Python (pip): ${preinstalled.pip.join(', ')}

If you need a package NOT in the above list, install it normally. It will persist across sessions via Docker volumes.
`;

  const systemPrompt = getSystemPrompt('standalone_worker', { task });
  const conversationHistory: Message[] = [
    { role: 'user', content: envContext },
    { role: 'user', content: task.goal }
  ];

  // Initialize with task createdAt - 1 to catch very early inputs
  let lastProcessedInputTime = task.createdAt - 1;

  for (let i = 1; i <= MAX_ITERATIONS_TOOL_MODE; i++) {
    // Check for user input
    const newInputs = getMemoryForTask(task.id).filter(m => m.type === 'input' && m.createdAt > lastProcessedInputTime);
    for (const input of newInputs) {
      conversationHistory.push({ role: 'user', content: `USER INPUT: ${input.content}` });
      lastProcessedInputTime = Math.max(lastProcessedInputTime, input.createdAt);
    }

    const compressedHistory = conversationHistory.map(m => ({ ...m, content: compressContext(m.content) }));
    const raw = await callLLM(systemPrompt, compressedHistory);
    
    // ALWAYS push assistant response to history to prevent spinning
    conversationHistory.push({ role: 'assistant', content: raw });

    let decision: any;
    try {
      decision = JSON.parse(cleanJsonResponse(raw));
      console.log(`[Tool] Step ${i}:`, decision.thought);
    } catch {
      conversationHistory.push({ role: 'user', content: 'Invalid JSON. Use format: {"thought": "...", "command": "...", "done": false}' });
      continue;
    }

    saveMemory(task.id, 'thought', decision.thought, null, 'working');

    if (decision.done) {
      updateTask(task.id, { status: 'done', completedAt: Date.now(), result: 'Task completed via Tool mode.' });
      return;
    }

    const command = decision.command?.trim();
    if (command === 'ask_user') {
      let waiting = true;
      while (waiting) {
        await new Promise(r => setTimeout(r, 5000));
        const checkInputs = getMemoryForTask(task.id).filter(m => m.type === 'input' && m.createdAt > lastProcessedInputTime);
        if (checkInputs.length > 0) {
          waiting = false;
          i--;
          break;
        }
      }
      continue;
    }

    if (command) {
      // Security Audit
      const isSafe = await runSecurityAudit(task, command, { title: 'Tool Execution' } as any);
      if (!isSafe) {
        saveMemory(task.id, 'security_alert', `Blocked command: ${command}`, null, 'working');
        conversationHistory.push({ role: 'user', content: 'Security Audit FAILED. Try another way.' });
        continue;
      }

      saveMemory(task.id, 'command', `$ ${command}`, null, 'working');
      const result = await execInContainer(command);
      const output = (result.stdout + result.stderr) || '(no output)';
      saveMemory(task.id, 'output', output, null, 'working');

      conversationHistory.push({ role: 'user', content: `Output:\n${output}` });
    } else {
      // No command and not done? Ask for next step
      conversationHistory.push({ role: 'user', content: 'Please provide a command or set "done" to true if you are finished.' });
    }
  }

  updateTask(task.id, { status: 'failed', error: 'Max iterations reached in Tool mode' });
}

export async function runOrchestrator(task: Task): Promise<void> {
  try {
    console.log(`\n[Orchestrator] Starting: ${task.goal}`);
    updateTask(task.id, { status: 'running', startedAt: Date.now() });
    saveMemory(task.id, 'thought', `Starting orchestrated goal: ${task.goal}`, null, 'episodic');

    await ensureWorkspaceReady();

    // 1. Planning Phase
    await planTask(task);

    // 2. Execution Loop
    let completed = false;
    const activeSubTasks = new Set<string>();

    while (!completed) {
      const subTasks = getSubTasksForTask(task.id);
      const unblocked = subTasks.filter(st => 
        st.status === 'pending' && 
        !activeSubTasks.has(st.id) &&
        st.dependencies.every(depTitle => {
          const dep = subTasks.find(s => s.title === depTitle);
          return dep && dep.status === 'done';
        })
      );

      if (unblocked.length === 0 && activeSubTasks.size === 0) {
        if (subTasks.every(st => st.status === 'done')) {
          completed = true;
          break;
        }
        if (subTasks.some(st => st.status === 'failed' && st.retryCount >= MAX_SUBTASK_RETRIES)) {
          console.error('[Orchestrator] Task failed: Some subtasks failed permanently.');
          updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: 'Some subtasks failed permanently.' });
          return;
        }
        
        console.log('[Orchestrator] No unblocked tasks and not all done. Checking for replanning...');
        await reflectAndReplan(task);
        continue;
      }

      // Execute unblocked subtasks in parallel (up to limit)
      const toDispatch = unblocked.slice(0, CONCURRENT_WORKERS - activeSubTasks.size);
      
      for (const subTask of toDispatch) {
        activeSubTasks.add(subTask.id);
        console.log(`[Orchestrator] Dispatching Worker for: ${subTask.title}`);
        dispatchWorker(task, subTask).catch(err => {
          console.error(`[Orchestrator] Worker failed for ${subTask.title}:`, err);
        }).finally(() => activeSubTasks.delete(subTask.id));
      }

      // Wait a bit before checking status again
      await new Promise(r => setTimeout(r, 5000));
    }

    console.log(`\n[Orchestrator] Goal achieved: ${task.goal}`);
    updateTask(task.id, { status: 'done', completedAt: Date.now(), result: 'Goal completed successfully via parallel DAG execution.' });
  } catch (err: any) {
    console.error('[Orchestrator] Fatal error:', err);
    updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: err.message || 'Fatal orchestrator error' });
    saveMemory(task.id, 'error', `Fatal orchestrator error: ${err.message || err}`, null, 'working');
  }
}

async function dispatchWorker(task: Task, subTask: SubTask) {
  console.log(`\n[Orchestrator] Dispatching Worker for: ${subTask.title}`);
  await runWorkerAgent(task, subTask);
  
  // Verification Phase
  const updatedSubTask = getSubTask(subTask.id);
  if (updatedSubTask && updatedSubTask.status === 'done') {
    const passed = await verifySubTask(task, updatedSubTask);
    if (passed) {
      // Critique Phase
      const criticPassed = await runCriticLoop(task, updatedSubTask);
      if (!criticPassed) {
        console.log(`[Orchestrator] Critique failed for: ${subTask.title}`);
        await handleSubTaskFailure(task, updatedSubTask, 'critique');
      }
    } else {
      console.log(`[Orchestrator] Verification failed for: ${subTask.title}`);
      await handleSubTaskFailure(task, updatedSubTask, 'verification');
    }
  } else if (updatedSubTask && updatedSubTask.status === 'failed') {
    await handleSubTaskFailure(task, updatedSubTask, 'execution');
  }
}

async function planTask(task: Task) {
  console.log('[Planner] Decomposing goal...');
  const systemPrompt = getSystemPrompt('planner', { task });
  const response = await callLLM(systemPrompt, `Plan the execution for: ${task.goal}`);
  
  try {
    const plan = JSON.parse(cleanJsonResponse(response));
    updateTask(task.id, { 
      globalContext: plan.globalContext,
      successCriteria: plan.successCriteria
    });

    const subTaskSummary = plan.subTasks.map((st: any) => `- ${st.title}: ${st.description}`).join('\n');
    saveMemory(task.id, 'thought', `I have generated an execution plan:\n${subTaskSummary}\n\nPlease review and reply 'approve' to proceed, or provide feedback to replan.`, null, 'episodic');
    
    // Pause for user approval
    let approved = false;
    let lastProcessedInputTime = Date.now();
    
    while (!approved) {
      await new Promise(r => setTimeout(r, 5000));
      const inputs = getMemoryForTask(task.id).filter(m => m.type === 'input' && m.createdAt > lastProcessedInputTime);
      
      if (inputs.length > 0) {
        const lastInput = inputs[inputs.length - 1].content.toLowerCase();
        if (lastInput.includes('approve')) {
          approved = true;
          saveMemory(task.id, 'thought', 'Plan approved. Starting execution...', null, 'episodic');
        } else {
          // Re-planning with feedback
          saveMemory(task.id, 'thought', `Feedback received: "${lastInput}". Re-planning...`, null, 'episodic');
          return planTask(task); // Recursive call for now, could be improved
        }
      }
    }

    for (const st of plan.subTasks) {
      createSubTask({
        taskId: task.id,
        title: st.title,
        description: st.description,
        type: st.type,
        dependencies: st.dependencies || [],
        priority: st.priority || 0,
        inputArtifacts: st.inputArtifacts || [],
        outputArtifacts: st.outputArtifacts || [],
        successCriteria: st.successCriteria || [],
      });
    }
    saveMemory(task.id, 'thought', `Planner generated ${plan.subTasks.length} subtasks.`, null, 'episodic');
  } catch (err) {
    console.error('[Planner] Failed to parse plan:', err);
    saveMemory(task.id, 'error', `Planner failed: ${response}`, null, 'working');
    throw err;
  }
}

// ── Tool definitions — the agent sees these and picks automatically ──────────
const WORKER_TOOLS: ToolDefinition[] = [
  {
    name: 'run_shell',
    description: 'Run a bash command in the Docker workspace container. Use for: creating new files, installing packages, running tests, starting servers, listing directories, checking git status. Do NOT use for editing existing files — use str_replace_file instead.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to execute inside the container'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: 'Read the full contents of a file inside the container. Always call this before editing an existing file so you have the exact current text.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file inside the container, e.g. /workspace/src/index.ts'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'str_replace_file',
    description: 'Surgically edit an existing file by replacing a unique block of text. Never rewrites the whole file. Use this for ALL edits to existing files. old_str must appear exactly once in the file — include enough surrounding lines to make it unique.',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Absolute path to the file inside the container'
        },
        old_str: {
          type: 'string',
          description: 'The exact text currently in the file to be replaced. Must be unique — include 2-3 lines of context above and below the change if needed.'
        },
        new_str: {
          type: 'string',
          description: 'The text to replace old_str with'
        }
      },
      required: ['file', 'old_str', 'new_str']
    }
  },
  {
    name: 'ask_user',
    description: 'Pause execution and ask the user a clarifying question. Only use when genuinely blocked and cannot proceed without human input.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user'
        }
      },
      required: ['question']
    }
  },
  {
    name: 'task_done',
    description: 'Call this when the subtask is fully complete and all success criteria are met. Do not call this until the work is verified.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Detailed summary of everything done, for the verifier agent'
        },
        artifacts: {
          type: 'array',
          description: 'List of produced artifacts',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              content: { type: 'string' }
            }
          }
        }
      },
      required: ['summary']
    }
  }
];

async function runWorkerAgent(task: Task, subTask: SubTask) {
  updateSubTask(subTask.id, { status: 'running', startedAt: Date.now() });
  saveMemory(task.id, 'thought', `Worker starting subtask: ${subTask.title}`, subTask.id, 'working');

  const preinstalled = await getPreinstalledPackages();
  const envContext = `

## Environment — already installed, DO NOT reinstall these:

Node (global): ${preinstalled.npm.join(', ')}
Python (pip): ${preinstalled.pip.join(', ')}

If you need a package NOT in the above list, install it normally. It will persist across sessions via Docker volumes.
`;

  const artifacts = getArtifactsForTask(task.id);
  const systemPrompt = getSystemPrompt('worker', { task, subTask, artifacts });

  const conversationHistory: Message[] = [
    { role: 'user', content: envContext },
    { role: 'user', content: `Start working on SubTask: ${subTask.title}\nDescription: ${subTask.description}` }
  ];

  let lastProcessedInputTime = subTask.createdAt - 1;

  for (let i = 1; i <= MAX_ITERATIONS_PER_SUBTASK; i++) {
    // Check for user input
    const newInputs = getMemoryForSubTask(subTask.id).filter(
      m => m.type === 'input' && m.createdAt > lastProcessedInputTime
    );
    for (const input of newInputs) {
      conversationHistory.push({ role: 'user', content: `USER INPUT: ${input.content}` });
      lastProcessedInputTime = Math.max(lastProcessedInputTime, input.createdAt);
    }

    let response;
    try {
      const compressedHistory = conversationHistory.map(m => ({
        ...m,
        content: compressContext(m.content)
      }));
      response = await callLLMWithTools(systemPrompt, compressedHistory, WORKER_TOOLS);
    } catch (err: any) {
      saveMemory(task.id, 'error', `LLM error in worker: ${err.message}`, subTask.id, 'working');
      continue;
    }

    const { thought, toolCall } = response;

    if (thought) {
      saveMemory(task.id, 'thought', `[${subTask.title}] ${thought}`, subTask.id, 'working');
      console.log(`[Worker] ${subTask.title} thought: ${thought.slice(0, 120)}...`);
    }

    // Push assistant turn into history
    conversationHistory.push({ role: 'assistant', content: thought || `[tool: ${toolCall?.name}]` });

    if (!toolCall) {
      // Model returned text only — nudge it to use a tool
      conversationHistory.push({ role: 'user', content: 'Please call one of your available tools to proceed. If the task is complete, call task_done.' });
      continue;
    }

    console.log(`[Worker] Tool call: ${toolCall.name}`, JSON.stringify(toolCall.args).slice(0, 100));

    // ── Dispatch tool calls ──────────────────────────────────────────────────

    if (toolCall.name === 'task_done') {
      const { summary, artifacts: arts = [] } = toolCall.args;
      for (const art of arts) {
        createArtifact({
          taskId: task.id,
          name: art.name,
          type: art.type || 'unknown',
          content: art.content || '',
          producerSubTaskId: subTask.id
        });
      }
      updateSubTask(subTask.id, { status: 'done', completedAt: Date.now(), result: summary });
      return;
    }

    if (toolCall.name === 'ask_user') {
      saveMemory(task.id, 'thought', `[${subTask.title}] WAITING FOR USER: ${toolCall.args.question}`, subTask.id, 'working');
      let waiting = true;
      while (waiting) {
        await new Promise(r => setTimeout(r, 5000));
        const checkInputs = getMemoryForSubTask(subTask.id).filter(
          m => m.type === 'input' && m.createdAt > lastProcessedInputTime
        );
        if (checkInputs.length > 0) {
          waiting = false;
          i--;
          break;
        }
      }
      continue;
    }

    if (toolCall.name === 'read_file') {
      const { path } = toolCall.args;
      saveMemory(task.id, 'command', `[read_file] ${path}`, subTask.id, 'working');
      const result = await readFileFromContainer(path);
      const output = result.stdout || '(empty file)';
      saveMemory(task.id, 'output', output.slice(0, 2000), subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `Contents of ${path}:\n${output}` });
      continue;
    }

    if (toolCall.name === 'str_replace_file') {
      const { file, old_str, new_str } = toolCall.args;
      saveMemory(task.id, 'command', `[str_replace] ${file}`, subTask.id, 'working');
      const result = await strReplaceInContainer(file, old_str, new_str);
      const output = (result.stdout + result.stderr) || '(no output)';
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `str_replace result (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'run_shell') {
      const { command } = toolCall.args;

      // Static blocklist — runs before LLM security audit
      const ALWAYS_BLOCK = [
        /rm\s+-rf\s+\/(?!workspace)/,
        /chmod\s+777\s+\//,
        /curl[^|]+\|\s*(bash|sh)/,
        /wget[^|]+\|\s*(bash|sh)/,
        />\s*\/etc\//,
        /mkfs/,
        /dd\s+if=/,
      ];
      const hardBlocked = ALWAYS_BLOCK.some(pattern => pattern.test(command));
      if (hardBlocked) {
        saveMemory(task.id, 'security_alert', `Hard-blocked command: ${command}`, subTask.id, 'working');
        conversationHistory.push({ role: 'user', content: 'That command is blocked by the security policy. Please use a safer alternative.' });
        continue;
      }

      // LLM security audit as second layer
      const isSafe = await runSecurityAudit(task, command, subTask);
      if (!isSafe) {
        saveMemory(task.id, 'security_alert', `Security audit blocked: ${command}`, subTask.id, 'working');
        conversationHistory.push({ role: 'user', content: 'Security Audit FAILED: command blocked. Please suggest an alternative approach.' });
        continue;
      }

      saveMemory(task.id, 'command', `$ ${command}`, subTask.id, 'working');
      const result = await execInContainer(command, 600000);
      const output = (result.stdout + result.stderr) || '(no output)';
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `Command output (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    // Unknown tool — tell the model
    conversationHistory.push({ role: 'user', content: `Unknown tool: ${toolCall.name}. Available tools: run_shell, read_file, str_replace_file, ask_user, task_done.` });
  }

  updateSubTask(subTask.id, { status: 'failed', completedAt: Date.now(), error: 'Max iterations reached' });
}

async function runSecurityAudit(task: Task, command: string, subTask: SubTask): Promise<boolean> {
  const systemPrompt = getSystemPrompt('security', { task, subTask });
  const response = await callLLM(systemPrompt, `Proposed Command: ${command}`);
  
  try {
    const audit = JSON.parse(cleanJsonResponse(response));
    return !!audit.safe;
  } catch {
    return false; // Default to unsafe on error
  }
}

async function verifySubTask(task: Task, subTask: SubTask): Promise<boolean> {
  console.log(`[Verifier] Validating: ${subTask.title}`);
  updateSubTask(subTask.id, { status: 'verifying' });
  const systemPrompt = getSystemPrompt('verifier', { task, subTask });
  const response = await callLLM(systemPrompt, `Verify the completion of: ${subTask.title}\nResult: ${subTask.result}`);
  
  let result: any;
  try {
    result = JSON.parse(cleanJsonResponse(response));
  } catch {
    saveMemory(task.id, 'error', `Verifier failed to output JSON: ${response}`, subTask.id, 'working');
    return false;
  }

  const passed = !!result.passed;
  saveMemory(task.id, 'thought', `[Verifier] ${subTask.title}: ${passed ? 'PASSED' : 'FAILED'}\n${result.thought || ''}`, subTask.id, 'working');
  
  if (!passed) {
    updateSubTask(subTask.id, { status: 'failed', error: result.feedback || 'Verification failed' });
  }
  return passed;
}

async function runCriticLoop(task: Task, subTask: SubTask): Promise<boolean> {
  console.log(`[Critic] Reviewing: ${subTask.title}`);
  updateSubTask(subTask.id, { status: 'critiquing' });
  const systemPrompt = getSystemPrompt('critic', { task, subTask });
  const response = await callLLM(systemPrompt, `Critique the work done for: ${subTask.title}\nSummary: ${subTask.result}`);

  let result: any;
  try {
    result = JSON.parse(cleanJsonResponse(response));
  } catch {
    saveMemory(task.id, 'error', `Critic failed to output JSON: ${response}`, subTask.id, 'working');
    return true; // Don't block on parsing error
  }

  const passed = !!result.passed;
  saveMemory(task.id, 'critique', `[Critic] Score: ${result.score}/10 - ${passed ? 'PASSED' : 'FAILED'}\n${result.feedback || ''}`, subTask.id, 'episodic');
  
  if (!passed) {
    updateSubTask(subTask.id, { status: 'failed', critique: result.feedback || 'Critique failed' });
  } else {
    updateSubTask(subTask.id, { status: 'done' });
  }
  return passed;
}

async function handleSubTaskFailure(task: Task, subTask: SubTask, phase: string) {
  console.log(`[Reflection] Analyzing ${phase} failure for: ${subTask.title}`);
  const systemPrompt = getSystemPrompt('reflection', { task, subTask });
  const response = await callLLM(systemPrompt, `Analyze why ${subTask.title} failed in ${phase} phase.`);
  
  let result: any;
  try {
    result = JSON.parse(cleanJsonResponse(response));
  } catch {
    saveMemory(task.id, 'error', `Reflection failed to output JSON: ${response}`, subTask.id, 'working');
    return;
  }

  createReflection(subTask.id, result.thought || response);
  saveMemory(task.id, 'thought', `[Reflection] ${subTask.title} analysis: ${result.thought || ''}`, subTask.id, 'episodic');

  if (subTask.retryCount < MAX_SUBTASK_RETRIES) {
    updateSubTask(subTask.id, { 
      status: 'retrying', 
      retryCount: subTask.retryCount + 1 
    });
    // Reset status to pending for executor to pick up again
    updateSubTask(subTask.id, { status: 'pending' });
  } else {
    updateSubTask(subTask.id, { status: 'failed' });
  }
}

async function reflectAndReplan(task: Task) {
  console.log('[Orchestrator] Replanning...');
  const subTasks = getSubTasksForTask(task.id);
  const artifacts = getArtifactsForTask(task.id);
  const systemPrompt = getSystemPrompt('planner', { task, allSubTasks: subTasks, artifacts });
  
  const response = await callLLM(systemPrompt, "The current DAG is stuck or failed. Please update the DAG to resolve the issues.");
  saveMemory(task.id, 'thought', `Planner replan response: ${response}`, null, 'episodic');
  
  try {
    const plan = JSON.parse(cleanJsonResponse(response));
    for (const st of plan.subTasks) {
      const existing = subTasks.find(s => s.title === st.title);
      if (!existing) {
        createSubTask({
          taskId: task.id,
          title: st.title,
          description: st.description,
          type: st.type,
          dependencies: st.dependencies || [],
          priority: st.priority || 0,
          inputArtifacts: st.inputArtifacts || [],
          outputArtifacts: st.outputArtifacts || [],
          successCriteria: st.successCriteria || [],
        });
      }
    }
  } catch (err) {
    console.error('[Orchestrator] Replanning failed to parse:', err);
  }
}

function cleanJsonResponse(raw: string): string {
  return raw
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
}

