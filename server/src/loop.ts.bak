import { callLLM, callLLMWithTools } from './agent.js';
import type { ToolDefinition } from './agent.js';
import {
  ensureWorkspaceReady,
  execInContainer,
  strReplaceInContainer,
  deleteBlockInContainer,
  readFileFromContainer,
  listFilesInContainer,
  searchCodeInContainer,
  getRepoStatusInContainer,
  insertAtLineInContainer,
  pathExistsInContainer,
  getPreinstalledPackages,
  syncRuntimeSecretsToContainer,
} from "./shell.js";
// Skills are loaded dynamically in future — not injected statically
import { 
  saveMemory, updateTask, getTask, getMemoryForTask, 
  createSubTask, updateSubTask, getSubTasksForTask, getSubTask,
  createArtifact, getArtifactsForTask, createReflection,
  getMemoryForSubTask, compressContext, incrementTaskIterations, summarizeConversationHistory
} from './memory.js';
import {
  clearAgentAssignment,
  emitDelegationEvent,
  resolveAssignedAgent,
  setAgentPhase,
} from './agents.js';
import { getSystemPrompt } from './prompts.js';
import { releaseWorkspaceLocks, tryAcquireWorkspaceLocks } from './workspace-locks.js';
import type { AgentId, AgentMode, Message, Task, SubTask } from './types.js';
import path from 'path';

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_ITERATIONS_PER_SUBTASK = parsePositiveIntEnv('MAX_ITERATIONS_PER_SUBTASK', 75);
const LEGACY_TOOL_MODE_ITERATIONS = parsePositiveIntEnv('MAX_ITERATIONS_TOOL_MODE', 60);
const MAX_ITERATIONS_TOOL_MODE_FAST = parsePositiveIntEnv(
  'MAX_ITERATIONS_TOOL_MODE_FAST',
  LEGACY_TOOL_MODE_ITERATIONS,
);
const MAX_ITERATIONS_TOOL_MODE_RESEARCH = parsePositiveIntEnv(
  'MAX_ITERATIONS_TOOL_MODE_RESEARCH',
  Math.max(MAX_ITERATIONS_TOOL_MODE_FAST, 120),
);
const MAX_SUBTASK_RETRIES = 3;
const CONCURRENT_WORKERS = 2;

const MAX_INITIAL_SUBTASKS = 8;
const MAX_TOTAL_SUBTASKS = 12;
const MAX_DAG_DEPTH = 3;
const MAX_NO_PROGRESS = 5;

const LEGACY_TOTAL_AGENT_STEPS = parsePositiveIntEnv('MAX_TOTAL_AGENT_STEPS', 300);
const MAX_TOTAL_AGENT_STEPS_FAST = parsePositiveIntEnv(
  'MAX_TOTAL_AGENT_STEPS_FAST',
  LEGACY_TOTAL_AGENT_STEPS,
);
const MAX_TOTAL_AGENT_STEPS_RESEARCH = parsePositiveIntEnv(
  'MAX_TOTAL_AGENT_STEPS_RESEARCH',
  Math.max(MAX_TOTAL_AGENT_STEPS_FAST, 600),
);
const MAX_REPLAN_ATTEMPTS = 2;
const MAX_RETRIES_PER_TASK = 2;
const MAX_TOOL_OUTPUT_CHARS = 12000;
const MAX_STR_REPLACE_FAILURES_PER_FILE = 2;

function getEffectiveAgentMode(task: Task): AgentMode {
  return task.agentMode === 'RESEARCH' ? 'RESEARCH' : 'FAST';
}

function getToolModeIterationLimit(task: Task): number {
  return getEffectiveAgentMode(task) === 'RESEARCH'
    ? MAX_ITERATIONS_TOOL_MODE_RESEARCH
    : MAX_ITERATIONS_TOOL_MODE_FAST;
}

function getTotalAgentStepBudget(task: Task): number {
  return getEffectiveAgentMode(task) === 'RESEARCH'
    ? MAX_TOTAL_AGENT_STEPS_RESEARCH
    : MAX_TOTAL_AGENT_STEPS_FAST;
}

function chooseAgentMode(goal: string, mode: Task['mode'] | null): AgentMode {
  const text = goal.trim().toLowerCase();
  if (mode === 'autonomous_dag') {
    return 'RESEARCH';
  }

  if (
    /(github\.com|pull request|\bpr\b|issue\s*#?\d+|repo\b|repository\b|codebase\b|local repo\b)/.test(text) &&
    /(fix|debug|investigate|implement|refactor|test|create pr|open pr|submit pr|regression)/.test(text)
  ) {
    return 'RESEARCH';
  }

  if (
    text.split(/\s+/).length > 30 ||
    /(complex|complicated|thorough|end-to-end|root cause|production|architecture|multi-step)/.test(text)
  ) {
    return 'RESEARCH';
  }

  return 'FAST';
}

function extractGithubRepoName(goal: string): string | null {
  const match = goal.match(/github\.com\/[^/\s]+\/([^/\s;?#]+?)(?:\.git)?(?:[/?#]|\s|$)/i);
  return match?.[1] ?? null;
}

async function resolveKnownRepoRoot(task: Task, subTask?: SubTask): Promise<string | null> {
  const candidates = new Set<string>();
  const repoName = extractGithubRepoName(task.goal);
  if (repoName) {
    candidates.add(`/workspace/${repoName}`);
  }

  for (const scope of subTask?.workspaceScope ?? []) {
    const trimmed = scope.trim().replace(/^\.?\//, '');
    if (!trimmed) continue;
    const topLevel = trimmed.split('/')[0];
    if (topLevel) {
      candidates.add(`/workspace/${topLevel}`);
    }
  }

  for (const candidate of candidates) {
    if (await pathExistsInContainer(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function buildRepoContextMessage(task: Task, subTask?: SubTask): Promise<string> {
  const repoRoot = await resolveKnownRepoRoot(task, subTask);
  if (!repoRoot) {
    return '';
  }

  return [
    '## Known Repository Context',
    `Local repo root already exists: ${repoRoot}`,
    'Do not clone this repository again.',
    `Prefer operating relative to ${repoRoot}.`,
    'Use structured discovery tools first: repo_status, list_files, search_code, then read_file before editing.',
  ].join('\n');
}

async function buildRepoFingerprint(repoRoot: string): Promise<string> {
  const parts: string[] = [`Repo root: ${repoRoot}`];

  for (const manifest of ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']) {
    const r = await readFileFromContainer(`${repoRoot}/${manifest}`);
    if (r.exitCode === 0 && r.stdout.trim()) {
      parts.push(`## ${manifest}\n${r.stdout.slice(0, 800)}`);
      break;
    }
  }

  const tree = await listFilesInContainer(repoRoot, 2);
  if (tree.stdout) parts.push(`## Directory structure (depth 2)\n${tree.stdout.slice(0, 1500)}`);

  for (const guide of ['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'CONTRIBUTING.md']) {
    const r = await readFileFromContainer(`${repoRoot}/${guide}`);
    if (r.exitCode === 0 && r.stdout.trim()) {
      parts.push(`## ${guide}\n${r.stdout.slice(0, 1200)}`);
      break;
    }
  }

  return parts.join('\n\n');
}

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
      // Return the previous watermark so the caller's next loop iteration
      // actually ingests the input that woke the wait.
      return lastProcessedInputTime;
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

  if (
    /(github\.com|issue|fix|bug)\b/.test(text) &&
    /(frontend|css|tsx?|jsx?|component|style|ui)\b/.test(text)
  ) {
    return 'tool';
  }

  // Short focused repo tasks go to tool mode — don't spin up the full DAG
  const wordCount = text.split(/\s+/).length;
  const isSmallRepoTask =
    wordCount < 50 &&
    /(github\.com|repo|repository|codebase)\b/.test(text) &&
    /(fix|update|change|edit|add|remove|refactor|debug)\b/.test(text) &&
    !/(build|create|implement|full.stack|entire|whole|new (app|project|service|system))/.test(text);

  if (isSmallRepoTask) return 'tool';

  if (
    /(github\.com|issue\s*#?\d+|pull request|\bpr\b|repo\b|repository\b|codebase\b|local repo\b)/.test(text) &&
    /(fix|debug|investigate|implement|refactor|test|review|create pr|open pr|submit pr)/.test(text)
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

function calculateDagDepth(subTasks: SubTask[]): number {
  if (subTasks.length === 0) return 0;
  const memo = new Map<string, number>();

  function getDepth(id: string): number {
    if (memo.has(id)) return memo.get(id)!;
    const st = subTasks.find(s => s.id === id);
    if (!st || !st.dependencies || st.dependencies.length === 0) {
      memo.set(id, 1);
      return 1;
    }
    const depth = 1 + Math.max(...st.dependencies.map(depId => getDepth(depId)));
    memo.set(id, depth);
    return depth;
  }

  return Math.max(...subTasks.map(st => getDepth(st.id)));
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
      updateTask(currentTask.id, { mode, agentMode: chooseAgentMode(currentTask.goal, mode) });
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

const SAFE_DEV_COMMANDS = [
  /^git /,
  /^npm /,
  /^node /,
  /^npx /,
  /^yarn /,
  /^pnpm /,
  /^cat /,
  /^ls /,
  /^find /,
  /^rg /,
  /^grep /,
  /^wc /,
  /^mkdir /,
  /^cp /,
  /^mv /,
  /^touch /,
  /^echo /,
  /^tsc /,
  /^eslint /,
  /^prettier /,
  /^jest /,
  /^vitest /,
  /^python3? /,
  /^pip3? /,
  /^poetry /,
  /^cargo /,
  /^go /,
  /^cd /,
  /^pwd /,
  /^which /,
  /^env /,
  /^export /,
];

function isObviouslySafe(command: string): boolean {
  return SAFE_DEV_COMMANDS.some((pattern) => pattern.test(command.trim()));
}

function truncateToolOutput(output: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
  if (output.length <= limit) return output;
  const omitted = output.length - limit;
  return `${output.slice(0, limit)}\n\n[output truncated: ${omitted} more characters omitted]`;
}

function isNoisyDiscoveryCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return normalized === 'ls -r' || normalized === 'ls -rf' || normalized.startsWith('ls -r ');
}

function maybeUpdateWorkingDirectory(currentDirectory: string | null, command: string, exitCode: number): string | null {
  if (exitCode !== 0) {
    return currentDirectory;
  }

  const match = command.match(/^\s*cd\s+(".*?"|'.*?'|[^\s;&|]+)\s*(?:&&|$)/);
  if (!match) {
    return currentDirectory;
  }

  const nextDirectory = unquoteShellPath(match[1] ?? '');
  if (!nextDirectory) {
    return currentDirectory;
  }

  if (nextDirectory.startsWith('/')) {
    return path.posix.normalize(nextDirectory);
  }

  const base = currentDirectory || '/workspace';
  return path.posix.normalize(path.posix.join(base, nextDirectory));
}

function applyWorkingDirectory(command: string, currentDirectory: string | null): string {
  if (!currentDirectory) {
    return command;
  }
  if (command.trim().startsWith('cd ')) {
    return command;
  }
  return `cd ${JSON.stringify(currentDirectory)} && ${command}`;
}

type CommandReplay = {
  output: string;
  exitCode: number;
};

function buildRepeatCommandFeedback(command: string, replay: CommandReplay): string {
  return (
    `You already ran \`${command}\` and got exit ${replay.exitCode}. ` +
    `Do not repeat the same shell command unless new information changes the situation.\n` +
    `Previous output:\n${replay.output}\n\n` +
    'Use that result and choose a narrower next step.'
  );
}

function isCdPathFailure(command: string, result: { exitCode: number; stdout: string; stderr: string }): boolean {
  if (result.exitCode === 0) {
    return false;
  }
  if (!command.trim().startsWith('cd ')) {
    return false;
  }
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return output.includes('no such file or directory');
}

function isDependencyEnvironmentFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes('cannot find module') &&
    (
      normalized.includes('node_modules') ||
      normalized.includes('abort-controller.js.text.js')
    )
  );
}

function getBuildFailureFeedback(output: string): string {
  if (isDependencyEnvironmentFailure(output)) {
    return (
      'Build verification hit a broken dependency environment rather than a code change regression. ' +
      'Do not spend more turns trying to repair node_modules unless the task explicitly asks for environment repair. ' +
      `Proceed using other evidence and note this environment issue in the final summary.\n\n${output}`
    );
  }

  return `Build verification failed. Fix these errors before calling task_done:\n\n${output}`;
}

function getStrReplaceFailureFeedback(file: string, failures: number): string {
  if (failures < MAX_STR_REPLACE_FAILURES_PER_FILE) {
    return (
      `str_replace_file failed for ${file}. Re-read a narrower range and try once more with exact current text. ` +
      'If the edit is a section deletion or larger JSX block change, prefer delete_block_file instead of another broad replacement.'
    );
  }

  return (
    `str_replace_file has failed ${failures} times for ${file}. Stop retrying exact-text replacement on this file. ` +
    'Use delete_block_file for anchored block deletion, insert_at_line for focused additions, or a narrower, deterministic edit strategy.'
  );
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
  const maxIterations = getToolModeIterationLimit(task);
  const totalStepBudget = getTotalAgentStepBudget(task);
  updateTask(task.id, { status: 'running', startedAt: Date.now() });
  setAgentPhase('Forge', 'working', {
    currentTaskId: task.id,
    currentTaskGoal: task.goal,
    note: 'Executing linear tool task',
  });
  await ensureWorkspaceReady();
  await syncRuntimeSecretsToContainer();

  const preinstalled = await getPreinstalledPackages();
  const repoContext = await buildRepoContextMessage(task);
  const envContext = `

## Environment — already installed, DO NOT reinstall these:

Node (global): ${preinstalled.npm.join(', ')}
Python (pip): ${preinstalled.pip.join(', ')}

If you need a package NOT in the above list, install it normally. It will persist across sessions via Docker volumes.
`;

  const systemPrompt = getSystemPrompt('standalone_worker', { task });
  const conversationHistory: Message[] = [{ role: 'user', content: envContext }];
  const repoRoot = await resolveKnownRepoRoot(task);
  let currentWorkingDirectory: string | null = repoRoot;
  if (repoContext) {
    conversationHistory.push({ role: 'user', content: repoContext });
  }
  if (currentWorkingDirectory) {
    const fingerprint = await buildRepoFingerprint(currentWorkingDirectory);
    if (fingerprint) {
      conversationHistory.push({
        role: 'user',
        content: `## Codebase Context\n${fingerprint}`,
      });
    }
  }
  if (repoRoot) {
    for (const file of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
      const result = await readFileFromContainer(`${repoRoot}/${file}`);
      if (result.exitCode === 0 && result.stdout) {
        conversationHistory.push({
          role: 'user',
          content: `Repo instructions from ${file}:\n${result.stdout}`,
        });
      }
    }
  }
  conversationHistory.push({ role: 'user', content: task.goal });

  // Initialize with task createdAt - 1 to catch very early inputs
  let lastProcessedInputTime = task.createdAt - 1;
  const previousShellResults = new Map<string, CommandReplay>();
  let failedCdCommandCount = 0;
  const strReplaceFailuresByFile = new Map<string, number>();

  for (let i = 1; i <= maxIterations; i++) {
    if (isTaskCancelled(task.id)) {
      clearAgentAssignment('Forge');
      return;
    }
    if (i > 0 && i % 20 === 0) {
      conversationHistory.splice(0, conversationHistory.length, ...summarizeConversationHistory(conversationHistory, 20));
    }
    incrementTaskIterations(task.id);

    const currentTask = getTask(task.id);
    const nextTotalAgentSteps = (currentTask?.totalAgentSteps || 0) + 1;
    updateTask(task.id, { totalAgentSteps: nextTotalAgentSteps });
    if (nextTotalAgentSteps > totalStepBudget) {
      updateTask(task.id, {
        status: 'failed',
        completedAt: Date.now(),
        error: `Global agent step budget reached in Tool mode (${totalStepBudget} steps).`,
      });
      clearAgentAssignment('Forge');
      return;
    }

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
      if (currentWorkingDirectory) {
        const buildCheck = await runBuildVerification(currentWorkingDirectory);
        if (!buildCheck.passed) {
          conversationHistory.push({
            role: 'user',
            content: getBuildFailureFeedback(buildCheck.output),
          });
          continue;
        }
      }
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

    if (toolCall.name === 'repo_status') {
      const { path } = toolCall.args;
      saveMemory(task.id, 'command', `[repo_status] ${path}`, null, 'working');
      const result = await getRepoStatusInContainer(path);
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no output)');
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, null, 'working');
      conversationHistory.push({ role: 'user', content: `Repository status for ${path} (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'list_files') {
      const { path, max_depth } = toolCall.args;
      saveMemory(task.id, 'command', `[list_files] ${path} depth=${max_depth ?? 4}`, null, 'working');
      const result = await listFilesInContainer(path, Number(max_depth ?? 4));
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no output)');
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, null, 'working');
      conversationHistory.push({ role: 'user', content: `Files under ${path} (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'search_code') {
      const { path, pattern, glob } = toolCall.args;
      saveMemory(task.id, 'command', `[search_code] ${path} :: ${pattern}`, null, 'working');
      const result = await searchCodeInContainer(path, pattern, glob);
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no matches)');
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, null, 'working');
      conversationHistory.push({ role: 'user', content: `Search results for ${JSON.stringify(pattern)} in ${path} (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'read_file') {
      const { path, start_line, end_line } = toolCall.args;
      const rangeSuffix =
        start_line != null || end_line != null
          ? ` lines=${start_line ?? 1}-${end_line ?? 'EOF'}`
          : '';
      saveMemory(task.id, 'command', `[read_file] ${path}${rangeSuffix}`, null, 'working');
      const result = await readFileFromContainer(path, start_line, end_line);
      const output = truncateToolOutput(result.stdout || '(empty file)');
      saveMemory(task.id, 'output', output, null, 'working');
      const label =
        start_line != null || end_line != null
          ? `Contents of ${path} (lines ${start_line ?? 1}-${end_line ?? 'EOF'}):`
          : `Contents of ${path}:`;
      const truncationWarning = output.includes('[output truncated:')
        ? '\nIf you need exact edit context from a large file, call read_file again with start_line and end_line for a narrow range.'
        : '';
      conversationHistory.push({ role: 'user', content: `${label}\n${output}${truncationWarning}` });
      continue;
    }

    if (toolCall.name === 'str_replace_file') {
      const { file, old_str, new_str } = toolCall.args;
      const failureCount = strReplaceFailuresByFile.get(file) ?? 0;
      if (failureCount >= MAX_STR_REPLACE_FAILURES_PER_FILE) {
        conversationHistory.push({
          role: 'user',
          content: getStrReplaceFailureFeedback(file, failureCount),
        });
        continue;
      }
      saveMemory(task.id, 'command', `[str_replace] ${file}`, null, 'working');
      const result = await strReplaceInContainer(file, old_str, new_str);
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no output)');
      if (result.exitCode === 0) {
        strReplaceFailuresByFile.delete(file);
      } else {
        const nextFailures = failureCount + 1;
        strReplaceFailuresByFile.set(file, nextFailures);
        conversationHistory.push({
          role: 'user',
          content: getStrReplaceFailureFeedback(file, nextFailures),
        });
      }
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, null, 'working');
      conversationHistory.push({ role: 'user', content: `str_replace result (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'delete_block_file') {
      const { file, start_anchor, end_anchor } = toolCall.args;
      saveMemory(task.id, 'command', `[delete_block] ${file}`, null, 'working');
      const result = await deleteBlockInContainer(file, start_anchor, end_anchor);
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no output)');
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, null, 'working');
      conversationHistory.push({ role: 'user', content: `delete_block result (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'insert_at_line') {
      const { file, line, text } = toolCall.args;
      saveMemory(task.id, 'command', `[insert_at_line] ${file}:${line}`, null, 'working');
      const result = await insertAtLineInContainer(file, line, text);
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no output)');
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, null, 'working');
      conversationHistory.push({ role: 'user', content: `insert_at_line result (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'write_file') {
      const { path: filePath, content } = toolCall.args;
      saveMemory(task.id, 'command', `[write_file] ${filePath}`, null, 'working');

      if (await pathExistsInContainer(filePath)) {
        conversationHistory.push({ role: 'user', content: `File ${filePath} already exists. Use str_replace_file to edit it.` });
        continue;
      }

      const dir = filePath.split('/').slice(0, -1).join('/');
      if (dir) await execInContainer(`mkdir -p ${JSON.stringify(dir)}`);

      const b64 = Buffer.from(content, 'utf8').toString('base64');
      const result = await execInContainer(`echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(filePath)}`);
      const output = result.exitCode === 0 ? `File created: ${filePath}` : (result.stdout + result.stderr).slice(0, 500);

      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, null, 'working');
      conversationHistory.push({ role: 'user', content: `write_file (exit ${result.exitCode}): ${output}` });
      continue;
    }

    if (toolCall.name === 'run_shell') {
      const { command } = toolCall.args;

      if (isNoisyDiscoveryCommand(command)) {
        saveMemory(task.id, 'security_alert', `Blocked noisy discovery command: ${command}`, null, 'working');
        conversationHistory.push({
          role: 'user',
          content:
            'Do not use recursive ls output. Use a narrow command such as `rg --files`, `find . -maxdepth 2 -type f | sort`, or `ls` in a specific directory.',
        });
        continue;
      }

      if (await blockExistingFileOverwrite(task.id, null, command, conversationHistory)) {
        continue;
      }

      const isSafe =
        isObviouslySafe(command) || (await runSecurityAudit(task, command, { title: 'Tool Execution' } as any));
      if (!isSafe) {
        saveMemory(task.id, 'security_alert', `Blocked command: ${command}`, null, 'working');
        conversationHistory.push({ role: 'user', content: 'That command is blocked by the security policy. Please use a safer alternative.' });
        continue;
      }

      const effectiveCommand = applyWorkingDirectory(command, currentWorkingDirectory);
      const priorResult = previousShellResults.get(effectiveCommand);
      if (priorResult) {
        saveMemory(task.id, 'thought', `Blocked duplicate shell command: ${effectiveCommand}`, null, 'working');
        conversationHistory.push({
          role: 'user',
          content: buildRepeatCommandFeedback(effectiveCommand, priorResult),
        });
        continue;
      }

      saveMemory(task.id, 'command', `$ ${effectiveCommand}`, null, 'working');
      const result = await execInContainer(effectiveCommand);
      currentWorkingDirectory = maybeUpdateWorkingDirectory(currentWorkingDirectory, command, result.exitCode);
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no output)');
      if (isCdPathFailure(command, result)) {
        failedCdCommandCount++;
        conversationHistory.push({
          role: 'user',
          content: 'Shell error: cd failed. Do not retry this path. Use absolute paths directly or re-discover the repo root before running more commands.',
        });
        if (failedCdCommandCount > 3) {
          conversationHistory.push({
            role: 'user',
            content: 'Too many consecutive cd failures. Re-read the task and restart from the repo root instead of chaining cd commands.',
          });
          failedCdCommandCount = 0;
        }
      } else if (result.exitCode === 0) {
        failedCdCommandCount = 0;
      }
      if (result.exitCode === 0) {
        previousShellResults.set(effectiveCommand, { output, exitCode: result.exitCode });
      }
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, null, 'working');
      conversationHistory.push({ role: 'user', content: `Command output (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    // Unknown tool
    conversationHistory.push({ role: 'user', content: `Unknown tool: ${toolCall.name}. Available tools: repo_status, list_files, search_code, run_shell, read_file, str_replace_file, delete_block_file, insert_at_line, write_file, ask_user, task_done.` });
  }

  if (!isTaskCancelled(task.id)) {
    updateTask(task.id, {
      status: 'failed',
      completedAt: Date.now(),
      error: `Tool mode iteration budget reached (${maxIterations} steps).`,
    });
  }
  clearAgentAssignment('Forge');
}

export async function runOrchestrator(task: Task): Promise<void> {
  try {
    const totalStepBudget = getTotalAgentStepBudget(task);
    console.log(`\n[Orchestrator] Starting: ${task.goal}`);
    updateTask(task.id, { 
      status: 'running', 
      startedAt: Date.now(),
      replanCount: 0,
      totalAgentSteps: 0
    });
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
      const currentTask = getTask(task.id)!;
      if (currentTask.status === 'cancelled') {
        return;
      }

      // Global Budget Check
      if ((currentTask.totalAgentSteps || 0) >= totalStepBudget) {
        console.error(`[Orchestrator] Execution terminated: Global budget exceeded (${totalStepBudget} steps).`);
        saveMemory(task.id, 'error', `Execution terminated: Global budget exceeded (${totalStepBudget} steps).`, null, 'working');
        completed = true;
        break;
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

        // Retry limit check
        if (subTasks.some(st => st.status === 'failed' && st.retryCount >= MAX_RETRIES_PER_TASK)) {
          console.error('[Orchestrator] Task failed: Some subtasks failed permanently.');
          updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: 'Some subtasks failed permanently (retry limit reached).' });
          return;
        }
        
        if (currentTask.agentMode === 'FAST') {
          console.log('[Orchestrator] No unblocked tasks in FAST mode. Failing task to prevent over-planning.');
          updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: 'Stalled: No unblocked tasks available in FAST mode.' });
          return;
        }

        // Replan limit check
        if ((currentTask.replanCount || 0) >= MAX_REPLAN_ATTEMPTS) {
          console.error(`[Orchestrator] Replanning terminated: Max attempts reached (${MAX_REPLAN_ATTEMPTS}).`);
          updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: `Maximum replan attempts reached (${MAX_REPLAN_ATTEMPTS}).` });
          return;
        }

        console.log('[Orchestrator] No unblocked tasks and not all done. Checking for replanning...');
        await reflectAndReplan(task);
        updateTask(task.id, { replanCount: (currentTask.replanCount || 0) + 1 });
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

    console.log(`\n[Orchestrator] Execution finished: ${task.goal}`);
    const finalSubTasks = getSubTasksForTask(task.id);
    const completedSubTasks = finalSubTasks.filter((st) => st.status === 'done');
    const failedSubTasks = finalSubTasks.filter((st) => st.status === 'failed');
    const artifactNames = getArtifactsForTask(task.id).map((artifact) => artifact.name);
    
    const finalTask = getTask(task.id)!;
    const metrics = {
      initialSubtaskCount: finalTask.metrics?.initialSubtaskCount || 0,
      totalSubtaskCount: finalSubTasks.length,
      tasksCompleted: completedSubTasks.length,
      tasksFailed: failedSubTasks.length,
      replanCount: finalTask.replanCount || 0,
      averageTaskIterations: finalSubTasks.length > 0 
        ? Math.round(finalSubTasks.reduce((acc, st) => acc + (st.retryCount * MAX_ITERATIONS_PER_SUBTASK), 0) / finalSubTasks.length) // Rough estimate
        : 0
    };

    const summary = [
      finalTask.status === 'done' ? 'Goal achieved.' : 'Execution finished.',
      `Completed milestones: ${completedSubTasks.length}/${finalSubTasks.length}`,
      `Total Agent Steps: ${finalTask.totalAgentSteps}/${totalStepBudget}`,
      `Replans: ${finalTask.replanCount}/${MAX_REPLAN_ATTEMPTS}`,
      artifactNames.length > 0 ? `Artifacts: ${artifactNames.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    updateTask(task.id, { 
      status: finalTask.status === 'failed' ? 'failed' : 'done', 
      completedAt: Date.now(), 
      result: summary,
      metrics 
    });
    
    saveMemory(task.id, 'thought', `Execution Summary:\n${summary}\n\nMetrics: ${JSON.stringify(metrics, null, 2)}`, null, 'episodic');
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
      // FAST mode skips critique phase
      if (task.agentMode === 'RESEARCH') {
        // Critique Phase
        const criticPassed = await runCriticLoop(task, updatedSubTask);
        if (!criticPassed) {
          console.log(`[Orchestrator] Critique failed for: ${subTask.title}`);
          await handleSubTaskFailure(task, updatedSubTask, 'critique');
        }
      } else {
        // In FAST mode, just mark as done if verification passed
        updateSubTask(subTask.id, { status: 'done' });
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

    if (plan.subTasks.length > MAX_INITIAL_SUBTASKS) {
      throw new Error(`Planner attempted to create ${plan.subTasks.length} subtasks, which exceeds the limit of ${MAX_INITIAL_SUBTASKS}.`);
    }

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

    updateTask(task.id, {
      metrics: {
        initialSubtaskCount: createdSubTasks.length,
        totalSubtaskCount: createdSubTasks.length,
        tasksCompleted: 0,
        tasksFailed: 0,
        replanCount: 0,
        averageTaskIterations: 0
      }
    });

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
    name: 'repo_status',
    description: 'Inspect an existing git repository without guessing shell commands. Use this first for repo tasks to confirm the repo root and current branch/status.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the repository root inside the container, e.g. /workspace/my-repo'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'list_files',
    description: 'List files and directories in a narrow part of the workspace. Prefer this over broad shell discovery like find or ls -R.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute directory path to inspect inside the container'
        },
        max_depth: {
          type: 'number',
          description: 'Maximum directory depth to list. Keep this small, usually 2-4.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'search_code',
    description: 'Search code or text within a specific directory using ripgrep. Prefer this over ad hoc grep commands when locating implementation details.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute directory path to search inside the container'
        },
        pattern: {
          type: 'string',
          description: 'The text or regex pattern to search for'
        },
        glob: {
          type: 'string',
          description: 'Optional narrow file glob such as *.ts, *.tsx, or *.py'
        }
      },
      required: ['path', 'pattern']
    }
  },
  {
    name: 'run_shell',
    description: 'Run a bash command in the Docker workspace container. Use for: installing packages, running tests, starting servers, listing directories, checking git status. Do NOT use for editing existing files — use str_replace_file instead.',
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
    description: 'Read a file inside the container. For large files, request a targeted line range so you have exact edit context without truncation.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file inside the container, e.g. /workspace/src/index.ts'
        },
        start_line: {
          type: 'number',
          description: 'Optional 1-based starting line. Use this for large files when you only need a specific region.'
        },
        end_line: {
          type: 'number',
          description: 'Optional 1-based ending line, inclusive. Use with start_line to read an exact slice.'
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
    name: 'delete_block_file',
    description: 'Deterministically delete a contiguous block from an existing file using start and end anchor text. Prefer this for removing JSX sections, large blocks, or exact anchored regions when str_replace_file is brittle.',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Absolute path to the file inside the container'
        },
        start_anchor: {
          type: 'string',
          description: 'Exact text that marks the start of the block to delete'
        },
        end_anchor: {
          type: 'string',
          description: 'Exact text that marks the end of the block to delete. This anchor is removed too.'
        }
      },
      required: ['file', 'start_anchor', 'end_anchor']
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
    name: 'write_file',
    description: 'Create a new file with given content. Only for NEW files that do not exist yet. For existing files use str_replace_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the new file inside the container' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
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
  await ensureWorkspaceReady();
  await syncRuntimeSecretsToContainer();

  const preinstalled = await getPreinstalledPackages();
  const repoContext = await buildRepoContextMessage(task, subTask);
  const envContext = `

## Environment — already installed, DO NOT reinstall these:

Node (global): ${preinstalled.npm.join(', ')}
Python (pip): ${preinstalled.pip.join(', ')}

If you need a package NOT in the above list, install it normally. It will persist across sessions via Docker volumes.
`;

  const artifacts = getArtifactsForTask(task.id);
  const systemPrompt = getSystemPrompt('worker', { task, subTask, artifacts });

  const conversationHistory: Message[] = [{ role: 'user', content: envContext }];
  let currentWorkingDirectory: string | null = await resolveKnownRepoRoot(task, subTask);
  if (repoContext) {
    conversationHistory.push({ role: 'user', content: repoContext });
  }
  if (currentWorkingDirectory) {
    const fingerprint = await buildRepoFingerprint(currentWorkingDirectory);
    if (fingerprint) {
      conversationHistory.push({
        role: 'user',
        content: `## Codebase Context\n${fingerprint}`,
      });
    }
  }
  conversationHistory.push({
    role: 'user',
    content: `Start working on SubTask: ${subTask.title}\nDescription: ${subTask.description}`,
  });

  let lastProcessedInputTime = subTask.createdAt - 1;
  let consecutiveNoProgress = 0;
  let lastState = { thought: '', toolName: '', toolArgs: '' };
  const previousShellResults = new Map<string, CommandReplay>();
  let failedCdCommandCount = 0;
  const strReplaceFailuresByFile = new Map<string, number>();

  for (let i = 1; i <= MAX_ITERATIONS_PER_SUBTASK; i++) {
    if (isTaskCancelled(task.id) || isSubTaskCancelled(subTask.id)) {
      clearAgentAssignment(assignedAgent);
      return;
    }
    if (i > 0 && i % 20 === 0) {
      conversationHistory.splice(0, conversationHistory.length, ...summarizeConversationHistory(conversationHistory, 20));
    }
    incrementTaskIterations(task.id);
    
    // Update global step count
    const currentTask = getTask(task.id);
    if (currentTask) {
      updateTask(task.id, { totalAgentSteps: (currentTask.totalAgentSteps || 0) + 1 });
    }

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

    // Progress detection
    const currentState = { 
      thought: thought || '', 
      toolName: toolCall?.name || '', 
      toolArgs: JSON.stringify(toolCall?.args || {}) 
    };
    
    if (currentState.thought === lastState.thought && 
        currentState.toolName === lastState.toolName && 
        currentState.toolArgs === lastState.toolArgs) {
      consecutiveNoProgress++;
    } else {
      consecutiveNoProgress = 0;
    }
    lastState = currentState;

    if (consecutiveNoProgress >= MAX_NO_PROGRESS) {
      const msg = `Subtask failed: No meaningful progress for ${MAX_NO_PROGRESS} iterations. Stalled at: ${currentState.thought.slice(0, 100)}`;
      saveMemory(task.id, 'error', msg, subTask.id, 'working');
      updateSubTask(subTask.id, { status: 'failed', completedAt: Date.now(), error: 'Stalled: No progress detected' });
      clearAgentAssignment(assignedAgent);
      return;
    }

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
      if (currentWorkingDirectory) {
        const buildCheck = await runBuildVerification(currentWorkingDirectory);
        if (!buildCheck.passed) {
          conversationHistory.push({
            role: 'user',
            content: getBuildFailureFeedback(buildCheck.output),
          });
          continue;
        }
      }
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

    if (toolCall.name === 'repo_status') {
      const { path } = toolCall.args;
      saveMemory(task.id, 'command', `[repo_status] ${path}`, subTask.id, 'working');
      const result = await getRepoStatusInContainer(path);
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no output)');
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `Repository status for ${path} (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'list_files') {
      const { path, max_depth } = toolCall.args;
      saveMemory(task.id, 'command', `[list_files] ${path} depth=${max_depth ?? 4}`, subTask.id, 'working');
      const result = await listFilesInContainer(path, Number(max_depth ?? 4));
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no output)');
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `Files under ${path} (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'search_code') {
      const { path, pattern, glob } = toolCall.args;
      saveMemory(task.id, 'command', `[search_code] ${path} :: ${pattern}`, subTask.id, 'working');
      const result = await searchCodeInContainer(path, pattern, glob);
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no matches)');
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `Search results for ${JSON.stringify(pattern)} in ${path} (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'read_file') {
      const { path, start_line, end_line } = toolCall.args;
      const rangeSuffix =
        start_line != null || end_line != null
          ? ` lines=${start_line ?? 1}-${end_line ?? 'EOF'}`
          : '';
      saveMemory(task.id, 'command', `[read_file] ${path}${rangeSuffix}`, subTask.id, 'working');
      const result = await readFileFromContainer(path, start_line, end_line);
      const output = truncateToolOutput(result.stdout || '(empty file)');
      saveMemory(task.id, 'output', output, subTask.id, 'working');
      const label =
        start_line != null || end_line != null
          ? `Contents of ${path} (lines ${start_line ?? 1}-${end_line ?? 'EOF'}):`
          : `Contents of ${path}:`;
      const truncationWarning = output.includes('[output truncated:')
        ? '\nIf you need exact edit context from a large file, call read_file again with start_line and end_line for a narrow range.'
        : '';
      conversationHistory.push({ role: 'user', content: `${label}\n${output}${truncationWarning}` });
      continue;
    }

    if (toolCall.name === 'str_replace_file') {
      const { file, old_str, new_str } = toolCall.args;
      const failureCount = strReplaceFailuresByFile.get(file) ?? 0;
      if (failureCount >= MAX_STR_REPLACE_FAILURES_PER_FILE) {
        conversationHistory.push({
          role: 'user',
          content: getStrReplaceFailureFeedback(file, failureCount),
        });
        continue;
      }
      saveMemory(task.id, 'command', `[str_replace] ${file}`, subTask.id, 'working');
      const result = await strReplaceInContainer(file, old_str, new_str);
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no output)');
      if (result.exitCode === 0) {
        strReplaceFailuresByFile.delete(file);
      } else {
        const nextFailures = failureCount + 1;
        strReplaceFailuresByFile.set(file, nextFailures);
        conversationHistory.push({
          role: 'user',
          content: getStrReplaceFailureFeedback(file, nextFailures),
        });
      }
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `str_replace result (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'delete_block_file') {
      const { file, start_anchor, end_anchor } = toolCall.args;
      saveMemory(task.id, 'command', `[delete_block] ${file}`, subTask.id, 'working');
      const result = await deleteBlockInContainer(file, start_anchor, end_anchor);
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no output)');
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `delete_block result (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'insert_at_line') {
      const { file, line, text } = toolCall.args;
      saveMemory(task.id, 'command', `[insert_at_line] ${file}:${line}`, subTask.id, 'working');
      const result = await insertAtLineInContainer(file, line, text);
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no output)');
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `insert_at_line result (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'write_file') {
      const { path: filePath, content } = toolCall.args;
      saveMemory(task.id, 'command', `[write_file] ${filePath}`, subTask?.id ?? null, 'working');

      if (await pathExistsInContainer(filePath)) {
        conversationHistory.push({ role: 'user', content: `File ${filePath} already exists. Use str_replace_file to edit it.` });
        continue;
      }

      const dir = filePath.split('/').slice(0, -1).join('/');
      if (dir) await execInContainer(`mkdir -p ${JSON.stringify(dir)}`);

      const b64 = Buffer.from(content, 'utf8').toString('base64');
      const result = await execInContainer(`echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(filePath)}`);
      const output = result.exitCode === 0 ? `File created: ${filePath}` : (result.stdout + result.stderr).slice(0, 500);

      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask?.id ?? null, 'working');
      conversationHistory.push({ role: 'user', content: `write_file (exit ${result.exitCode}): ${output}` });
      continue;
    }

    if (toolCall.name === 'run_shell') {
      const { command } = toolCall.args;

      if (isNoisyDiscoveryCommand(command)) {
        saveMemory(task.id, 'security_alert', `Blocked noisy discovery command: ${command}`, subTask.id, 'working');
        conversationHistory.push({
          role: 'user',
          content:
            'Do not use recursive ls output. Use a narrow command such as `rg --files`, `find . -maxdepth 2 -type f | sort`, or `ls` in a specific directory.',
        });
        continue;
      }

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

      const isSafe = isObviouslySafe(command) || (await runSecurityAudit(task, command, subTask));
      if (!isSafe) {
        saveMemory(task.id, 'security_alert', `Security audit blocked: ${command}`, subTask.id, 'working');
        conversationHistory.push({ role: 'user', content: 'Security Audit FAILED: command blocked. Please suggest an alternative approach.' });
        continue;
      }

      const effectiveCommand = applyWorkingDirectory(command, currentWorkingDirectory);
      const priorResult = previousShellResults.get(effectiveCommand);
      if (priorResult) {
        saveMemory(task.id, 'thought', `Blocked duplicate shell command: ${effectiveCommand}`, subTask.id, 'working');
        conversationHistory.push({
          role: 'user',
          content: buildRepeatCommandFeedback(effectiveCommand, priorResult),
        });
        continue;
      }

      saveMemory(task.id, 'command', `$ ${effectiveCommand}`, subTask.id, 'working');
      const result = await execInContainer(effectiveCommand, 600000);
      currentWorkingDirectory = maybeUpdateWorkingDirectory(currentWorkingDirectory, command, result.exitCode);
      const output = truncateToolOutput((result.stdout + result.stderr) || '(no output)');
      if (isCdPathFailure(command, result)) {
        failedCdCommandCount++;
        conversationHistory.push({
          role: 'user',
          content: 'Shell error: cd failed. Do not retry this path. Use absolute paths directly or re-discover the repo root before running more commands.',
        });
        if (failedCdCommandCount > 3) {
          conversationHistory.push({
            role: 'user',
            content: 'Too many consecutive cd failures. Re-read the task and restart from the repo root instead of chaining cd commands.',
          });
          failedCdCommandCount = 0;
        }
      } else if (result.exitCode === 0) {
        failedCdCommandCount = 0;
      }
      if (result.exitCode === 0) {
        previousShellResults.set(effectiveCommand, { output, exitCode: result.exitCode });
      }
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `Command output (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    // Unknown tool - tell the model
    conversationHistory.push({ role: 'user', content: `Unknown tool: ${toolCall.name}. Available tools: repo_status, list_files, search_code, run_shell, read_file, str_replace_file, delete_block_file, insert_at_line, write_file, ask_user, task_done.` });
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

async function runBuildVerification(repoRoot: string): Promise<{ passed: boolean; output: string }> {
  const pkgResult = await readFileFromContainer(`${repoRoot}/package.json`);
  if (pkgResult.exitCode !== 0) return { passed: true, output: '' };

  let pkg: any = {};
  try { pkg = JSON.parse(pkgResult.stdout); } catch { return { passed: true, output: '' }; }

  const scripts = pkg.scripts || {};
  const tryScript = async (name: string) => {
    const r = await execInContainer(`cd ${JSON.stringify(repoRoot)} && npm run ${name} 2>&1 | tail -40`, 120000);
    return r;
  };

  if (scripts.build) {
    const r = await tryScript('build');
    if (r.exitCode !== 0) return { passed: false, output: `Build failed:\n${r.stdout + r.stderr}` };
  } else {
    const r = await execInContainer(`cd ${JSON.stringify(repoRoot)} && npx tsc --noEmit 2>&1 | tail -30`, 60000);
    if (r.exitCode !== 0) return { passed: false, output: `TypeScript errors:\n${r.stdout + r.stderr}` };
  }

  return { passed: true, output: 'Build passed.' };
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

  if (task.agentMode === 'FAST') {
    console.log(`[Orchestrator] Failure in FAST mode for: ${subTask.title}. Skipping reflection.`);
  } else {
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
    clearAgentAssignment('Echo');
  }

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
    
    if (subTasks.length + newSubTasks.length > MAX_TOTAL_SUBTASKS) {
      throw new Error(`Replanning would exceed MAX_TOTAL_SUBTASKS (${MAX_TOTAL_SUBTASKS}). Current: ${subTasks.length}, New: ${newSubTasks.length}`);
    }

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

    // Depth check after linking
    const allSubTasks = getSubTasksForTask(task.id);
    const currentDepth = calculateDagDepth(allSubTasks);
    if (currentDepth > MAX_DAG_DEPTH) {
      throw new Error(`Replanning exceeded MAX_DAG_DEPTH (${MAX_DAG_DEPTH}). Current depth: ${currentDepth}`);
    }

    clearAgentAssignment('Atlas');
  } catch (err: any) {
    console.error('[Orchestrator] Replanning failed:', err.message);
    saveMemory(task.id, 'error', `Replanning failed: ${err.message}`, null, 'working');
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

