import { callLLM, callLLMWithTools } from './agent.js';
import type { ToolDefinition, GeminiContent, GeminiPart, ToolCall } from './agent.js';
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
import { executeWithAider } from './aider-executor.js';
// Skills are loaded dynamically in future — not injected statically
import { 
  saveMemory, updateTask, getTask, getMemoryForTask, 
  createSubTask, updateSubTask, getSubTasksForTask, getSubTask,
  createArtifact, getArtifactsForTask, createReflection,
  getMemoryForSubTask, incrementTaskIterations,
  getAgentKnowledge, setAgentKnowledge, listAgentKnowledge, deleteAgentKnowledge
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

const MAX_ITERATIONS_PER_SUBTASK = parsePositiveIntEnv('MAX_ITERATIONS_PER_SUBTASK', 60);
const MAX_ITERATIONS_TOOL_MODE = parsePositiveIntEnv('MAX_ITERATIONS_TOOL_MODE', 50);
const MAX_SUBTASK_RETRIES = 3;
const CONCURRENT_WORKERS = 2;
const MAX_INITIAL_SUBTASKS = 8;
const MAX_NO_PROGRESS = 4;
const MAX_TOTAL_AGENT_STEPS = parsePositiveIntEnv('MAX_TOTAL_AGENT_STEPS', 250);
const MAX_REPLAN_ATTEMPTS = 2;
const MAX_RETRIES_PER_TASK = 2;
const MAX_TOOL_OUTPUT_CHARS = 4000; // Tight limit prevents context bloat
const MAX_STR_REPLACE_FAILURES_PER_FILE = 2;
const SUMMARIZE_EVERY = 8; // Aggressive context compaction

// ── Native Gemini Content Builders ───────────────────────────────────────────

function userText(content: string): GeminiContent {
  return { role: 'user', parts: [{ text: content }] };
}

function modelToolCalls(calls: ToolCall[], thought?: string): GeminiContent {
  const parts: GeminiPart[] = [];
  if (thought) parts.push({ text: thought });
  for (const call of calls) {
    parts.push({ functionCall: { name: call.name, args: call.args } });
  }
  return { role: 'model', parts };
}

function toolResultParts(results: { name: string; result: string }[]): GeminiContent {
  return {
    role: 'user',
    parts: results.map(r => ({
      functionResponse: { name: r.name, response: { result: r.result } }
    } as GeminiPart)),
  };
}

// ── Scratchpad (Running Memory) ──────────────────────────────────────────────

interface Scratchpad {
  filesRead: Set<string>;
  filesEdited: Set<string>;
  commandsRun: number;
  errors: number;
  keyFindings: string[];
}

function newScratchpad(): Scratchpad {
  return { filesRead: new Set(), filesEdited: new Set(), commandsRun: 0, errors: 0, keyFindings: [] };
}

function scratchpadSummary(pad: Scratchpad): string {
  const lines = ['## Working Memory (do NOT re-read these)'];
  if (pad.filesRead.size > 0) lines.push('Read: ' + [...pad.filesRead].slice(-15).join(', '));
  if (pad.filesEdited.size > 0) lines.push('Edited: ' + [...pad.filesEdited].join(', '));
  lines.push(`Cmds: ${pad.commandsRun} | Errors: ${pad.errors}`);
  if (pad.keyFindings.length > 0) lines.push('Findings:\n- ' + pad.keyFindings.slice(-6).join('\n- '));
  return lines.join('\n');
}

function compactHistory(history: GeminiContent[], pad: Scratchpad, keepRecent = 6): GeminiContent[] {
  if (history.length <= keepRecent + 2) return history;
  const summary = scratchpadSummary(pad);
  return [userText(summary), ...history.slice(-keepRecent)];
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
  updateTask(task.id, { status: 'running', startedAt: Date.now() });
  setAgentPhase('Forge', 'working', {
    currentTaskId: task.id,
    currentTaskGoal: task.goal,
    note: 'Executing via Aider',
  });
  await ensureWorkspaceReady();
  await syncRuntimeSecretsToContainer();

  const repoRoot = await resolveKnownRepoRoot(task);
  const workDir = repoRoot || '/workspace';

  // Delegate to Aider with auto-retry
  const result = await executeWithAider(task.goal, workDir, task.id, null, 3);

  if (isTaskCancelled(task.id)) { clearAgentAssignment('Forge'); return; }

  if (result.success) {
    // Run build verification
    const buildCheck = await runBuildVerification(workDir);
    if (!buildCheck.passed) {
      // One more Aider attempt with build errors as context
      saveMemory(task.id, 'error', `Build failed after Aider: ${buildCheck.output.slice(0, 500)}`, null, 'working');
      const fixResult = await executeWithAider(
        `${task.goal}\n\nBUILD FAILED. Fix these errors:\n${buildCheck.output}`,
        workDir, task.id, null, 1
      );
      if (!fixResult.success || !(await runBuildVerification(workDir)).passed) {
        updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: `Build still failing after fix attempt.` });
        clearAgentAssignment('Forge');
        return;
      }
    }

    const summary = result.filesChanged.length > 0
      ? `Completed. Files changed: ${result.filesChanged.join(', ')}`
      : 'Completed successfully.';
    updateTask(task.id, { status: 'done', completedAt: Date.now(), result: summary });
  } else {
    updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: `Aider failed after retries. Last output: ${result.output.slice(-300)}` });
  }
  clearAgentAssignment('Forge');
}

// Unified tool execution returning structured results
interface ToolExecResult {
  result: string;
  newCwd?: string | null;
  done?: boolean;
  summary?: string;
  askUser?: string;
}

async function executeToolCallForMode(
  call: ToolCall,
  ctx: { taskId: string; subTaskId: string | null; cwd: string | null; pad: Scratchpad; previousShell: Map<string, string>; strReplaceFailures: Map<string, number> }
): Promise<ToolExecResult> {
  const { taskId, subTaskId, cwd, pad, previousShell, strReplaceFailures } = ctx;

  switch (call.name) {
    case 'codebase_map': {
      const dir = call.args.path || cwd || '/workspace';
      const map = await buildRepoFingerprint(dir);
      pad.keyFindings.push(`Mapped ${dir}`);
      return { result: map || '(empty workspace)' };
    }
    case 'repo_status': {
      const r = await getRepoStatusInContainer(call.args.path);
      return { result: truncateToolOutput((r.stdout + r.stderr) || '(no output)') };
    }
    case 'list_files': {
      const r = await listFilesInContainer(call.args.path, Number(call.args.max_depth ?? 3));
      return { result: truncateToolOutput((r.stdout + r.stderr) || '(empty)') };
    }
    case 'search_code': {
      const r = await searchCodeInContainer(call.args.path, call.args.pattern, call.args.glob);
      const out = truncateToolOutput((r.stdout + r.stderr) || '(no matches)');
      pad.keyFindings.push(`Searched "${call.args.pattern}": ${r.exitCode === 0 ? 'found' : 'none'}`);
      return { result: out };
    }
    case 'read_file': {
      const filePath = call.args.path;
      // Warn if reading a file the agent just created/edited recently
      if (pad.filesEdited.has(filePath) && !pad.filesRead.has(filePath)) {
        pad.filesRead.add(filePath);
        return { result: `NOTE: You just created/edited this file. You already know its contents. Only read if you need to verify.` };
      }
      const r = await readFileFromContainer(filePath, call.args.start_line, call.args.end_line);
      const out = truncateToolOutput(r.stdout || '(empty)');
      pad.filesRead.add(filePath);
      return { result: out + (out.includes('[...') ? '\nUse start_line/end_line for exact context.' : '') };
    }
    case 'str_replace_file': {
      const { file, old_str, new_str } = call.args;
      const failures = strReplaceFailures.get(file) ?? 0;
      if (failures >= MAX_STR_REPLACE_FAILURES_PER_FILE) {
        return { result: `BLOCKED: ${failures}x failures on ${file}. Use delete_block_file or insert_at_line.` };
      }
      const r = await strReplaceInContainer(file, old_str, new_str);
      if (r.exitCode === 0) { strReplaceFailures.delete(file); pad.filesEdited.add(file); }
      else { strReplaceFailures.set(file, failures + 1); }
      return { result: truncateToolOutput((r.stdout + r.stderr) || (r.exitCode === 0 ? 'OK' : 'FAILED')) };
    }
    case 'delete_block_file': {
      const r = await deleteBlockInContainer(call.args.file, call.args.start_anchor, call.args.end_anchor);
      if (r.exitCode === 0) pad.filesEdited.add(call.args.file);
      return { result: truncateToolOutput((r.stdout + r.stderr) || (r.exitCode === 0 ? 'OK' : 'FAILED')) };
    }
    case 'insert_at_line': {
      const r = await insertAtLineInContainer(call.args.file, call.args.line, call.args.text);
      if (r.exitCode === 0) pad.filesEdited.add(call.args.file);
      return { result: truncateToolOutput((r.stdout + r.stderr) || (r.exitCode === 0 ? 'OK' : 'FAILED')) };
    }
    case 'write_file': {
      const filePath = call.args.path;
      if (await pathExistsInContainer(filePath)) {
        return { result: `File exists. Use str_replace_file to edit.` };
      }
      const dir = filePath.split('/').slice(0, -1).join('/');
      if (dir) await execInContainer(`mkdir -p ${JSON.stringify(dir)}`);
      const b64 = Buffer.from(call.args.content, 'utf8').toString('base64');
      const r = await execInContainer(`echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(filePath)}`);
      if (r.exitCode === 0) pad.filesEdited.add(filePath);
      return { result: r.exitCode === 0 ? `Created: ${filePath}` : `Error: ${r.stderr}` };
    }
    case 'run_shell': {
      const { command } = call.args;
      if (isNoisyDiscoveryCommand(command)) {
        return { result: 'BLOCKED: Use list_files or search_code instead.' };
      }
      // Use Docker -w flag for cwd instead of cd prepending (avoids cd failures)
      const prior = previousShell.get(command);
      if (prior) {
        return { result: `Already ran. Result:\n${prior}\nDo not repeat.` };
      }
      const r = await execInContainer(command, 120000, cwd || '/workspace');
      const out = truncateToolOutput((r.stdout + r.stderr) || '(no output)');
      pad.commandsRun++;
      if (r.exitCode !== 0) pad.errors++;
      if (r.exitCode === 0) previousShell.set(command, out);
      const newCwd = maybeUpdateWorkingDirectory(cwd, command, r.exitCode);
      return { result: `Exit ${r.exitCode}\n${out}`, newCwd };
    }
    case 'multi_edit': {
      const ops = call.args.operations as Array<{ action: string; path: string; content?: string; old_str?: string }>;
      if (!ops || ops.length === 0) return { result: 'Error: no operations provided.' };
      const results: string[] = [];
      for (const op of ops.slice(0, 10)) { // Max 10 ops per call
        try {
          if (op.action === 'create') {
            if (await pathExistsInContainer(op.path)) {
              results.push(`SKIP ${op.path}: already exists (use edit)`);
              continue;
            }
            const dir = op.path.split('/').slice(0, -1).join('/');
            if (dir) await execInContainer(`mkdir -p ${JSON.stringify(dir)}`);
            const b64 = Buffer.from(op.content || '', 'utf8').toString('base64');
            const r = await execInContainer(`echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(op.path)}`);
            if (r.exitCode === 0) { pad.filesEdited.add(op.path); results.push(`OK created: ${op.path}`); }
            else results.push(`FAIL ${op.path}: ${r.stderr.slice(0, 80)}`);
          } else if (op.action === 'edit') {
            if (!op.old_str) { results.push(`SKIP ${op.path}: old_str required for edit`); continue; }
            const r = await strReplaceInContainer(op.path, op.old_str, op.content || '');
            if (r.exitCode === 0) { pad.filesEdited.add(op.path); results.push(`OK edited: ${op.path}`); }
            else results.push(`FAIL ${op.path}: ${(r.stdout + r.stderr).slice(0, 80)}`);
          } else if (op.action === 'delete') {
            await execInContainer(`rm -f ${JSON.stringify(op.path)}`);
            results.push(`OK deleted: ${op.path}`);
          }
        } catch (err: any) {
          results.push(`ERROR ${op.path}: ${err.message.slice(0, 60)}`);
        }
      }
      return { result: results.join('\n') };
    }
    case 'file_search': {
      const dir = call.args.path || cwd || '/workspace';
      const pattern = call.args.pattern;
      const r = await execInContainer(`find ${JSON.stringify(dir)} -maxdepth 5 -name ${JSON.stringify(pattern)} -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -30`);
      return { result: truncateToolOutput(r.stdout || '(no files found)') };
    }
    case 'semantic_search': {
      const dir = call.args.path || cwd || '/workspace';
      const query = call.args.query;
      // Extract key terms from natural language query for multi-pattern search
      const keywords = query.replace(/[^a-zA-Z0-9_\-\.]/g, ' ').split(/\s+/).filter((w: string) => w.length > 2 && !['the', 'and', 'for', 'how', 'where', 'what', 'this', 'that', 'with', 'from', 'are', 'was', 'has', 'have', 'been'].includes(w.toLowerCase()));
      const uniqueTerms = [...new Set(keywords)].slice(0, 5) as string[];
      const results: string[] = [];
      for (const term of uniqueTerms) {
        const r = await searchCodeInContainer(dir, term as string);
        if (r.exitCode === 0 && r.stdout.trim()) {
          results.push(`--- "${term}" ---\n${r.stdout.trim().split('\n').slice(0, 10).join('\n')}`);
        }
      }
      const out = results.length > 0 ? results.join('\n\n').slice(0, 6000) : '(no matches for any keywords)';
      pad.keyFindings.push(`Semantic search: "${query.slice(0, 40)}"`);
      return { result: out };
    }
    case 'get_errors': {
      const target = call.args.path || cwd || '/workspace';
      // Try TypeScript first, then eslint
      let r = await execInContainer(`cd ${JSON.stringify(target)} && npx tsc --noEmit 2>&1 | head -60`, 30000);
      if (r.exitCode !== 0 || r.stdout.includes('error TS')) {
        const out = truncateToolOutput(r.stdout || r.stderr || '(no output)', 8000);
        pad.errors++;
        return { result: `TypeScript errors:\n${out}` };
      }
      // If tsc not available or passes, try generic lint
      if (r.stdout.includes('not found') || r.stdout.includes('Cannot find')) {
        r = await execInContainer(`cd ${JSON.stringify(target)} && npx eslint . --max-warnings=0 2>&1 | head -40`, 30000);
        if (r.exitCode !== 0) {
          return { result: `Lint errors:\n${truncateToolOutput(r.stdout || r.stderr, 8000)}` };
        }
      }
      return { result: 'No errors found. Build passes.' };
    }
    case 'find_usages': {
      const { symbol, glob } = call.args;
      const dir = call.args.path || cwd || '/workspace';
      const globArg = glob ? `--glob "${glob}"` : '--glob "*.{ts,tsx,js,jsx,py,go,rs,java}"';
      const r = await execInContainer(`cd ${JSON.stringify(dir)} && rg -n --word-regexp ${JSON.stringify(symbol)} ${globArg} 2>&1 | head -50`);
      const out = (r.stdout + r.stderr).trim() || '(no usages found)';
      return { result: truncateToolOutput(out) };
    }
    case 'web_search': {
      try {
        const { tavily } = await import('tavily');
        const client = tavily({ apiKey: process.env.TAVILY_API_KEY || '' });
        const response = await client.search(call.args.query, { maxResults: 3 });
        const out = response.results.map((r: any) => `[${r.title}](${r.url})\n${r.content?.slice(0, 300) || ''}`).join('\n\n');
        return { result: out || '(no results)' };
      } catch (err: any) {
        // Fallback: if no API key or tavily fails
        return { result: `Web search unavailable: ${err.message}. Try using run_shell with curl for direct URL fetches.` };
      }
    }
    case 'agent_memory': {
      const { action, key, content } = call.args;
      switch (action) {
        case 'read': {
          if (!key) return { result: 'Error: key required for read.' };
          const val = getAgentKnowledge(key);
          return { result: val ?? `(no memory stored for "${key}")` };
        }
        case 'write': {
          if (!key || !content) return { result: 'Error: key and content required for write.' };
          setAgentKnowledge(key, content);
          return { result: `Stored: "${key}"` };
        }
        case 'list': {
          const items = listAgentKnowledge();
          if (items.length === 0) return { result: '(no memories stored)' };
          return { result: items.map(i => `- ${i.key}: ${i.content.slice(0, 80)}...`).join('\n') };
        }
        case 'delete': {
          if (!key) return { result: 'Error: key required for delete.' };
          const ok = deleteAgentKnowledge(key);
          return { result: ok ? `Deleted: "${key}"` : `Not found: "${key}"` };
        }
        default:
          return { result: 'Invalid action. Use: read, write, list, delete.' };
      }
    }
    case 'ask_user': {
      return { result: 'Waiting for input...', askUser: call.args.question };
    }
    case 'task_done': {
      return { result: 'Complete.', done: true, summary: call.args.summary };
    }
    default:
      return { result: `Unknown tool: ${call.name}` };
  }
}
export async function runOrchestrator(task: Task): Promise<void> {
  try {
    const totalStepBudget = MAX_TOTAL_AGENT_STEPS;
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
    name: 'codebase_map',
    description: 'Get instant codebase orientation: directory tree, package manifest, repo instructions. Call FIRST when starting work on a new repo instead of manual exploration.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Root directory to map, default /workspace' } },
      required: []
    }
  },
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
    name: 'multi_edit',
    description: 'Apply MULTIPLE file operations in a single call. Use this to create several files at once, or make edits across multiple files. Much faster than calling write_file/str_replace_file one at a time.',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description: 'Array of file operations to perform',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: '"create" | "edit" | "delete"' },
              path: { type: 'string', description: 'Absolute file path' },
              content: { type: 'string', description: 'Full content for "create", or new_str for "edit"' },
              old_str: { type: 'string', description: 'For "edit" only: exact text to replace' }
            }
          }
        }
      },
      required: ['operations']
    }
  },
  {
    name: 'file_search',
    description: 'Find files by name or glob pattern. Use when you know the filename but not the path (e.g. "find all *.test.ts files" or "where is package.json").',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Filename or glob pattern to search for (e.g. "*.tsx", "package.json", "App.*")' },
        path: { type: 'string', description: 'Directory to search in, default /workspace' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'semantic_search',
    description: 'Search the codebase by meaning/intent. Use when you are not sure of exact words. Extracts keywords from your query and searches across multiple patterns. Better than search_code for exploratory searches.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language description of what you are looking for (e.g. "where is the authentication middleware defined")' },
        path: { type: 'string', description: 'Directory to search in, default /workspace' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_errors',
    description: 'Get compile/lint errors for the project or a specific file. Run this AFTER every edit to verify your changes compile. Returns structured diagnostics (file, line, message).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project root or specific file to check. Default: inferred from cwd.' }
      },
      required: []
    }
  },
  {
    name: 'find_usages',
    description: 'Find all references/usages of a symbol (function, class, variable) across the codebase. Use BEFORE renaming or deleting anything to understand impact.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact symbol name to find (e.g. "handleSubmit", "UserService")' },
        path: { type: 'string', description: 'Directory to search in, default /workspace' },
        glob: { type: 'string', description: 'Optional file glob to narrow search (e.g. "*.ts")' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'web_search',
    description: 'Search the web for documentation, API references, or solutions. Use when you need external information (library docs, error solutions, API specs).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    }
  },
  {
    name: 'agent_memory',
    description: 'Persistent memory across tasks. Store/retrieve patterns, conventions, project facts you learn. Use "read" to check what you already know. Use "write" to save new insights.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '"read" | "write" | "list" | "delete"' },
        key: { type: 'string', description: 'Memory key (e.g. "project-conventions", "build-commands", "common-patterns")' },
        content: { type: 'string', description: 'Content to store (required for "write")' }
      },
      required: ['action']
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
  updateSubTask(subTask.id, { status: 'running', startedAt: Date.now(), assignedAgent, error: undefined });
  setAgentPhase(assignedAgent, 'working', {
    currentTaskId: task.id, currentTaskGoal: task.goal,
    currentSubTaskId: subTask.id, currentSubTaskTitle: subTask.title, note: subTask.description,
  });

  await ensureWorkspaceReady();
  await syncRuntimeSecretsToContainer();

  const repoRoot = await resolveKnownRepoRoot(task, subTask);
  const workDir = repoRoot || '/workspace';

  // Build goal with full context for Aider
  const aiderGoal = [
    `Task: ${subTask.title}`,
    subTask.description,
    subTask.successCriteria.length > 0 ? `Success Criteria: ${subTask.successCriteria.join('; ')}` : '',
    `Parent goal: ${task.goal}`,
  ].filter(Boolean).join('\n');

  // Delegate to Aider
  const result = await executeWithAider(aiderGoal, workDir, task.id, subTask.id, 3);

  if (isTaskCancelled(task.id) || isSubTaskCancelled(subTask.id)) {
    clearAgentAssignment(assignedAgent);
    return;
  }

  if (result.success) {
    // Build verification
    const buildCheck = await runBuildVerification(workDir);
    if (!buildCheck.passed) {
      // One more attempt with build errors
      const fixResult = await executeWithAider(
        `${aiderGoal}\n\nBUILD FAILED after your changes. Fix:\n${buildCheck.output}`,
        workDir, task.id, subTask.id, 1
      );
      if (!fixResult.success || !(await runBuildVerification(workDir)).passed) {
        updateSubTask(subTask.id, { status: 'failed', completedAt: Date.now(), error: 'Build failing after Aider edits.' });
        clearAgentAssignment(assignedAgent);
        return;
      }
    }

    const summary = result.filesChanged.length > 0
      ? `Completed ${subTask.title}. Files: ${result.filesChanged.join(', ')}`
      : `Completed ${subTask.title}.`;
    updateSubTask(subTask.id, { status: 'done', completedAt: Date.now(), result: summary });
  } else {
    updateSubTask(subTask.id, { status: 'failed', completedAt: Date.now(), error: `Aider failed: ${result.output.slice(-200)}` });
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
    
    if (subTasks.length + newSubTasks.length > MAX_INITIAL_SUBTASKS * 2) {
      throw new Error(`Replanning would exceed subtask limit. Current: ${subTasks.length}, New: ${newSubTasks.length}`);
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
    if (currentDepth > 3) {
      throw new Error(`Replanning exceeded max DAG depth (3). Current: ${currentDepth}`);
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

