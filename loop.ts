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
import { 
  saveMemory, updateTask, getTask, getMemoryForTask, 
  createSubTask, updateSubTask, getSubTasksForTask, getSubTask,
  createArtifact, getArtifactsForTask, createReflection,
  getMemoryForSubTask, incrementTaskIterations
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

// ── Configuration ────────────────────────────────────────────────────────────

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_ITERATIONS_PER_SUBTASK = parsePositiveIntEnv('MAX_ITERATIONS_PER_SUBTASK', 60);
const MAX_ITERATIONS_TOOL_MODE = parsePositiveIntEnv('MAX_ITERATIONS_TOOL_MODE', 50);
const MAX_TOTAL_AGENT_STEPS = parsePositiveIntEnv('MAX_TOTAL_AGENT_STEPS', 250);
const MAX_SUBTASK_RETRIES = 3;
const CONCURRENT_WORKERS = 2;
const MAX_INITIAL_SUBTASKS = 8;
const MAX_REPLAN_ATTEMPTS = 2;
const MAX_RETRIES_PER_TASK = 2;
const MAX_NO_PROGRESS = 4;
const SUMMARIZE_EVERY = 8; // Summarize context every N steps
const MAX_TOOL_OUTPUT_CHARS = 4000; // Tight output limit
const MAX_STR_REPLACE_FAILURES_PER_FILE = 2;

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function truncateToolOutput(output: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
  if (output.length <= limit) return output;
  const half = Math.floor(limit / 2);
  return output.slice(0, half) + `\n\n[... ${output.length - limit} chars omitted ...]\n\n` + output.slice(-half);
}

function cleanJsonResponse(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
}

// ── Native Gemini Content Builder ────────────────────────────────────────────
// Instead of flattening everything to text, we build proper multi-turn
// conversations with functionCall/functionResponse parts.

function userText(content: string): GeminiContent {
  return { role: 'user', parts: [{ text: content }] };
}

function modelText(content: string): GeminiContent {
  return { role: 'model', parts: [{ text: content }] };
}

function modelToolCalls(calls: ToolCall[], thought?: string): GeminiContent {
  const parts: GeminiPart[] = [];
  if (thought) parts.push({ text: thought });
  for (const call of calls) {
    parts.push({ functionCall: { name: call.name, args: call.args } });
  }
  return { role: 'model', parts };
}

function toolResults(results: { name: string; result: string }[]): GeminiContent {
  return {
    role: 'user',
    parts: results.map(r => ({
      functionResponse: { name: r.name, response: { result: r.result } }
    })),
  };
}

// ── Context Scratchpad ───────────────────────────────────────────────────────
// Maintains a running summary of what the agent knows, preventing re-exploration.

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

function scratchpadToText(pad: Scratchpad): string {
  const lines: string[] = ['## Working Memory (do NOT re-read these files)'];
  if (pad.filesRead.size > 0) lines.push('Files read: ' + [...pad.filesRead].slice(-20).join(', '));
  if (pad.filesEdited.size > 0) lines.push('Files edited: ' + [...pad.filesEdited].join(', '));
  lines.push(`Commands: ${pad.commandsRun} | Errors: ${pad.errors}`);
  if (pad.keyFindings.length > 0) lines.push('Key findings:\n- ' + pad.keyFindings.slice(-8).join('\n- '));
  return lines.join('\n');
}

function summarizeAndCompact(
  history: GeminiContent[],
  pad: Scratchpad,
  keepRecent: number = 6,
): GeminiContent[] {
  if (history.length <= keepRecent + 2) return history;
  const summary = scratchpadToText(pad);
  const recent = history.slice(-keepRecent);
  return [userText(summary), ...recent];
}

// ── Workspace Discovery ──────────────────────────────────────────────────────

function extractGithubRepoName(goal: string): string | null {
  const match = goal.match(/github\.com\/[^/\s]+\/([^/\s;?#]+?)(?:\.git)?(?:[/?#]|\s|$)/i);
  return match?.[1] ?? null;
}

async function resolveKnownRepoRoot(task: Task, subTask?: SubTask): Promise<string | null> {
  const candidates = new Set<string>();
  const repoName = extractGithubRepoName(task.goal);
  if (repoName) candidates.add(`/workspace/${repoName}`);

  for (const scope of subTask?.workspaceScope ?? []) {
    const trimmed = scope.trim().replace(/^\.?\//, '');
    if (!trimmed) continue;
    const topLevel = trimmed.split('/')[0];
    if (topLevel) candidates.add(`/workspace/${topLevel}`);
  }

  for (const candidate of candidates) {
    if (await pathExistsInContainer(candidate)) return candidate;
  }
  return null;
}

async function buildCodebaseMap(repoRoot: string): Promise<string> {
  const parts: string[] = [`## Codebase Map: ${repoRoot}`];

  // Package manifest
  for (const manifest of ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']) {
    const r = await readFileFromContainer(`${repoRoot}/${manifest}`);
    if (r.exitCode === 0 && r.stdout.trim()) {
      parts.push(`### ${manifest}\n${r.stdout.slice(0, 600)}`);
      break;
    }
  }

  // Directory tree (compact)
  const tree = await listFilesInContainer(repoRoot, 2);
  if (tree.stdout) parts.push(`### Structure\n${tree.stdout.slice(0, 1200)}`);

  // Agent instructions
  for (const guide of ['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'CONTRIBUTING.md']) {
    const r = await readFileFromContainer(`${repoRoot}/${guide}`);
    if (r.exitCode === 0 && r.stdout.trim()) {
      parts.push(`### ${guide}\n${r.stdout.slice(0, 800)}`);
      break;
    }
  }

  return parts.join('\n\n');
}

// ── Routing ──────────────────────────────────────────────────────────────────

function heuristicRouteTask(goal: string): Task['mode'] | null {
  const text = goal.trim().toLowerCase();
  if (!text) return 'chat';

  const isQuestion = text.endsWith('?') || /^(what|why|how|who|when|where|explain)\b/.test(text);
  if (isQuestion && !/(build|implement|create|edit|fix|run|write)\b/.test(text)) return 'chat';

  if (/(build|create|implement|multi-step|full-stack|architecture|workflow)\b/.test(text) &&
      /(app|project|system|service|dashboard|platform)\b/.test(text)) return 'autonomous_dag';

  const wordCount = text.split(/\s+/).length;
  if (wordCount < 50 && /(fix|update|change|edit|add|remove|refactor|debug|run|test)\b/.test(text)) return 'tool';
  if (wordCount > 40) return 'autonomous_dag';

  return null;
}

function chooseAgentMode(goal: string, mode: Task['mode'] | null): AgentMode {
  return mode === 'autonomous_dag' ? 'RESEARCH' : 'FAST';
}

// ── Shell Safety ─────────────────────────────────────────────────────────────

const SAFE_COMMANDS = [
  /^git /, /^npm /, /^node /, /^npx /, /^yarn /, /^pnpm /,
  /^cat /, /^ls /, /^find /, /^rg /, /^grep /, /^wc /,
  /^mkdir /, /^cp /, /^mv /, /^touch /, /^echo /,
  /^tsc /, /^eslint /, /^prettier /, /^jest /, /^vitest /,
  /^python3? /, /^pip3? /, /^cargo /, /^go /,
  /^cd /, /^pwd /, /^which /, /^env /, /^export /,
  /^curl /, /^wget /,
];

function isObviouslySafe(command: string): boolean {
  return SAFE_COMMANDS.some((p) => p.test(command.trim()));
}

function isNoisyDiscoveryCommand(command: string): boolean {
  const n = command.trim().toLowerCase();
  return n === 'ls -r' || n === 'ls -rf' || n.startsWith('ls -r ');
}

function applyWorkingDirectory(command: string, cwd: string | null): string {
  if (!cwd || command.trim().startsWith('cd ')) return command;
  return `cd ${JSON.stringify(cwd)} && ${command}`;
}

function maybeUpdateCwd(cwd: string | null, command: string, exitCode: number): string | null {
  if (exitCode !== 0) return cwd;
  const match = command.match(/^\s*cd\s+(".*?"|'.*?'|[^\s;&|]+)\s*(?:&&|$)/);
  if (!match) return cwd;
  let next = match[1]?.replace(/^['"]|['"]$/g, '') ?? '';
  if (!next) return cwd;
  if (next.startsWith('/')) return path.posix.normalize(next);
  return path.posix.normalize(path.posix.join(cwd || '/workspace', next));
}

// ── Tool Dispatch ────────────────────────────────────────────────────────────
// Executes tool calls and returns structured results for the native protocol.

async function executeToolCall(
  call: ToolCall,
  ctx: {
    taskId: string;
    subTaskId: string | null;
    cwd: string | null;
    pad: Scratchpad;
    previousShell: Map<string, string>;
    strReplaceFailures: Map<string, number>;
  }
): Promise<{ result: string; newCwd?: string | null; done?: boolean; doneResult?: string; askUser?: string }> {

  const { taskId, subTaskId, cwd, pad, previousShell, strReplaceFailures } = ctx;

  switch (call.name) {
    case 'codebase_map': {
      const dir = call.args.path || '/workspace';
      const map = await buildCodebaseMap(dir);
      pad.keyFindings.push(`Mapped codebase at ${dir}`);
      return { result: map };
    }

    case 'repo_status': {
      const p = call.args.path;
      const r = await getRepoStatusInContainer(p);
      const out = truncateToolOutput((r.stdout + r.stderr) || '(no output)');
      return { result: `Exit ${r.exitCode}\n${out}` };
    }

    case 'list_files': {
      const { path: p, max_depth } = call.args;
      const r = await listFilesInContainer(p, Number(max_depth ?? 3));
      const out = truncateToolOutput((r.stdout + r.stderr) || '(empty)');
      return { result: `Exit ${r.exitCode}\n${out}` };
    }

    case 'search_code': {
      const { path: p, pattern, glob } = call.args;
      const r = await searchCodeInContainer(p, pattern, glob);
      const out = truncateToolOutput((r.stdout + r.stderr) || '(no matches)');
      pad.keyFindings.push(`Searched "${pattern}" in ${p}: ${r.exitCode === 0 ? 'found' : 'no match'}`);
      return { result: `Exit ${r.exitCode}\n${out}` };
    }

    case 'read_file': {
      const { path: p, start_line, end_line } = call.args;
      const r = await readFileFromContainer(p, start_line, end_line);
      const out = truncateToolOutput(r.stdout || '(empty file)');
      pad.filesRead.add(p);
      const warning = out.includes('[... ') ? '\nUse start_line/end_line for exact context.' : '';
      return { result: out + warning };
    }

    case 'str_replace_file': {
      const { file, old_str, new_str } = call.args;
      const failures = strReplaceFailures.get(file) ?? 0;
      if (failures >= MAX_STR_REPLACE_FAILURES_PER_FILE) {
        return { result: `BLOCKED: str_replace failed ${failures}x on ${file}. Use delete_block_file or insert_at_line instead.` };
      }
      const r = await strReplaceInContainer(file, old_str, new_str);
      const out = truncateToolOutput((r.stdout + r.stderr) || '(no output)');
      if (r.exitCode === 0) {
        strReplaceFailures.delete(file);
        pad.filesEdited.add(file);
      } else {
        strReplaceFailures.set(file, failures + 1);
      }
      return { result: `Exit ${r.exitCode}\n${out}` };
    }

    case 'delete_block_file': {
      const { file, start_anchor, end_anchor } = call.args;
      const r = await deleteBlockInContainer(file, start_anchor, end_anchor);
      const out = truncateToolOutput((r.stdout + r.stderr) || '(no output)');
      if (r.exitCode === 0) pad.filesEdited.add(file);
      return { result: `Exit ${r.exitCode}\n${out}` };
    }

    case 'insert_at_line': {
      const { file, line, text } = call.args;
      const r = await insertAtLineInContainer(file, line, text);
      const out = truncateToolOutput((r.stdout + r.stderr) || '(no output)');
      if (r.exitCode === 0) pad.filesEdited.add(file);
      return { result: `Exit ${r.exitCode}\n${out}` };
    }

    case 'write_file': {
      const { path: filePath, content } = call.args;
      if (await pathExistsInContainer(filePath)) {
        return { result: `File ${filePath} already exists. Use str_replace_file to edit.` };
      }
      const dir = filePath.split('/').slice(0, -1).join('/');
      if (dir) await execInContainer(`mkdir -p ${JSON.stringify(dir)}`);
      const b64 = Buffer.from(content, 'utf8').toString('base64');
      const r = await execInContainer(`echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(filePath)}`);
      if (r.exitCode === 0) pad.filesEdited.add(filePath);
      return { result: r.exitCode === 0 ? `Created: ${filePath}` : `Error: ${r.stderr}` };
    }

    case 'run_shell': {
      const { command } = call.args;
      if (isNoisyDiscoveryCommand(command)) {
        return { result: 'BLOCKED: Use list_files or search_code instead of recursive ls.' };
      }
      if (!isObviouslySafe(command)) {
        // Allow most commands but block obviously destructive ones
        if (/\brm\s+(-rf?|--force)\s+\/(?!workspace)/.test(command)) {
          return { result: 'BLOCKED: Dangerous command. Use safe alternatives.' };
        }
      }

      const effective = applyWorkingDirectory(command, cwd);
      const prior = previousShell.get(effective);
      if (prior) {
        return { result: `Already ran this command. Previous result:\n${prior}\nDo not repeat. Use the result above.` };
      }

      const r = await execInContainer(effective);
      const out = truncateToolOutput((r.stdout + r.stderr) || '(no output)');
      pad.commandsRun++;
      if (r.exitCode !== 0) pad.errors++;
      if (r.exitCode === 0) previousShell.set(effective, out);

      const newCwd = maybeUpdateCwd(cwd, command, r.exitCode);
      return { result: `Exit ${r.exitCode}\n${out}`, newCwd };
    }

    case 'ask_user': {
      return { result: 'Waiting for user input...', askUser: call.args.question };
    }

    case 'task_done': {
      return { result: 'Task marked complete.', done: true, doneResult: call.args.summary };
    }

    default:
      return { result: `Unknown tool: ${call.name}` };
  }
}

// ── Build Verification ───────────────────────────────────────────────────────

async function runBuildVerification(repoRoot: string): Promise<{ passed: boolean; output: string }> {
  // Check for package.json scripts
  const pkg = await readFileFromContainer(`${repoRoot}/package.json`);
  if (pkg.exitCode !== 0) return { passed: true, output: '' };

  let buildCmd = '';
  try {
    const parsed = JSON.parse(pkg.stdout);
    if (parsed.scripts?.build) buildCmd = 'npm run build';
    else if (parsed.scripts?.typecheck) buildCmd = 'npm run typecheck';
    else if (parsed.scripts?.lint) buildCmd = 'npm run lint';
  } catch { return { passed: true, output: '' }; }

  if (!buildCmd) return { passed: true, output: '' };

  const result = await execInContainer(`cd ${JSON.stringify(repoRoot)} && ${buildCmd}`, 90000);
  if (result.exitCode === 0) return { passed: true, output: '' };

  // Check if it's a dependency issue (not our fault)
  const output = (result.stdout + result.stderr).toLowerCase();
  if (output.includes('cannot find module') && output.includes('node_modules')) {
    return { passed: true, output: '' }; // Skip env issues
  }

  return { passed: false, output: truncateToolOutput(result.stdout + result.stderr) };
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

const WORKER_TOOLS: ToolDefinition[] = [
  {
    name: 'codebase_map',
    description: 'Get instant orientation: directory tree, package manifest, and repo instructions. Call this FIRST when starting work on a new codebase instead of exploring manually.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Root directory, default /workspace' } }, required: [] }
  },
  {
    name: 'search_code',
    description: 'Search for text/regex in files using ripgrep. Use this to find implementations, usages, and definitions. Fastest way to locate code.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory to search' }, pattern: { type: 'string', description: 'Search pattern (regex)' }, glob: { type: 'string', description: 'File glob filter like *.ts' } }, required: ['path', 'pattern'] }
  },
  {
    name: 'read_file',
    description: 'Read file contents. For large files, use start_line/end_line to read only the section you need for editing.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute file path' }, start_line: { type: 'number', description: '1-based start line' }, end_line: { type: 'number', description: '1-based end line' } }, required: ['path'] }
  },
  {
    name: 'str_replace_file',
    description: 'Surgically edit a file by replacing exact text. old_str must appear EXACTLY ONCE. Include 2-3 context lines to ensure uniqueness. NEVER rewrite entire files.',
    parameters: { type: 'object', properties: { file: { type: 'string' }, old_str: { type: 'string', description: 'Exact current text (must be unique in file)' }, new_str: { type: 'string', description: 'Replacement text' } }, required: ['file', 'old_str', 'new_str'] }
  },
  {
    name: 'write_file',
    description: 'Create a NEW file. Only for files that do not exist yet.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
  },
  {
    name: 'delete_block_file',
    description: 'Delete a contiguous block from a file using start/end anchor text.',
    parameters: { type: 'object', properties: { file: { type: 'string' }, start_anchor: { type: 'string' }, end_anchor: { type: 'string' } }, required: ['file', 'start_anchor', 'end_anchor'] }
  },
  {
    name: 'insert_at_line',
    description: 'Insert text at a specific line number in an existing file.',
    parameters: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, text: { type: 'string' } }, required: ['file', 'line', 'text'] }
  },
  {
    name: 'run_shell',
    description: 'Run a bash command. Use for: git, npm, tests, builds. Do NOT use for file editing.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
  },
  {
    name: 'repo_status',
    description: 'Get git status of a repository (branch, changes, etc).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'list_files',
    description: 'List directory contents with limited depth. Use codebase_map for initial exploration instead.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, max_depth: { type: 'number' } }, required: ['path'] }
  },
  {
    name: 'ask_user',
    description: 'Ask user a question. Only when genuinely blocked.',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] }
  },
  {
    name: 'task_done',
    description: 'Mark task complete. Only call after verifying the work (build passes, tests pass).',
    parameters: { type: 'object', properties: { summary: { type: 'string' }, artifacts: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, content: { type: 'string' } } } } }, required: ['summary'] }
  }
];

// ── Main Execution Loop (Tool Mode) ─────────────────────────────────────────

async function runToolLoop(
  task: Task,
  subTask: SubTask | null,
  systemPrompt: string,
  goalMessage: string,
  maxIterations: number,
): Promise<void> {
  const taskId = task.id;
  const subTaskId = subTask?.id ?? null;
  const assignedAgent = subTask ? (subTask.assignedAgent || 'Forge') : 'Forge';

  await ensureWorkspaceReady();
  await syncRuntimeSecretsToContainer();

  const preinstalled = await getPreinstalledPackages();
  const repoRoot = await resolveKnownRepoRoot(task, subTask ?? undefined);
  let cwd: string | null = repoRoot;

  // Build initial context efficiently
  const history: GeminiContent[] = [];
  const pad = newScratchpad();
  const previousShell = new Map<string, string>();
  const strReplaceFailures = new Map<string, number>();

  // Inject environment + codebase map upfront (saves 3-5 exploration steps)
  const envLines = [
    '## Environment (pre-installed, do NOT reinstall):',
    `Node: ${preinstalled.npm.join(', ')}`,
    `Python: ${preinstalled.pip.join(', ')}`,
  ];
  if (repoRoot) {
    const map = await buildCodebaseMap(repoRoot);
    envLines.push('', map);
    pad.keyFindings.push(`Codebase mapped at ${repoRoot}`);
  }
  envLines.push('', goalMessage);

  history.push(userText(envLines.join('\n')));

  let lastProcessedInputTime = (subTask?.createdAt ?? task.createdAt) - 1;
  let consecutiveNoProgress = 0;
  let lastToolSig = '';

  for (let i = 1; i <= maxIterations; i++) {
    if (isTaskCancelled(taskId) || (subTaskId && isSubTaskCancelled(subTaskId))) {
      clearAgentAssignment(assignedAgent);
      return;
    }

    // Aggressive context compaction
    if (i > 1 && i % SUMMARIZE_EVERY === 0) {
      history.splice(0, history.length, ...summarizeAndCompact(history, pad));
    }

    incrementTaskIterations(taskId);
    const currentTask = getTask(taskId);
    if (currentTask) {
      const steps = (currentTask.totalAgentSteps || 0) + 1;
      updateTask(taskId, { totalAgentSteps: steps });
      if (steps > MAX_TOTAL_AGENT_STEPS) {
        const msg = `Step budget exhausted (${MAX_TOTAL_AGENT_STEPS}).`;
        if (subTask) updateSubTask(subTaskId!, { status: 'failed', completedAt: Date.now(), error: msg });
        else updateTask(taskId, { status: 'failed', completedAt: Date.now(), error: msg });
        clearAgentAssignment(assignedAgent);
        return;
      }
    }

    // Inject user input if any
    const memEntries = subTaskId ? getMemoryForSubTask(subTaskId) : getMemoryForTask(taskId);
    const newInputs = memEntries.filter(m => m.type === 'input' && m.createdAt > lastProcessedInputTime);
    for (const input of newInputs) {
      history.push(userText(`USER INPUT: ${input.content}`));
      lastProcessedInputTime = Math.max(lastProcessedInputTime, input.createdAt);
    }

    // Call LLM with native tool protocol
    let response;
    try {
      response = await callLLMWithTools(systemPrompt, history, WORKER_TOOLS);
    } catch (err: any) {
      saveMemory(taskId, 'error', `LLM error: ${err.message}`, subTaskId, 'working');
      continue;
    }

    const { thought, toolCalls } = response;

    // Progress detection
    const toolSig = toolCalls.map(c => `${c.name}:${JSON.stringify(c.args)}`).join('|');
    if (toolSig === lastToolSig && toolSig !== '') {
      consecutiveNoProgress++;
    } else {
      consecutiveNoProgress = 0;
    }
    lastToolSig = toolSig;

    if (consecutiveNoProgress >= MAX_NO_PROGRESS) {
      const msg = `Stalled: repeating same action for ${MAX_NO_PROGRESS} steps.`;
      saveMemory(taskId, 'error', msg, subTaskId, 'working');
      if (subTask) updateSubTask(subTaskId!, { status: 'failed', completedAt: Date.now(), error: msg });
      else updateTask(taskId, { status: 'failed', completedAt: Date.now(), error: msg });
      clearAgentAssignment(assignedAgent);
      return;
    }

    if (thought) {
      console.log(`[Agent] Step ${i}: ${thought.slice(0, 100)}`);
    }

    // No tool calls = model just wants to think. Nudge it.
    if (toolCalls.length === 0) {
      history.push(modelText(thought || '(thinking)'));
      history.push(userText('Call a tool to proceed. If done, call task_done.'));
      continue;
    }

    // Execute all tool calls in parallel
    console.log(`[Agent] Step ${i}: ${toolCalls.length} tool(s): ${toolCalls.map(c => c.name).join(', ')}`);

    const execResults = await Promise.all(
      toolCalls.map(call => executeToolCall(call, {
        taskId, subTaskId, cwd, pad, previousShell, strReplaceFailures,
      }))
    );

    // Check for terminal actions (task_done, ask_user)
    for (let j = 0; j < execResults.length; j++) {
      const r = execResults[j];
      if (r.newCwd !== undefined) cwd = r.newCwd;

      if (r.done) {
        // Build verification
        if (cwd || repoRoot) {
          const buildCheck = await runBuildVerification(cwd || repoRoot!);
          if (!buildCheck.passed) {
            // Don't finish - push build failure and continue
            history.push(modelToolCalls(toolCalls, thought));
            history.push(toolResults(execResults.map((er, k) => ({
              name: toolCalls[k].name,
              result: k === j ? `Build failed. Fix before completing:\n${buildCheck.output}` : er.result,
            }))));
            break;
          }
        }

        if (subTask) {
          const { artifacts: arts = [] } = toolCalls[j].args;
          for (const art of arts) {
            createArtifact({ taskId, name: art.name, type: art.type || 'unknown', content: art.content || '', producerSubTaskId: subTaskId! });
          }
          if (!isSubTaskCancelled(subTaskId!)) {
            updateSubTask(subTaskId!, { status: 'done', completedAt: Date.now(), result: r.doneResult });
          }
        } else {
          if (!isTaskCancelled(taskId)) {
            updateTask(taskId, { status: 'done', completedAt: Date.now(), result: r.doneResult || 'Completed.' });
          }
        }
        clearAgentAssignment(assignedAgent);
        return;
      }

      if (r.askUser) {
        saveMemory(taskId, 'thought', `WAITING: ${r.askUser}`, subTaskId, 'working');
        if (subTask) {
          updateSubTask(subTaskId!, { status: 'waiting_for_human' });
          await waitForUserInput(taskId, subTaskId, lastProcessedInputTime);
          updateSubTask(subTaskId!, { status: 'running' });
        } else {
          await waitForUserInput(taskId, null, lastProcessedInputTime);
        }
        i--;
        break;
      }
    }

    // Add to history using native protocol
    history.push(modelToolCalls(toolCalls, thought));
    history.push(toolResults(execResults.map((r, k) => ({
      name: toolCalls[k].name,
      result: r.result,
    }))));

    // Save memory (lightweight)
    if (thought) saveMemory(taskId, 'thought', thought.slice(0, 300), subTaskId, 'working');
  }

  // Budget exhausted
  const msg = `Iteration limit reached (${maxIterations}).`;
  if (subTask) updateSubTask(subTaskId!, { status: 'failed', completedAt: Date.now(), error: msg });
  else updateTask(taskId, { status: 'failed', completedAt: Date.now(), error: msg });
  clearAgentAssignment(assignedAgent);
}

async function waitForUserInput(taskId: string, subTaskId: string | null, lastTime: number): Promise<number> {
  while (true) {
    if (isTaskCancelled(taskId) || (subTaskId && isSubTaskCancelled(subTaskId))) {
      throw new Error('Task cancelled by user');
    }
    await sleep(2000);
    const entries = subTaskId ? getMemoryForSubTask(subTaskId) : getMemoryForTask(taskId);
    const newInputs = entries.filter((m) => m.type === 'input' && m.createdAt > lastTime);
    if (newInputs.length > 0) return lastTime;
  }
}

// ── Public Entry Points ──────────────────────────────────────────────────────

export async function processTask(task: Task): Promise<void> {
  try {
    let currentTask = getTask(task.id) || task;
    if (currentTask.status === 'cancelled') return;

    if (!currentTask.mode) {
      const mode = heuristicRouteTask(currentTask.goal) || 'tool';
      updateTask(currentTask.id, { mode, agentMode: chooseAgentMode(currentTask.goal, mode) });
      currentTask = getTask(currentTask.id)!;
    }

    console.log(`[Execution] Mode: ${currentTask.mode} | Goal: ${currentTask.goal}`);

    switch (currentTask.mode) {
      case 'chat': await runChatMode(currentTask); break;
      case 'tool': await runToolMode(currentTask); break;
      case 'autonomous_dag': await runOrchestrator(currentTask); break;
      default:
        updateTask(currentTask.id, { status: 'failed', error: `Unknown mode: ${currentTask.mode}` });
    }
  } catch (err: any) {
    console.error('[Execution] Fatal:', err);
    updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: err.message || 'Fatal error' });
  }
}

export async function runAutonomousLoop(task: Task): Promise<void> {
  await processTask(task);
}

// ── Chat Mode ────────────────────────────────────────────────────────────────

async function runChatMode(task: Task) {
  updateTask(task.id, { status: 'running', startedAt: Date.now() });
  const systemPrompt = getSystemPrompt('chat', { task });
  const response = await callLLM(systemPrompt, task.goal, 'text/plain');
  if (!isTaskCancelled(task.id)) {
    saveMemory(task.id, 'output', response, null, 'working');
    updateTask(task.id, { status: 'done', completedAt: Date.now(), result: response });
  }
  clearAgentAssignment('Forge');
}

// ── Tool Mode ────────────────────────────────────────────────────────────────

async function runToolMode(task: Task) {
  updateTask(task.id, { status: 'running', startedAt: Date.now() });
  setAgentPhase('Forge', 'working', { currentTaskId: task.id, currentTaskGoal: task.goal, note: 'Tool mode' });
  const systemPrompt = getSystemPrompt('standalone_worker', { task });
  await runToolLoop(task, null, systemPrompt, task.goal, MAX_ITERATIONS_TOOL_MODE);
}

// ── Orchestrator (DAG Mode) ──────────────────────────────────────────────────

export async function runOrchestrator(task: Task): Promise<void> {
  try {
    console.log(`\n[Orchestrator] Starting: ${task.goal}`);
    updateTask(task.id, { status: 'running', startedAt: Date.now(), replanCount: 0, totalAgentSteps: 0 });
    setAgentPhase('Forge', 'planning', { currentTaskId: task.id, currentTaskGoal: task.goal, note: 'Planning' });
    await ensureWorkspaceReady();

    await planTask(task);

    let completed = false;
    const activeSubTasks = new Set<string>();

    while (!completed) {
      const currentTask = getTask(task.id)!;
      if (currentTask.status === 'cancelled') return;

      if ((currentTask.totalAgentSteps || 0) >= MAX_TOTAL_AGENT_STEPS) {
        updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: `Budget exceeded (${MAX_TOTAL_AGENT_STEPS} steps).` });
        return;
      }

      const subTasks = getSubTasksForTask(task.id);
      const unblocked = subTasks.filter(st =>
        ['pending', 'blocked'].includes(st.status) &&
        !activeSubTasks.has(st.id) &&
        st.dependencies.every(depId => subTasks.find(s => s.id === depId)?.status === 'done')
      );

      if (unblocked.length === 0 && activeSubTasks.size === 0) {
        if (subTasks.every(st => st.status === 'done')) { completed = true; break; }
        if ((currentTask.replanCount || 0) >= MAX_REPLAN_ATTEMPTS) {
          updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: 'Max replans reached.' });
          return;
        }
        await reflectAndReplan(task);
        updateTask(task.id, { replanCount: (currentTask.replanCount || 0) + 1 });
        continue;
      }

      const toDispatch = unblocked.slice(0, CONCURRENT_WORKERS - activeSubTasks.size);
      for (const subTask of toDispatch) {
        const lockResult = tryAcquireWorkspaceLocks(subTask.id, subTask.lockedPaths.length > 0 ? subTask.lockedPaths : subTask.workspaceScope);
        if (!lockResult.ok) {
          updateSubTask(subTask.id, { status: 'blocked', error: `Waiting for locks` });
          continue;
        }
        if (subTask.status === 'blocked') updateSubTask(subTask.id, { status: 'pending', error: undefined });

        activeSubTasks.add(subTask.id);
        const agentId = subTask.assignedAgent || resolveAssignedAgent(subTask);
        emitDelegationEvent('start', { from: 'Forge', to: agentId, taskId: task.id, taskGoal: task.goal, subTaskId: subTask.id, subTaskTitle: subTask.title, note: subTask.description });

        dispatchWorker(task, subTask).catch(err => {
          console.error(`[Worker] Failed: ${subTask.title}:`, err);
        }).finally(() => {
          activeSubTasks.delete(subTask.id);
          releaseWorkspaceLocks(subTask.id);
        });
      }

      await sleep(2000);
    }

    const finalTask = getTask(task.id)!;
    if (finalTask.status !== 'failed') {
      updateTask(task.id, { status: 'done', completedAt: Date.now(), result: 'All milestones completed.' });
    }
    clearAgentAssignment('Forge');
  } catch (err: any) {
    if (err.message !== 'Task cancelled by user' && !isTaskCancelled(task.id)) {
      updateTask(task.id, { status: 'failed', completedAt: Date.now(), error: err.message });
    }
    clearAgentAssignment('Forge');
  }
}

async function dispatchWorker(task: Task, subTask: SubTask) {
  const agentId = (subTask.assignedAgent || resolveAssignedAgent(subTask)) as AgentId;
  updateSubTask(subTask.id, { status: 'running', startedAt: Date.now(), assignedAgent: agentId, error: undefined });
  setAgentPhase(agentId, 'working', { currentTaskId: task.id, currentTaskGoal: task.goal, currentSubTaskId: subTask.id, currentSubTaskTitle: subTask.title, note: subTask.description });

  const artifacts = getArtifactsForTask(task.id);
  const systemPrompt = getSystemPrompt('worker', { task, subTask, artifacts });
  const goalMsg = `Milestone: ${subTask.title}\nDescription: ${subTask.description}\nSuccess Criteria: ${subTask.successCriteria.join(', ')}`;

  await runToolLoop(task, subTask, systemPrompt, goalMsg, MAX_ITERATIONS_PER_SUBTASK);

  emitDelegationEvent('complete', { from: 'Forge', to: agentId, taskId: task.id, taskGoal: task.goal, subTaskId: subTask.id, subTaskTitle: subTask.title, note: getSubTask(subTask.id)?.status ?? 'unknown' });
  clearAgentAssignment(agentId);
}

// ── Planning ─────────────────────────────────────────────────────────────────

function dependencyIdsFromTitles(titles: string[], titleToId: Map<string, string>): string[] {
  return titles.map(t => titleToId.get(t)).filter((v): v is string => Boolean(v));
}

function getSubTaskAgentId(subTask: SubTask): AgentId {
  return (subTask.assignedAgent || resolveAssignedAgent(subTask)) as AgentId;
}

async function planTask(task: Task) {
  const systemPrompt = getSystemPrompt('planner', { task });
  const response = await callLLM(systemPrompt, `Plan: ${task.goal}`);
  
  try {
    const plan = JSON.parse(cleanJsonResponse(response));
    if (plan.subTasks.length > MAX_INITIAL_SUBTASKS) {
      plan.subTasks = plan.subTasks.slice(0, MAX_INITIAL_SUBTASKS);
    }

    updateTask(task.id, { globalContext: plan.globalContext, successCriteria: plan.successCriteria });

    const created: SubTask[] = plan.subTasks.map((st: any) =>
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
      })
    );

    const titleToId = new Map(created.map(s => [s.title, s.id]));
    plan.subTasks.forEach((st: any, i: number) => {
      updateSubTask(created[i].id, { dependencies: dependencyIdsFromTitles(st.dependencies || [], titleToId) });
    });

    saveMemory(task.id, 'thought', `Plan: ${created.length} milestones created.`, null, 'episodic');
    clearAgentAssignment('Atlas');
  } catch (err) {
    clearAgentAssignment('Atlas');
    throw err;
  }
}

async function reflectAndReplan(task: Task) {
  const subTasks = getSubTasksForTask(task.id);
  const failed = subTasks.filter(st => st.status === 'failed');
  const feedback = failed.map(st => `${st.title}: ${st.error || 'unknown error'}`).join('\n');

  const systemPrompt = getSystemPrompt('planner', { task, allSubTasks: subTasks, feedback });
  const response = await callLLM(systemPrompt, `Replan needed. Failures:\n${feedback}`);

  try {
    const plan = JSON.parse(cleanJsonResponse(response));
    const existing = getSubTasksForTask(task.id);
    const titleToId = new Map(existing.map(s => [s.title, s.id]));

    for (const st of plan.subTasks || []) {
      if (titleToId.has(st.title)) continue; // Skip existing
      const created = createSubTask({
        taskId: task.id, title: st.title, description: st.description, type: st.type,
        dependencies: dependencyIdsFromTitles(st.dependencies || [], titleToId),
        priority: st.priority || 0, assignedAgent: st.assignedAgent || resolveAssignedAgent(st),
        inputArtifacts: st.inputArtifacts || [], outputArtifacts: st.outputArtifacts || [],
        successCriteria: st.successCriteria || [], workspaceScope: st.workspaceScope || [],
        lockedPaths: st.lockedPaths || [],
      });
      titleToId.set(created.title, created.id);
    }

    // Reset failed tasks for retry
    for (const st of failed) {
      if (st.retryCount < MAX_RETRIES_PER_TASK) {
        updateSubTask(st.id, { status: 'pending', error: undefined, retryCount: st.retryCount + 1 });
      }
    }
  } catch (err) {
    console.error('[Replan] Failed:', err);
  }
}