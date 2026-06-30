/**
 * Aider CLI Executor — delegates coding tasks to Aider running inside Docker.
 * OpenForge keeps orchestration (routing, DAG, memory, verification).
 * Aider handles the actual file editing, code generation, and shell execution.
 */

import { execInContainer, listFilesInContainer, searchCodeInContainer, pathExistsInContainer } from './shell.js';
import { saveMemory } from './memory.js';

export interface AiderResult {
  success: boolean;
  output: string;
  filesChanged: string[];
  exitCode: number;
}

const AIDER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max per invocation

const AIDER_BASE_FLAGS = [
  '--model', 'gemini/gemini-2.5-flash',
  '--yes-always',
  '--no-git',
  '--no-pretty',
  '--no-stream',
  '--no-detect-urls',
  '--no-suggest-shell-commands',
  '--no-check-update',
  '--no-show-model-warnings',
  '--no-auto-lint',
].join(' ');

/**
 * Run a coding task via Aider CLI inside the Docker workspace container.
 *
 * @param goal - Natural language description of what to build/fix/change
 * @param workDir - Working directory inside the container (e.g. /workspace/my-app)
 * @param files - Optional specific files to scope Aider's editing to
 * @param taskId - For logging to memory
 * @param subTaskId - For logging to memory
 */
export async function runAiderTask(
  goal: string,
  workDir: string,
  files?: string[],
  taskId?: string,
  subTaskId?: string | null,
): Promise<AiderResult> {
  // Build the command
  const fileArgs = files && files.length > 0
    ? files.map(f => `--file ${shellQuote(f)}`).join(' ')
    : '';

  const messageArg = `--message ${shellQuote(goal)}`;

  const command = `cd ${shellQuote(workDir)} && aider ${AIDER_BASE_FLAGS} ${fileArgs} ${messageArg} 2>&1`;

  if (taskId) {
    saveMemory(taskId, 'command', `[aider] ${goal.slice(0, 150)}`, subTaskId ?? null, 'working');
  }

  console.log(`[Aider] Executing in ${workDir}: ${goal.slice(0, 100)}...`);

  const result = await execInContainer(command, AIDER_TIMEOUT_MS, workDir);
  const output = (result.stdout + result.stderr).trim();

  // Parse changed files from Aider output
  const filesChanged = parseChangedFiles(output);

  if (taskId) {
    // Log a summary to memory for frontend visibility
    const statusMsg = result.exitCode === 0
      ? `Aider completed. Files changed: ${filesChanged.length > 0 ? filesChanged.join(', ') : 'none'}`
      : `Aider failed (exit ${result.exitCode}). Output: ${output.slice(-500)}`;
    saveMemory(taskId, result.exitCode === 0 ? 'thought' : 'error', statusMsg, subTaskId ?? null, 'working');
  }

  console.log(`[Aider] Exit ${result.exitCode} | Files changed: ${filesChanged.length}`);

  return {
    success: result.exitCode === 0,
    output,
    filesChanged,
    exitCode: result.exitCode,
  };
}

/**
 * Discover relevant files for a task goal by searching the workspace.
 * Returns up to maxFiles paths that are likely relevant.
 */
export async function discoverRelevantFiles(
  goal: string,
  workDir: string,
  maxFiles = 15,
): Promise<string[]> {
  const files: Set<string> = new Set();

  // 1. Extract explicit file paths/names from the goal
  const pathMatches = goal.match(/(?:\/workspace\/|\.\/|src\/|app\/)[^\s,;)'"]+/g) || [];
  for (const p of pathMatches) {
    const fullPath = p.startsWith('/') ? p : `${workDir}/${p}`;
    if (await pathExistsInContainer(fullPath)) {
      files.add(fullPath);
    }
  }

  // 2. Extract likely filenames mentioned (e.g. "index.ts", "App.tsx")
  const filenameMatches = goal.match(/\b[\w.-]+\.(ts|tsx|js|jsx|py|go|rs|java|css|html|json|md)\b/g) || [];
  for (const name of filenameMatches.slice(0, 5)) {
    const searchResult = await execInContainer(
      `find ${shellQuote(workDir)} -maxdepth 5 -name ${shellQuote(name)} -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -3`,
      10000,
    );
    if (searchResult.exitCode === 0 && searchResult.stdout.trim()) {
      for (const line of searchResult.stdout.trim().split('\n')) {
        if (line.trim()) files.add(line.trim());
      }
    }
  }

  // 3. Extract keywords and search for relevant code
  const keywords = extractKeywords(goal);
  for (const keyword of keywords.slice(0, 3)) {
    const r = await searchCodeInContainer(workDir, keyword);
    if (r.exitCode === 0 && r.stdout.trim()) {
      const matchedFiles = r.stdout.trim().split('\n')
        .map(line => line.split(':')[0])
        .filter(Boolean);
      for (const f of matchedFiles.slice(0, 3)) {
        files.add(f);
      }
    }
  }

  // 4. If still few files, add key project files
  if (files.size < 3) {
    for (const keyFile of ['package.json', 'tsconfig.json', 'src/index.ts', 'src/app.ts', 'app/page.tsx']) {
      const fullPath = `${workDir}/${keyFile}`;
      if (await pathExistsInContainer(fullPath)) {
        files.add(fullPath);
      }
    }
  }

  return [...files].slice(0, maxFiles);
}

/**
 * Run Aider with automatic file discovery and retry logic.
 * This is the main entry point for tool mode and worker agents.
 */
export async function executeWithAider(
  goal: string,
  workDir: string,
  taskId: string,
  subTaskId: string | null,
  maxRetries = 3,
): Promise<AiderResult> {
  // Discover relevant files
  const relevantFiles = await discoverRelevantFiles(goal, workDir);

  if (taskId) {
    saveMemory(taskId, 'thought',
      `Delegating to Aider. Relevant files: ${relevantFiles.length > 0 ? relevantFiles.join(', ') : '(entire workspace)'}`,
      subTaskId, 'working');
  }

  let lastResult: AiderResult | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Build the prompt — include error context from prior attempts
    let prompt = goal;
    if (lastResult && !lastResult.success) {
      prompt = `${goal}\n\nPREVIOUS ATTEMPT FAILED (exit ${lastResult.exitCode}). Error output:\n${lastResult.output.slice(-1000)}\n\nFix the issues and complete the task.`;
    }

    lastResult = await runAiderTask(prompt, workDir, relevantFiles, taskId, subTaskId);

    if (lastResult.success) {
      return lastResult;
    }

    if (attempt < maxRetries) {
      console.log(`[Aider] Attempt ${attempt}/${maxRetries} failed. Retrying...`);
      if (taskId) {
        saveMemory(taskId, 'thought', `Aider attempt ${attempt} failed. Retrying with error context...`, subTaskId, 'working');
      }
    }
  }

  return lastResult!;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function extractKeywords(goal: string): string[] {
  const stopwords = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'has', 'have', 'been', 'will', 'can', 'should', 'would', 'could', 'create', 'make', 'build', 'add', 'fix', 'update', 'implement', 'use', 'using', 'file', 'code', 'app', 'project']);
  return goal
    .replace(/[^a-zA-Z0-9_\-.]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w.toLowerCase()))
    .slice(0, 8);
}

function parseChangedFiles(output: string): string[] {
  const files: Set<string> = new Set();

  // Aider typically outputs lines like:
  // "Applied edit to src/index.ts"
  // "Wrote src/new-file.ts"
  const patterns = [
    /Applied edit to (.+)/g,
    /Wrote (.+)/g,
    /Created (.+)/g,
    /Updated (.+)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(output)) !== null) {
      const file = match[1].trim();
      if (file && !file.includes(' ') && file.length < 200) {
        files.add(file);
      }
    }
  }

  return [...files];
}
