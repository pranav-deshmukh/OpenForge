import { callLLM } from './agent.js';
import { ensureWorkspaceReady, execInContainer } from './shell.js';
import { buildSkillCatalog, discoverSkills } from './skills.js';
import { saveMemory, updateTask, getAllTasks, getMemoryForTask } from './memory.js';
import type { Message, Task } from './types.js';

function buildSystemPrompt(skillCatalog: string, pastContext: string): string {
  return `You are an autonomous, PhD-level AI researcher and software engineer.
You operate continuously to solve complex problems, build software, and conduct research.
You do NOT just execute simple commands. You think and act like a human researcher:
1. You search the internet and literature for information.
2. You read documentation, papers, and code.
3. You design architectures and write implementation code.
4. You CREATE TESTS for your code, run them, and evaluate the results empirically.
5. You iterate, debug, and refine until the results are completely satisfactory.

Today's date and time is: ${new Date().toISOString()}

## Your Environment
You are running inside a persistent Linux container with FULL root shell access.
You can install any tools (apt, pip, npm), start servers, create files, and write scripts.

## Memory & Knowledge (CRITICAL)
You have a persistent directory at \`/workspace/\`. 
You MUST manage your own long-term memory like a human would:
- Create a \`/workspace/knowledge/\` directory to store your research notes, architecture designs, and learned facts.
- Create a \`/workspace/journal/\` directory to log your daily progress and thoughts (e.g., "What I did on May 6th").
- Before starting a complex task, read your past journals and knowledge files to recall what you already know.
- You are expected to search your own \`/workspace/\` using \`grep\` or \`find\` to recall past information.

${pastContext}

## Pre-installed Skills
You have access to some helper scripts. Read them before using:
${skillCatalog}

## How you operate
At each iteration, you decide on ONE shell command to advance your goal. 
Respond ONLY in this exact JSON format:

{
  "thought": "Analyze your previous output, reflect on the goal, consult your memory/plans, and explain what you will do next.",
  "command": "The exact shell command to execute.",
  "done": false
}

If you need clarification from the user, you can set the command to "ask_user" and explain your question in the thought. The loop will then pause and wait for the user to provide input via the dashboard.

When you have EXHAUSTIVELY tested your solution and are 100% satisfied with the results:
{
  "thought": "Final reflection on the completed goal.",
  "command": "",
  "done": true,
  "summary": "A detailed summary of what was built, where it is located, what knowledge was saved, and how it was tested."
}

## Rules
- NEVER give up. If an approach fails, diagnose why, read the errors, and try a new approach.
- ALWAYS write tests to verify your code. Do not assume your code works.
- Think long-term. Build robust, well-documented solutions.
- Run ONE command per iteration. Wait for the output.`;
}

export async function runAutonomousLoop(task: Task): Promise<void> {
  console.log(`\n[Loop] Starting: ${task.goal}`);
  updateTask(task.id, { status: 'running', startedAt: Date.now() });
  saveMemory(task.id, 'thought', `Starting goal: ${task.goal}`);

  await ensureWorkspaceReady();

  const skills = discoverSkills('./skills');
  const skillCatalog = buildSkillCatalog(skills);
  console.log(`[Loop] Loaded ${skills.length} skills`);

  // Build past context from previous tasks
  const pastTasks = getAllTasks()
    .filter(t => t.status === 'done' && t.id !== task.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5);
    
  let pastContext = '';
  if (pastTasks.length > 0) {
    pastContext = '## Recent Past Tasks (Context)\n' + pastTasks.map(t => 
      `- [${new Date(t.createdAt).toISOString()}] Goal: ${t.goal}\n  Result: ${t.result}`
    ).join('\n');
  }

  const systemPrompt = buildSystemPrompt(skillCatalog, pastContext);
  const maxIterations = 200; // Significantly increased for deep autonomy
  const conversationHistory: Message[] = [];
  let lastProcessedInputTime = Date.now();

  conversationHistory.push({
    role: 'user',
    content: `Goal: ${task.goal}\n\nStart working on this. Set up your knowledge/journal directories if needed, plan your approach, and give me your first command.`,
  });

  for (let i = 1; i <= maxIterations; i++) {
    // Check for new user input before calling LLM
    const newInputs = getMemoryForTask(task.id).filter(m => m.type === 'input' && m.createdAt > lastProcessedInputTime);
    if (newInputs.length > 0) {
      console.log(`[Loop] Received ${newInputs.length} new user inputs`);
      for (const input of newInputs) {
        conversationHistory.push({
          role: 'user',
          content: `USER INPUT: ${input.content}`,
        });
        if (input.createdAt > lastProcessedInputTime) lastProcessedInputTime = input.createdAt;
      }
    }

    console.log(`\n[Loop] Iteration ${i}/${maxIterations}`);
    updateTask(task.id, { iterations: i });

    let raw: string;
    try {
      raw = await callLLM(systemPrompt, conversationHistory);
    } catch (err: any) {
      console.error('[Loop] LLM error:', err.message);
      saveMemory(task.id, 'error', `LLM error: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    let decision: {
      thought: string;
      command?: string;
      done: boolean;
      summary?: string;
    };

    try {
      const cleaned = raw
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();

      decision = JSON.parse(cleaned);
    } catch {
      console.error('[Loop] Parse error, raw:', raw.slice(0, 200));
      saveMemory(task.id, 'error', `Parse error: ${raw.slice(0, 300)}`);
      conversationHistory.push({ role: 'assistant', content: raw });
      conversationHistory.push({
        role: 'user',
        content: 'Your response was not valid JSON. Respond ONLY with valid JSON in the exact format specified.',
      });
      continue;
    }

    console.log(`[Loop] Thought: ${decision.thought}`);
    saveMemory(task.id, 'thought', `Iteration ${i}: ${decision.thought}`);

    if (decision.done) {
      const summary = decision.summary || 'Goal completed.';
      console.log(`\n[Loop] Goal achieved in ${i} iterations`);
      saveMemory(task.id, 'summary', summary);
      updateTask(task.id, {
        status: 'done',
        completedAt: Date.now(),
        result: summary,
        iterations: i,
      });
      return;
    }

    const command = decision.command?.trim();
    
    // Handle ask_user specifically
    if (command === 'ask_user') {
      console.log('[Loop] Agent is waiting for user input...');
      saveMemory(task.id, 'thought', `WAITING FOR USER: ${decision.thought}`);
      
      // Wait for new input
      let waiting = true;
      while (waiting) {
        await new Promise(r => setTimeout(r, 5000));
        const checkInputs = getMemoryForTask(task.id).filter(m => m.type === 'input' && m.createdAt > lastProcessedInputTime);
        if (checkInputs.length > 0) {
          waiting = false;
          // Inputs will be picked up at the start of next iteration
          i--; // Don't count the waiting as an iteration
          break;
        }
      }
      continue;
    }

    if (!command) {
      conversationHistory.push({ role: 'assistant', content: raw });
      conversationHistory.push({
        role: 'user',
        content: 'No command provided. What command do you want to run?',
      });
      continue;
    }

    console.log(`[Loop] $ ${command}`);
    saveMemory(task.id, 'code', `$ ${command}`);

    const result = await execInContainer(command, 120000);
    const output = [
      result.stdout && `STDOUT:\n${result.stdout}`,
      result.stderr && `STDERR:\n${result.stderr}`,
    ]
      .filter(Boolean)
      .join('\n') || '(no output)';

    console.log(`[Loop] Exit: ${result.exitCode}`);
    if (result.stdout) console.log(`[Loop] Out: ${result.stdout.slice(0, 200)}`);
    if (result.stderr) console.log(`[Loop] Err: ${result.stderr.slice(0, 200)}`);

    saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`);

    conversationHistory.push({ role: 'assistant', content: raw });
    conversationHistory.push({
      role: 'user',
      content: `Command output (exit ${result.exitCode}):\n${output}\n\nWhat is your next command?`,
    });

    // Keep memory bounded but large enough for context
    if (conversationHistory.length > 50) {
      // Remove oldest turns, but keep the initial goal instruction
      conversationHistory.splice(1, 2);
    }
  }

  const message = `Hit max iterations (${maxIterations})`;
  console.log(`[Loop] ${message}`);
  saveMemory(task.id, 'error', message);
  updateTask(task.id, {
    status: 'failed',
    completedAt: Date.now(),
    error: message,
    iterations: maxIterations,
  });
}
