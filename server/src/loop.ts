import { callLLM } from './agent.js';
import { ensureWorkspaceReady, execInContainer } from './shell.js';
import { buildSkillCatalog, discoverSkills } from './skills.js';
import { saveMemory, updateTask } from './memory.js';
import type { Message, Task } from './types.js';

function buildSystemPrompt(skillCatalog: string): string {
  return `You are an autonomous PhD-level AI agent running inside a Linux container.
You have FULL shell access to the container. You can install anything, run anything, create files, and start servers.

## Your available skills

${skillCatalog}

## How to use skills

When you need a skill, read it first:
cat /skills/<skill-name>/SKILL.md
Then follow its instructions exactly.

## How you work

At each iteration you decide ONE shell command to run next.
You respond in this exact JSON format only:

{
  "thought": "what you're thinking and why",
  "command": "the exact shell command to run",
  "done": false
}

When the goal is fully complete:
{
  "thought": "goal is complete because...",
  "command": "",
  "done": true,
  "summary": "what was achieved and where files are"
}

## Rules

- Run ONE command per iteration
- Read a skill before using it
- Install packages if needed (apt-get, pip, npm)
- Write files to /workspace/
- If a command fails, read the error and fix it
- Keep going until the goal is truly done
- You can start servers, they will keep running
- NEVER give up`;
}

export async function runAutonomousLoop(task: Task): Promise<void> {
  console.log(`\n[Loop] Starting: ${task.goal}`);
  updateTask(task.id, { status: 'running', startedAt: Date.now() });
  saveMemory(task.id, 'thought', `Starting goal: ${task.goal}`);

  await ensureWorkspaceReady();

  const skills = discoverSkills('./skills');
  const skillCatalog = buildSkillCatalog(skills);
  console.log(`[Loop] Loaded ${skills.length} skills`);

  const systemPrompt = buildSystemPrompt(skillCatalog);
  const maxIterations = 30;
  const conversationHistory: Message[] = [];

  conversationHistory.push({
    role: 'user',
    content: `Goal: ${task.goal}\n\nStart working on this. What is your first command?`,
  });

  for (let i = 1; i <= maxIterations; i++) {
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

    if (conversationHistory.length > 40) {
      conversationHistory.splice(0, 2);
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
