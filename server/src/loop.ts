import { callLLM, callLLMWithTools } from './agent.js';
import type { ToolDefinition } from './agent.js';
import {
  ensureWorkspaceReady,
  execInContainer,
  strReplaceInContainer,
  readFileFromContainer,
  insertAtLineInContainer,
  pathExistsInContainer,
  getPreinstalledPackages,
} from "./shell.js";
// Skills are loaded dynamically in future — not injected statically
import { 
  saveMemory, updateTask, getTask, getMemoryForTask, 
  createSubTask, updateSubTask, getSubTasksForTask, getSubTask,
  createArtifact, getArtifactsForTask, createReflection,
  getMemoryForSubTask, compressContext, incrementTaskIterations
} from './memory.js';
import {
  clearAgentAssignment,
  emitDelegationEvent,
  resolveAssignedAgent,
  setAgentPhase,
} from './agents.js';
import { getSystemPrompt } from './prompts.js';
import { releaseWorkspaceLocks, tryAcquireWorkspaceLocks } from './workspace-locks.js';
import type { AgentId, Message, Task, SubTask } from './types.js';

const MAX_ITERATIONS_PER_SUBTASK = 50;
const MAX_ITERATIONS_TOOL_MODE = 15;
const MAX_SUBTASK_RETRIES = 3;
const CONCURRENT_WORKERS = 2;

function isTaskCancelled(taskId: string): boolean {
  return getTask(taskId)?.status === 'cancelled';
}

function isSubTaskCancelled(subTaskId: string): boolean {
  const subTask = getSubTask(subTaskId);
  if (!subTask) return true;
  return subTask.status === 'cancelled' || isTaskCancelled(subTask.taskId);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUserInput(
  taskId: string,
  subTaskId: string | null,
  lastProcessedInputTime: number,
): Promise<number> {
  while (true) {
    if (isTaskCancelled(taskId) || (subTaskId && isSubTaskCancelled(subTaskId))) {
      throw new Error('Task cancelled by user');
    }

    await sleep(2000);
    const entries = subTaskId
      ? getMemoryForSubTask(subTaskId)
      : getMemoryForTask(taskId);
    const newInputs = entries.filter((m) => m.type === 'input' && m.createdAt > lastProcessedInputTime);
    if (newInputs.length > 0) {
      return Math.max(...newInputs.map((m) => m.createdAt), lastProcessedInputTime);
    }
  }
}

function heuristicRouteTask(goal: string): Task['mode'] | null {
  const text = goal.trim().toLowerCase();
  if (!text) return 'chat';

  const isQuestion =
    text.endsWith('?') ||
    /^(what|why|how|who|when|where|can you explain|explain)\b/.test(text);
  if (isQuestion && !/(build|implement|create|edit|fix|run|install|write)\b/.test(text)) {
    return 'chat';
  }

  if (
    /(build|create|implement|research and implement|multi-step|full-stack|system|architecture|workflow|saas|agent)\b/.test(text) &&
    /(app|project|system|workflow|service|dashboard|platform|research)\b/.test(text)
  ) {
    return 'autonomous_dag';
  }

  if (/(run|fix|edit|change|update|refactor|test|debug|create file|write file|rename)\b/.test(text)) {
    return 'tool';
  }

  if (text.split(/\s+/).length > 40) {
    return 'autonomous_dag';
  }

  return null;
}

function dependencyIdsFromTitles(
  dependencyTitles: string[] = [],
  titleToId: Map<string, string>,
): string[] {
  return dependencyTitles
    .map((title) => titleToId.get(title))
    .filter((value): value is string => Boolean(value));
}

function getSubTaskAgentId(subTask: SubTask): AgentId {
  return subTask.assignedAgent || resolveAssignedAgent(subTask);
}

function hasRequiredArtifacts(task: Task, subTask: SubTask): boolean {
  const artifactNames = new Set(getArtifactsForTask(task.id).map((artifact) => artifact.name));
  return subTask.inputArtifacts.every((artifactName) => artifactNames.has(artifactName));
}

export async function processTask(task: Task): Promise<void> {
  try {
    let currentTask = getTask(task.id) || task;
    if (currentTask.status === 'cancelled') {
      console.log(`[Execution] Skipping cancelled task ${currentTask.id}`);
      return;
    }
    
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
  setAgentPhase('Forge', 'routing', {
    currentTaskId: task.id,
    currentTaskGoal: task.goal,
    note: 'Classifying request',
  });
  const heuristic = heuristicRouteTask(task.goal);
  if (heuristic) {
    saveMemory(task.id, 'thought', `Routing to ${heuristic} mode using local heuristic.`, null, 'episodic');
    clearAgentAssignment('Forge');
    return heuristic;
  }

  const systemPrompt = getSystemPrompt('router', { task });
  const response = await callLLM(systemPrompt, `Classify this request: ${task.goal}`);
  
  try {
    const classification = JSON.parse(cleanJsonResponse(response));
    console.log(`[Router] Decision: ${classification.mode} (${classification.reasoning})`);
    saveMemory(task.id, 'thought', `Routing to ${classification.mode} mode. Reasoning: ${classification.reasoning}`, null, 'episodic');
    clearAgentAssignment('Forge');
    return classification.mode;
  } catch (err) {
    const fallback = heuristicRouteTask(task.goal) ?? 'tool';
    console.error(`[Router] Failed to parse classification, defaulting to ${fallback}:`, err);
    saveMemory(task.id, 'error', `Router parse failed. Falling back to ${fallback} mode.`, null, 'working');
    clearAgentAssignment('Forge');
    return fallback;
  }
}

function unquoteShellPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractOverwriteCandidates(command: string): string[] {
  const candidates = new Set<string>();
  const redirectionPattern = /(^|[\s;|&])>\s*("[^"]+"|'[^']+'|\/workspace\/[^\s;|&]+)/gm;
  const teePattern = /\btee\s+("[^"]+"|'[^']+'|\/workspace\/[^\s;|&]+)/gm;

  for (const match of command.matchAll(redirectionPattern)) {
    const path = match[2];
    if (path) {
      candidates.add(unquoteShellPath(path));
    }
  }

  for (const match of command.matchAll(teePattern)) {
    const path = match[1];
    if (path) {
      candidates.add(unquoteShellPath(path));
    }
  }

  return [...candidates];
}

async function findExistingFileOverwriteTarget(command: string): Promise<string | null> {
  for (const candidate of extractOverwriteCandidates(command)) {
    if (await pathExistsInContainer(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function blockExistingFileOverwrite(
  taskId: string,
  subTaskId: string | null,
  command: string,
  conversationHistory: Message[],
): Promise<boolean> {
  const existingTarget = await findExistingFileOverwriteTarget(command);
  if (!existingTarget) {
    return false;
  }

  saveMemory(
    taskId,
    'security_alert',
    `Blocked shell overwrite of existing file: ${existingTarget} via ${command}`,
    subTaskId,
    'working',
  );
  conversationHistory.push({
    role: 'user',
    content:
      `That shell command would overwrite the existing file ${existingTarget}. ` +
      'Read the file first, then use str_replace_file or insert_at_line instead.',
  });
  return true;
}

async function runChatMode(task: Task) {
  updateTask(task.id, { status: 'running', startedAt: Date.now() });
  setAgentPhase('Forge', 'working', {
    currentTaskId: task.id,
    currentTaskGoal: task.goal,
    note: 'Responding in chat mode',
  });
  const systemPrompt = getSystemPrompt('chat', { task });
  const response = await callLLM(systemPrompt, task.goal, 'text/plain');
  if (isTaskCancelled(task.id)) {
    clearAgentAssignment('Forge');
    return;
  }
  
  saveMemory(task.id, 'output', response, null, 'working');
  updateTask(task.id, { status: 'done', completedAt: Date.now(), result: response });
  clearAgentAssignment('Forge');
  console.log(`[Chat] Response delivered.`);
}

async function runToolMode(task: Task) {
  updateTask(task.id, { status: 'running', startedAt: Date.now() });
  setAgentPhase('Forge', 'working', {
    currentTaskId: task.id,
    currentTaskGoal: task.goal,
    note: 'Executing linear tool task',
  });
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
    if (isTaskCancelled(task.id)) {
      clearAgentAssignment('Forge');
      return;
    }
    incrementTaskIterations(task.id);

    // Check for user input
    const newInputs = getMemoryForTask(task.id).filter(m => m.type === 'input' && m.createdAt > lastProcessedInputTime);
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
      saveMemory(task.id, 'error', `LLM error in tool mode: ${err.message}`, null, 'working');
      continue;
    }

    const { thought, toolCall } = response;

    if (thought) {
      saveMemory(task.id, 'thought', thought, null, 'working');
      console.log(`[Tool] Step ${i} thought: ${thought.slice(0, 120)}...`);
    }

    // Push assistant turn into history
    conversationHistory.push({ role: 'assistant', content: thought || `[tool: ${toolCall?.name}]` });

    if (!toolCall) {
      conversationHistory.push({ role: 'user', content: 'Please call one of your available tools to proceed. If the task is complete, call task_done.' });
      continue;
    }

    console.log(`[Tool] Tool call: ${toolCall.name}`, JSON.stringify(toolCall.args).slice(0, 100));

    // ── Dispatch tool calls ──────────────────────────────────────────────────

    if (toolCall.name === 'task_done') {
      const { summary } = toolCall.args;
      if (!isTaskCancelled(task.id)) {
        updateTask(task.id, { status: 'done', completedAt: Date.now(), result: summary || 'Task completed via Tool mode.' });
      }
      clearAgentAssignment('Forge');
      return;
    }

    if (toolCall.name === 'ask_user') {
      saveMemory(task.id, 'thought', `WAITING FOR USER: ${toolCall.args.question}`, null, 'working');
      lastProcessedInputTime = await waitForUserInput(task.id, null, lastProcessedInputTime);
      i--;
      continue;
    }

    if (toolCall.name === 'read_file') {
      const { path } = toolCall.args;
      saveMemory(task.id, 'command', `[read_file] ${path}`, null, 'working');
      const result = await readFileFromContainer(path);
      const output = result.stdout || '(empty file)';
      saveMemory(task.id, 'output', output.slice(0, 2000), null, 'working');
      conversationHistory.push({ role: 'user', content: `Contents of ${path}:\n${output}` });
      continue;
    }

    if (toolCall.name === 'str_replace_file') {
      const { file, old_str, new_str } = toolCall.args;
      saveMemory(task.id, 'command', `[str_replace] ${file}`, null, 'working');
      const result = await strReplaceInContainer(file, old_str, new_str);
      const output = (result.stdout + result.stderr) || '(no output)';
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, null, 'working');
      conversationHistory.push({ role: 'user', content: `str_replace result (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'insert_at_line') {
      const { file, line, text } = toolCall.args;
      saveMemory(task.id, 'command', `[insert_at_line] ${file}:${line}`, null, 'working');
      const result = await insertAtLineInContainer(file, line, text);
      const output = (result.stdout + result.stderr) || '(no output)';
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, null, 'working');
      conversationHistory.push({ role: 'user', content: `insert_at_line result (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'run_shell') {
      const { command } = toolCall.args;

      if (await blockExistingFileOverwrite(task.id, null, command, conversationHistory)) {
        continue;
      }

      // Security Audit
      const isSafe = await runSecurityAudit(task, command, { title: 'Tool Execution' } as any);
      if (!isSafe) {
        saveMemory(task.id, 'security_alert', `Blocked command: ${command}`, null, 'working');
        conversationHistory.push({ role: 'user', content: 'That command is blocked by the security policy. Please use a safer alternative.' });
        continue;
      }

      saveMemory(task.id, 'command', `$ ${command}`, null, 'working');
      const result = await execInContainer(command);
      const output = (result.stdout + result.stderr) || '(no output)';
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, null, 'working');
      conversationHistory.push({ role: 'user', content: `Command output (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    // Unknown tool
    conversationHistory.push({ role: 'user', content: `Unknown tool: ${toolCall.name}. Available tools: run_shell, read_file, str_replace_file, insert_at_line, ask_user, task_done.` });
  }

  if (!isTaskCancelled(task.id)) {
    updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: 'Max iterations reached in Tool mode' });
  }
  clearAgentAssignment('Forge');
}

export async function runOrchestrator(task: Task): Promise<void> {
  try {
    console.log(`\n[Orchestrator] Starting: ${task.goal}`);
    updateTask(task.id, { status: 'running', startedAt: Date.now() });
    saveMemory(task.id, 'thought', `Starting orchestrated goal: ${task.goal}`, null, 'episodic');
    setAgentPhase('Forge', 'planning', {
      currentTaskId: task.id,
      currentTaskGoal: task.goal,
      note: 'Planning with Atlas',
    });

    await ensureWorkspaceReady();

    // 1. Planning Phase
    await planTask(task);

    // 2. Execution Loop
    let completed = false;
    const activeSubTasks = new Set<string>();

    while (!completed) {
      if (isTaskCancelled(task.id)) {
        return;
      }
      incrementTaskIterations(task.id);
      const subTasks = getSubTasksForTask(task.id);
      const unblocked = subTasks.filter(st =>
        ['pending', 'blocked'].includes(st.status) &&
        !activeSubTasks.has(st.id) &&
        st.dependencies.every(depId => {
          const dep = subTasks.find(s => s.id === depId);
          return dep && dep.status === 'done';
        }) &&
        hasRequiredArtifacts(task, st)
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
        const requestedLocks = subTask.lockedPaths.length > 0 ? subTask.lockedPaths : subTask.workspaceScope;
        const lockResult = tryAcquireWorkspaceLocks(subTask.id, requestedLocks);
        if (!lockResult.ok) {
          updateSubTask(subTask.id, {
            status: 'blocked',
            error: `Waiting for workspace locks: ${lockResult.conflicts.join(', ')}`,
          });
          continue;
        }

        if (subTask.status === 'blocked') {
          updateSubTask(subTask.id, { status: 'pending', error: undefined });
        }

        activeSubTasks.add(subTask.id);
        setAgentPhase('Forge', 'delegating', {
          currentTaskId: task.id,
          currentTaskGoal: task.goal,
          currentSubTaskId: subTask.id,
          currentSubTaskTitle: subTask.title,
          note: `Delegating ${subTask.title} to ${getSubTaskAgentId(subTask)}`,
        });
        emitDelegationEvent('start', {
          from: 'Forge',
          to: getSubTaskAgentId(subTask),
          taskId: task.id,
          taskGoal: task.goal,
          subTaskId: subTask.id,
          subTaskTitle: subTask.title,
          note: subTask.description,
        });
        console.log(`[Orchestrator] Dispatching Worker for: ${subTask.title}`);
        dispatchWorker(task, subTask).catch(err => {
          console.error(`[Orchestrator] Worker failed for ${subTask.title}:`, err);
        }).finally(() => {
          activeSubTasks.delete(subTask.id);
          releaseWorkspaceLocks(subTask.id);
        });
      }

      // Wait a bit before checking status again
      await sleep(2000);
    }

    console.log(`\n[Orchestrator] Goal achieved: ${task.goal}`);
    const completedSubTasks = getSubTasksForTask(task.id).filter((subTask) => subTask.status === 'done');
    const artifactNames = getArtifactsForTask(task.id).map((artifact) => artifact.name);
    const result = [
      'Goal completed successfully.',
      completedSubTasks.length > 0 ? `Completed subtasks: ${completedSubTasks.map((subTask) => subTask.title).join(', ')}` : '',
      artifactNames.length > 0 ? `Artifacts: ${artifactNames.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    updateTask(task.id, { status: 'done', completedAt: Date.now(), result });
    clearAgentAssignment('Forge');
  } catch (err: any) {
    if (err.message === 'Task cancelled by user' || isTaskCancelled(task.id)) {
      return;
    }
    console.error('[Orchestrator] Fatal error:', err);
    updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: err.message || 'Fatal orchestrator error' });
    saveMemory(task.id, 'error', `Fatal orchestrator error: ${err.message || err}`, null, 'working');
    clearAgentAssignment('Forge');
  }
}

async function dispatchWorker(task: Task, subTask: SubTask) {
  const assignedAgent = getSubTaskAgentId(subTask);
  if (isTaskCancelled(task.id) || isSubTaskCancelled(subTask.id)) {
    emitDelegationEvent('complete', {
      from: 'Forge',
      to: assignedAgent,
      taskId: task.id,
      taskGoal: task.goal,
      subTaskId: subTask.id,
      subTaskTitle: subTask.title,
      note: 'Cancelled before execution',
    });
    return;
  }
  console.log(`\n[Orchestrator] Dispatching Worker for: ${subTask.title}`);
  await runWorkerAgent(task, subTask);
  
  // Verification Phase
  const updatedSubTask = getSubTask(subTask.id);
  if (isTaskCancelled(task.id) || isSubTaskCancelled(subTask.id)) {
    emitDelegationEvent('complete', {
      from: 'Forge',
      to: assignedAgent,
      taskId: task.id,
      taskGoal: task.goal,
      subTaskId: subTask.id,
      subTaskTitle: subTask.title,
      note: 'Cancelled during execution',
    });
    return;
  }
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

  emitDelegationEvent('complete', {
    from: 'Forge',
    to: assignedAgent,
    taskId: task.id,
    taskGoal: task.goal,
    subTaskId: subTask.id,
    subTaskTitle: subTask.title,
    note: getSubTask(subTask.id)?.status ?? 'unknown',
  });
  clearAgentAssignment(assignedAgent);
}

async function planTask(task: Task) {
  console.log('[Planner] Decomposing goal...');
  setAgentPhase('Atlas', 'planning', {
    currentTaskId: task.id,
    currentTaskGoal: task.goal,
    note: 'Generating initial DAG',
  });
  const systemPrompt = getSystemPrompt('planner', { task });
  const response = await callLLM(systemPrompt, `Plan the execution for: ${task.goal}`);
  
  try {
    const plan = JSON.parse(cleanJsonResponse(response));
    updateTask(task.id, { 
      globalContext: plan.globalContext,
      successCriteria: plan.successCriteria
    });

    const subTaskSummary = plan.subTasks.map((st: any) => `- ${st.title}: ${st.description}`).join('\n');
    saveMemory(task.id, 'thought', `Execution plan:\n${subTaskSummary}\n\nExecution starts automatically. You can send feedback while the task runs.`, null, 'episodic');

    const createdSubTasks: SubTask[] = plan.subTasks.map((st: any) =>
      createSubTask({
        taskId: task.id,
        title: st.title,
        description: st.description,
        type: st.type,
        dependencies: [],
        priority: st.priority || 0,
        assignedAgent: st.assignedAgent || resolveAssignedAgent(st),
        inputArtifacts: st.inputArtifacts || [],
        outputArtifacts: st.outputArtifacts || [],
        successCriteria: st.successCriteria || [],
        workspaceScope: st.workspaceScope || [],
        lockedPaths: st.lockedPaths || [],
      }),
    );
    const titleToId = new Map<string, string>(
      createdSubTasks.map((createdSubTask: SubTask) => [createdSubTask.title, createdSubTask.id]),
    );
    plan.subTasks.forEach((st: any, index: number) => {
      updateSubTask(createdSubTasks[index].id, {
        dependencies: dependencyIdsFromTitles(st.dependencies || [], titleToId),
      });
    });
    if (!plan.subTasks?.length) {
      throw new Error('Planner returned no subtasks.');
    }
    saveMemory(task.id, 'thought', `Planner generated ${plan.subTasks.length} subtasks.`, null, 'episodic');
    clearAgentAssignment('Atlas');
  } catch (err) {
    console.error('[Planner] Failed to parse plan:', err);
    saveMemory(task.id, 'error', `Planner failed: ${response}`, null, 'working');
    clearAgentAssignment('Atlas');
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
    description: 'Surgically edit an existing file by replacing a unique block of text. Never rewrites the whole file. Use this for ALL edits to existing files. old_str must appear exactly once in the file - include enough surrounding lines to make it unique.',
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
    name: 'insert_at_line',
    description: 'Insert new text at a specific 1-based line number in an existing file. Use this for focused additions like imports or a new statement inside a file without rewriting the whole file.',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Absolute path to the file inside the container'
        },
        line: {
          type: 'number',
          description: '1-based line number to insert before'
        },
        text: {
          type: 'string',
          description: 'The text to insert'
        }
      },
      required: ['file', 'line', 'text']
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
  const assignedAgent = getSubTaskAgentId(subTask);
  updateSubTask(subTask.id, {
    status: 'running',
    startedAt: Date.now(),
    assignedAgent,
    error: undefined,
  });
  setAgentPhase(assignedAgent, 'working', {
    currentTaskId: task.id,
    currentTaskGoal: task.goal,
    currentSubTaskId: subTask.id,
    currentSubTaskTitle: subTask.title,
    note: subTask.description,
  });
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
    if (isTaskCancelled(task.id) || isSubTaskCancelled(subTask.id)) {
      clearAgentAssignment(assignedAgent);
      return;
    }
    incrementTaskIterations(task.id);

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
      if (!isTaskCancelled(task.id) && !isSubTaskCancelled(subTask.id)) {
        updateSubTask(subTask.id, { status: 'done', completedAt: Date.now(), result: summary });
      }
      return;
    }

    if (toolCall.name === 'ask_user') {
      saveMemory(task.id, 'thought', `[${subTask.title}] WAITING FOR USER: ${toolCall.args.question}`, subTask.id, 'working');
      updateSubTask(subTask.id, { status: 'waiting_for_human' });
      setAgentPhase(assignedAgent, 'blocked', {
        currentTaskId: task.id,
        currentTaskGoal: task.goal,
        currentSubTaskId: subTask.id,
        currentSubTaskTitle: subTask.title,
        note: toolCall.args.question,
      });
      lastProcessedInputTime = await waitForUserInput(task.id, subTask.id, lastProcessedInputTime);
      updateSubTask(subTask.id, { status: 'running' });
      setAgentPhase(assignedAgent, 'working', {
        currentTaskId: task.id,
        currentTaskGoal: task.goal,
        currentSubTaskId: subTask.id,
        currentSubTaskTitle: subTask.title,
        note: subTask.description,
      });
      i--;
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

    if (toolCall.name === 'insert_at_line') {
      const { file, line, text } = toolCall.args;
      saveMemory(task.id, 'command', `[insert_at_line] ${file}:${line}`, subTask.id, 'working');
      const result = await insertAtLineInContainer(file, line, text);
      const output = (result.stdout + result.stderr) || '(no output)';
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `insert_at_line result (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'run_shell') {
      const { command } = toolCall.args;

      if (await blockExistingFileOverwrite(task.id, subTask.id, command, conversationHistory)) {
        continue;
      }

      // Static blocklist - runs before LLM security audit
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

    // Unknown tool - tell the model
    conversationHistory.push({ role: 'user', content: `Unknown tool: ${toolCall.name}. Available tools: run_shell, read_file, str_replace_file, insert_at_line, ask_user, task_done.` });
  }

  if (!isTaskCancelled(task.id) && !isSubTaskCancelled(subTask.id)) {
    updateSubTask(subTask.id, { status: 'failed', completedAt: Date.now(), error: 'Max iterations reached' });
  }
  clearAgentAssignment(assignedAgent);
}

async function runSecurityAudit(task: Task, command: string, subTask: SubTask): Promise<boolean> {
  if (isTaskCancelled(task.id)) {
    return false;
  }
  setAgentPhase('Sentry', 'working', {
    currentTaskId: task.id,
    currentTaskGoal: task.goal,
    currentSubTaskId: subTask.id,
    currentSubTaskTitle: subTask.title,
    note: `Auditing command: ${command.slice(0, 120)}`,
  });
  const systemPrompt = getSystemPrompt('security', { task, subTask });
  const response = await callLLM(systemPrompt, `Proposed Command: ${command}`);
  
  try {
    const audit = JSON.parse(cleanJsonResponse(response));
    clearAgentAssignment('Sentry');
    return !!audit.safe;
  } catch {
    clearAgentAssignment('Sentry');
    return false; // Default to unsafe on error
  }
}

async function verifySubTask(task: Task, subTask: SubTask): Promise<boolean> {
  if (isTaskCancelled(task.id) || isSubTaskCancelled(subTask.id)) {
    return false;
  }
  console.log(`[Verifier] Validating: ${subTask.title}`);
  setAgentPhase('Crucible', 'verifying', {
    currentTaskId: task.id,
    currentTaskGoal: task.goal,
    currentSubTaskId: subTask.id,
    currentSubTaskTitle: subTask.title,
    note: 'Running verification checks',
  });
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
  saveMemory(
    task.id,
    'thought',
    `[Verifier] ${subTask.title}: ${passed ? 'PASSED' : 'FAILED'}\n${result.thought || ''}`,
    subTask.id,
    'working',
    result.metrics || undefined,
  );
  
  if (!passed) {
    updateSubTask(subTask.id, { status: 'failed', error: result.feedback || 'Verification failed' });
  }
  clearAgentAssignment('Crucible');
  return passed;
}

async function runCriticLoop(task: Task, subTask: SubTask): Promise<boolean> {
  if (isTaskCancelled(task.id) || isSubTaskCancelled(subTask.id)) {
    return false;
  }
  console.log(`[Critic] Reviewing: ${subTask.title}`);
  setAgentPhase('Crucible', 'critiquing', {
    currentTaskId: task.id,
    currentTaskGoal: task.goal,
    currentSubTaskId: subTask.id,
    currentSubTaskTitle: subTask.title,
    note: 'Reviewing implementation quality',
  });
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
  saveMemory(
    task.id,
    'critique',
    `[Critic] Score: ${result.score}/10 - ${passed ? 'PASSED' : 'FAILED'}\n${result.feedback || ''}`,
    subTask.id,
    'episodic',
    result.metrics || undefined,
  );
  
  if (!passed) {
    updateSubTask(subTask.id, { status: 'failed', critique: result.feedback || 'Critique failed' });
  } else {
    updateSubTask(subTask.id, { status: 'done' });
  }
  clearAgentAssignment('Crucible');
  return passed;
}

async function handleSubTaskFailure(task: Task, subTask: SubTask, phase: string) {
  if (isTaskCancelled(task.id) || isSubTaskCancelled(subTask.id)) {
    return;
  }
  console.log(`[Reflection] Analyzing ${phase} failure for: ${subTask.title}`);
  setAgentPhase('Echo', 'reflecting', {
    currentTaskId: task.id,
    currentTaskGoal: task.goal,
    currentSubTaskId: subTask.id,
    currentSubTaskTitle: subTask.title,
    note: `Analyzing ${phase} failure`,
  });
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
  clearAgentAssignment('Echo');
}

async function reflectAndReplan(task: Task) {
  if (isTaskCancelled(task.id)) {
    return;
  }
  console.log('[Orchestrator] Replanning...');
  setAgentPhase('Atlas', 'planning', {
    currentTaskId: task.id,
    currentTaskGoal: task.goal,
    note: 'Replanning blocked DAG',
  });
  const subTasks = getSubTasksForTask(task.id);
  const artifacts = getArtifactsForTask(task.id);
  const systemPrompt = getSystemPrompt('planner', { task, allSubTasks: subTasks, artifacts });
  
  const response = await callLLM(systemPrompt, "The current DAG is stuck or failed. Please update the DAG to resolve the issues.");
  saveMemory(task.id, 'thought', `Planner replan response: ${response}`, null, 'episodic');
  
  try {
    const plan = JSON.parse(cleanJsonResponse(response));
    const newSubTasks = plan.subTasks.filter((st: any) => !subTasks.find((existing) => existing.title === st.title));
    const created: SubTask[] = newSubTasks.map((st: any) =>
      createSubTask({
          taskId: task.id,
          title: st.title,
          description: st.description,
          type: st.type,
          dependencies: [],
          priority: st.priority || 0,
          assignedAgent: st.assignedAgent || resolveAssignedAgent(st),
          inputArtifacts: st.inputArtifacts || [],
          outputArtifacts: st.outputArtifacts || [],
          successCriteria: st.successCriteria || [],
          workspaceScope: st.workspaceScope || [],
          lockedPaths: st.lockedPaths || [],
        }),
    );
    const titleToId = new Map<string, string>(
      [...subTasks, ...created].map((createdSubTask: SubTask) => [createdSubTask.title, createdSubTask.id]),
    );
    for (let index = 0; index < newSubTasks.length; index++) {
      updateSubTask(created[index].id, {
        dependencies: dependencyIdsFromTitles(newSubTasks[index].dependencies || [], titleToId),
      });
    }
    clearAgentAssignment('Atlas');
  } catch (err) {
    console.error('[Orchestrator] Replanning failed to parse:', err);
    clearAgentAssignment('Atlas');
  }
}

function cleanJsonResponse(raw: string): string {
  return raw
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
}

