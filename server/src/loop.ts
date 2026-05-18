import { callLLM } from './agent.js';
import { ensureWorkspaceReady, execInContainer } from './shell.js';
import { buildSkillCatalog, discoverSkills } from './skills.js';
import { 
  saveMemory, updateTask, getTask, getMemoryForTask, 
  createSubTask, updateSubTask, getSubTasksForTask, getSubTask,
  createArtifact, getArtifactsForTask, createReflection,
  getMemoryForSubTask
} from './memory.js';
import { getSystemPrompt } from './prompts.js';
import type { Message, Task, SubTask, Artifact, AgentPersona, LoopState } from './types.js';

const MAX_ITERATIONS_PER_SUBTASK = 50;
const MAX_SUBTASK_RETRIES = 3;

export async function runAutonomousLoop(task: Task): Promise<void> {
  await runOrchestrator(task);
}

export async function runOrchestrator(task: Task): Promise<void> {
  console.log(`\n[Orchestrator] Starting: ${task.goal}`);
  updateTask(task.id, { status: 'running', startedAt: Date.now() });
  saveMemory(task.id, 'thought', `Starting orchestrated goal: ${task.goal}`);

  await ensureWorkspaceReady();

  // 1. Planning Phase
  await planTask(task);

  // 2. Execution Loop
  let completed = false;
  while (!completed) {
    const subTasks = getSubTasksForTask(task.id);
    const unblocked = subTasks.filter(st => 
      st.status === 'pending' && 
      st.dependencies.every(depTitle => {
        const dep = subTasks.find(s => s.title === depTitle);
        return dep && dep.status === 'done';
      })
    );

    if (unblocked.length === 0) {
      if (subTasks.every(st => st.status === 'done')) {
        completed = true;
        break;
      }
      if (subTasks.some(st => st.status === 'failed' && st.retryCount >= MAX_SUBTASK_RETRIES)) {
        console.error('[Orchestrator] Task failed: Some subtasks failed permanently.');
        updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: 'Some subtasks failed permanently.' });
        return;
      }
      // Check for blocked status
      if (subTasks.some(st => st.status === 'blocked')) {
        console.log('[Orchestrator] Some tasks are blocked. Waiting for manual resolution or mutation.');
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      
      console.log('[Orchestrator] No unblocked tasks and not all done. Checking for replanning...');
      await reflectAndReplan(task);
      continue;
    }

    // Execute unblocked subtasks sequentially for now
    for (const subTask of unblocked) {
      console.log(`\n[Orchestrator] Dispatching Worker for: ${subTask.title}`);
      await runWorkerAgent(task, subTask);
      
      // Verification Phase
      const updatedSubTask = getSubTask(subTask.id);
      if (updatedSubTask && updatedSubTask.status === 'done') {
        const passed = await verifySubTask(task, updatedSubTask);
        if (!passed) {
          console.log(`[Orchestrator] Verification failed for: ${subTask.title}`);
          await handleSubTaskFailure(task, updatedSubTask);
        }
      } else if (updatedSubTask && updatedSubTask.status === 'failed') {
        await handleSubTaskFailure(task, updatedSubTask);
      }
    }
  }

  console.log(`\n[Orchestrator] Goal achieved: ${task.goal}`);
  updateTask(task.id, { status: 'done', completedAt: Date.now(), result: 'Goal completed successfully via DAG execution.' });
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
    saveMemory(task.id, 'thought', `I have generated an execution plan:\n${subTaskSummary}\n\nPlease review and reply 'approve' to proceed, or provide feedback to replan.`);
    
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
          saveMemory(task.id, 'thought', 'Plan approved. Starting execution...');
        } else {
          // Re-planning with feedback
          saveMemory(task.id, 'thought', `Feedback received: "${lastInput}". Re-planning...`);
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
    saveMemory(task.id, 'thought', `Planner generated ${plan.subTasks.length} subtasks.`);
  } catch (err) {
    console.error('[Planner] Failed to parse plan:', err);
    saveMemory(task.id, 'error', `Planner failed: ${response}`);
    throw err;
  }
}

async function runWorkerAgent(task: Task, subTask: SubTask) {
  updateSubTask(subTask.id, { status: 'running', startedAt: Date.now() });
  saveMemory(task.id, 'thought', `Worker starting subtask: ${subTask.title}`, subTask.id);

  const skills = discoverSkills('./skills');
  const skillCatalog = buildSkillCatalog(skills);
  const artifacts = getArtifactsForTask(task.id);
  const systemPrompt = getSystemPrompt('worker', { task, subTask, artifacts });

  const conversationHistory: Message[] = [
    { role: 'user', content: `Start working on SubTask: ${subTask.title}\nDescription: ${subTask.description}` }
  ];

  let lastProcessedInputTime = Date.now();

  for (let i = 1; i <= MAX_ITERATIONS_PER_SUBTASK; i++) {
    // Check for user input
    const newInputs = getMemoryForSubTask(subTask.id).filter(m => m.type === 'input' && m.createdAt > lastProcessedInputTime);
    for (const input of newInputs) {
      conversationHistory.push({ role: 'user', content: `USER INPUT: ${input.content}` });
      lastProcessedInputTime = Math.max(lastProcessedInputTime, input.createdAt);
    }

    let raw: string;
    try {
      raw = await callLLM(systemPrompt, conversationHistory);
    } catch (err: any) {
      saveMemory(task.id, 'error', `LLM error in worker: ${err.message}`, subTask.id);
      continue;
    }

    let decision: any;
    try {
      decision = JSON.parse(cleanJsonResponse(raw));
    } catch {
      conversationHistory.push({ role: 'assistant', content: raw });
      conversationHistory.push({ role: 'user', content: 'Invalid JSON. Use format: {"thought": "...", "command": "...", "done": false}' });
      continue;
    }

    saveMemory(task.id, 'thought', `[${subTask.title}] ${decision.thought}`, subTask.id);

    if (decision.done) {
      // Worker claims they are done. Verifier will confirm.
      // Workers should specify artifacts produced
      if (decision.artifacts) {
        for (const art of decision.artifacts) {
          createArtifact({
            taskId: task.id,
            name: art.name,
            type: art.type || 'unknown',
            content: art.content || '',
            producerSubTaskId: subTask.id
          });
        }
      }
      updateSubTask(subTask.id, { status: 'done', completedAt: Date.now(), result: decision.summary });
      return;
    }

    const command = decision.command?.trim();
    if (command === 'ask_user') {
      saveMemory(task.id, 'thought', `[${subTask.title}] WAITING FOR USER: ${decision.thought}`, subTask.id);
      let waiting = true;
      while (waiting) {
        await new Promise(r => setTimeout(r, 5000));
        const checkInputs = getMemoryForSubTask(subTask.id).filter(m => m.type === 'input' && m.createdAt > lastProcessedInputTime);
        if (checkInputs.length > 0) {
          waiting = false;
          i--;
          break;
        }
      }
      continue;
    }

    if (command) {
      saveMemory(task.id, 'command', `$ ${command}`, subTask.id);
      const result = await execInContainer(command, 600000); // 10 minute timeout
      const output = (result.stdout + result.stderr) || '(no output)';
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask.id);

      conversationHistory.push({ role: 'assistant', content: raw });
      conversationHistory.push({ role: 'user', content: `Command output (exit ${result.exitCode}):\n${output}` });
    }
  }

  updateSubTask(subTask.id, { status: 'failed', completedAt: Date.now(), error: 'Max iterations reached' });
}

async function verifySubTask(task: Task, subTask: SubTask): Promise<boolean> {
  console.log(`[Verifier] Validating: ${subTask.title}`);
  const systemPrompt = getSystemPrompt('verifier', { task, subTask });
  const response = await callLLM(systemPrompt, `Verify the completion of: ${subTask.title}\nResult: ${subTask.result}`);
  
  let result: any;
  try {
    result = JSON.parse(cleanJsonResponse(response));
  } catch {
    saveMemory(task.id, 'error', `Verifier failed to output JSON: ${response}`, subTask.id);
    return false;
  }

  const passed = !!result.passed;
  saveMemory(task.id, 'thought', `[Verifier] ${subTask.title}: ${passed ? 'PASSED' : 'FAILED'}\n${result.thought || ''}`, subTask.id);
  
  if (!passed) {
    updateSubTask(subTask.id, { status: 'failed', error: result.feedback || 'Verification failed' });
  }
  return passed;
}

async function handleSubTaskFailure(task: Task, subTask: SubTask) {
  console.log(`[Reflection] Analyzing failure for: ${subTask.title}`);
  const systemPrompt = getSystemPrompt('reflection', { task, subTask });
  const response = await callLLM(systemPrompt, `Analyze why ${subTask.title} failed.`);
  
  let result: any;
  try {
    result = JSON.parse(cleanJsonResponse(response));
  } catch {
    saveMemory(task.id, 'error', `Reflection failed to output JSON: ${response}`, subTask.id);
    return;
  }

  createReflection(subTask.id, result.thought || response);
  saveMemory(task.id, 'thought', `[Reflection] ${subTask.title} analysis: ${result.thought || ''}`, subTask.id);

  if (subTask.retryCount < MAX_SUBTASK_RETRIES) {
    updateSubTask(subTask.id, { 
      status: 'retrying', 
      retryCount: subTask.retryCount + 1 
    });
    // Reset status to pending for executor to pick up again
    updateSubTask(subTask.id, { status: 'pending' });
  } else {
    updateSubTask(subTask.id, { status: 'failed' });
    // This will trigger replanning in the main orchestrator loop
  }
}

async function reflectAndReplan(task: Task) {
  console.log('[Orchestrator] Replanning...');
  // This would involve calling the planner with current subtasks and reflections
  const subTasks = getSubTasksForTask(task.id);
  const artifacts = getArtifactsForTask(task.id);
  const systemPrompt = getSystemPrompt('planner', { task, allSubTasks: subTasks, artifacts });
  
  const response = await callLLM(systemPrompt, "The current DAG is stuck or failed. Please update the DAG to resolve the issues.");
  // Implementation of DAG mutation (adding/updating subtasks) goes here
  // For now, let's just log it.
  saveMemory(task.id, 'thought', `Planner replan response: ${response}`);
  
  try {
    const plan = JSON.parse(cleanJsonResponse(response));
    // Merge or replace subtasks... (Simplified for now)
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

