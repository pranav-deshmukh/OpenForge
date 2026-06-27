import { spawn } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { readGithubAuthConfig } from './github-auth.js';
import {
  ensureRuntimeSecretsDir,
  getContainerAgentMailPath,
  getContainerGithubEnvPath,
  getRuntimeSecretsDir,
} from './runtime-secrets.js';

const CONTAINER_NAME = 'phd-agent-workspace';
const WORKSPACE_IMAGE = 'phd-agent-workspace:latest';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

import { getIo } from './memory.js';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function withRuntimeEnv(command: string): string {
  const envPath = shellQuote(getContainerGithubEnvPath());
  return `if [ -f ${envPath} ]; then . ${envPath}; fi; ${command}`;
}

async function inspectContainerStatus(): Promise<string | null> {
  try {
    const result = await execDockerCommand(
      ['inspect', '-f', '{{.State.Status}}', CONTAINER_NAME],
      { quiet: true, quietOnError: true },
    );
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function imageExists(imageName: string): Promise<boolean> {
  try {
    await execDockerCommand(['inspect', imageName], { quiet: true, quietOnError: true });
    return true;
  } catch {
    return false;
  }
}

export async function execInContainer(
  command: string,
  timeoutMs = 60000
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const proc = spawn('docker', [
      'exec', '-i', CONTAINER_NAME, 'bash', '-lc', withRuntimeEnv(command)
    ]);

    let stdout = '';
    let stderr = '';
    let settled = false;
    const io = getIo();

    const settle = (result: ShellResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (io) io.emit('agent:stream', { content: chunk, type: 'stdout' });
    });
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      if (io) io.emit('agent:stream', { content: chunk, type: 'stderr' });
    });

    proc.on('close', (code) => {
      settle({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on('error', (err) => {
      settle({ stdout, stderr: err.message, exitCode: 1 });
    });

    setTimeout(() => {
      proc.kill();
      settle({ stdout, stderr: 'Timed out', exitCode: 124 });
    }, timeoutMs);
  });
}

export async function ensureWorkspaceReady(): Promise<void> {
  // 1. Check if container exists and its status
  const status = await inspectContainerStatus();
  if (status) {
    if (!(await containerHasSecretsMount())) {
      console.log('[Shell] Workspace container missing /run/openforge mount. Recreating...');
      await execDockerCommand(['rm', '-f', CONTAINER_NAME], { quiet: true, quietOnError: true });
      await startContainer();
      return;
    }

    if (status === 'running') {
      console.log(`[Shell] Workspace container is already running`);
      return;
    }

    if (status === 'exited' || status === 'created' || status === 'paused') {
      console.log(`[Shell] Workspace container exists (${status}). Starting...`);
      await execDockerCommand(['start', CONTAINER_NAME], { quiet: true });
      return;
    }
  }

  // 2. Check if the image already exists
  if (await imageExists(WORKSPACE_IMAGE)) {
    console.log(`[Shell] Workspace image found. Starting new container...`);
    await startContainer();
    return;
  }

  // 3. Build image if missing
  console.log(`[Shell] Workspace image not found. Building...`);

  const dockerfile = `FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# System packages
RUN apt-get update && apt-get install -y \\
    curl wget git vim nano \\
    ca-certificates gnupg \\
    python3 python3-pip python3-venv \\
    build-essential \\
    jq unzip zip \\
    gh \\
    ripgrep fd-find \\
    && rm -rf /var/lib/apt/lists/*

# Install a current Node.js runtime instead of Ubuntu's legacy package
RUN mkdir -p /etc/apt/keyrings && \\
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \\
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list && \\
    apt-get update && apt-get install -y nodejs && \\
    rm -rf /var/lib/apt/lists/*

# Pre-bake common global Node packages — agent won't need to reinstall these
RUN npm install -g \\
    typescript \\
    ts-node \\
    nodemon \\
    prettier \\
    eslint \\
    tsx \\
    jest \\
    http-server

# Pre-bake common Python packages — agent won't need to reinstall these
RUN pip3 install --no-cache-dir \\
    requests \\
    numpy \\
    pandas \\
    matplotlib \\
    scipy \\
    fastapi \\
    uvicorn \\
    pytest \\
    black \\
    httpx \\
    python-dotenv

# Mark what's pre-installed so the agent knows not to reinstall
RUN echo "typescript ts-node nodemon prettier eslint tsx jest http-server" > /etc/openforge-preinstalled-npm && \\
    echo "requests numpy pandas matplotlib scipy fastapi uvicorn pytest black httpx python-dotenv" > /etc/openforge-preinstalled-pip

WORKDIR /workspace
CMD ["tail", "-f", "/dev/null"]
`;

  mkdirSync('.docker-tmp', { recursive: true });
  writeFileSync('.docker-tmp/Dockerfile', dockerfile);

  await execDockerCommand(['build', '-t', WORKSPACE_IMAGE, '.docker-tmp'], { quiet: true });
  console.log(`[Shell] Workspace image built`);

  await startContainer();
}

async function startContainer(): Promise<void> {
  // Remove old stopped container if exists
  try {
    await execDockerCommand(['rm', '-f', CONTAINER_NAME], { quiet: true, quietOnError: true });
  } catch {}

  const skillsPath = process.cwd() + '/skills';
  const workspacePath = process.cwd() + '/workspace';
  const runtimeSecretsPath = getRuntimeSecretsDir();

  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(skillsPath, { recursive: true });
  mkdirSync(runtimeSecretsPath, { recursive: true });
  await ensureRuntimeSecretsDir();
  await writeRuntimeEnvFile();

  await execDockerCommand([
    'run', '-d',
    '--name', CONTAINER_NAME,
    '--memory=1g',
    '--cpus=1',
    '-v', `${skillsPath}:/skills`,
    '-v', `${workspacePath}:/workspace`,
    '-v', `${runtimeSecretsPath}:/run/openforge`,
    '-v', `openforge-npm-global:/usr/local/share/npm-global`,
    '-v', `openforge-pip-packages:/usr/local/lib/python3`,
    '-v', `openforge-root-cache:/root/.cache`,
    '-v', `openforge-root-local:/root/.local`,
    '-p', '4000-4010:4000-4010',
    '-e', `TAVILY_API_KEY=${process.env.TAVILY_API_KEY ?? ''}`,
    '-e', `OPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY ?? ''}`,
    WORKSPACE_IMAGE,
  ], { quiet: true });

  await applyGitIdentityInContainer();
  console.log(`[Shell] Workspace container started`);
}

export async function getWorkspaceStatus(): Promise<{
  containerName: string;
  imageName: string;
  status: 'running' | 'stopped' | 'missing';
}> {
  const status = await inspectContainerStatus();
  if (!status) {
    return { containerName: CONTAINER_NAME, imageName: WORKSPACE_IMAGE, status: 'missing' };
  }
  if (status === 'running') {
    return { containerName: CONTAINER_NAME, imageName: WORKSPACE_IMAGE, status: 'running' };
  }
  return { containerName: CONTAINER_NAME, imageName: WORKSPACE_IMAGE, status: 'stopped' };
}

// Helper for docker commands that don't need stdin
function execDockerCommand(
  args: string[],
  options?: { quiet?: boolean; quietOnError?: boolean; streamOutput?: boolean },
): Promise<ShellResult> {
  if (!options?.quiet) {
    console.log(`[Shell] $ docker ${args.join(' ')}`);
  }
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (options?.streamOutput) {
        process.stdout.write(chunk);
      }
    });
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      if (options?.streamOutput && !options?.quietOnError) {
        process.stderr.write(chunk);
      }
    });

    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, exitCode: 0 });
      else reject(new Error(stderr || `docker ${args[0]} failed with code ${code}`));
    });

    proc.on('error', (err) => reject(err));
  });
}

export async function copyToContainer(
  localPath: string,
  containerPath: string
): Promise<void> {
  await execDockerCommand(['cp', localPath, `${CONTAINER_NAME}:${containerPath}`]);
}

export async function copyFromContainer(
  containerPath: string,
  localPath: string
): Promise<void> {
  await execDockerCommand(['cp', `${CONTAINER_NAME}:${containerPath}`, localPath]);
}

/**
 * Surgically replace a unique string in a file inside the container.
 * oldStr must appear EXACTLY ONCE in the file.
 * Uses Python to avoid shell escaping hell with sed.
 */
export async function strReplaceInContainer(
  filePath: string,
  oldStr: string,
  newStr: string,
): Promise<ShellResult> {
  // Write a tiny Python script to a temp file in the container to avoid
  // any quoting/escaping issues with heredoc or echo
  const script = [
    "import sys",
    `path = ${JSON.stringify(filePath)}`,
    `old = ${JSON.stringify(oldStr)}`,
    `new = ${JSON.stringify(newStr)}`,
    'with open(path, "r", encoding="utf-8") as f:',
    "    content = f.read()",
    "count = content.count(old)",
    "if count == 0:",
    '    print("STR_REPLACE_ERROR: old_str not found in file", file=sys.stderr)',
    "    sys.exit(1)",
    "if count > 1:",
    '    print(f"STR_REPLACE_ERROR: old_str found {count} times — must be unique", file=sys.stderr)',
    "    sys.exit(1)",
    "new_content = content.replace(old, new, 1)",
    'with open(path, "w", encoding="utf-8") as f:',
    "    f.write(new_content)",
    'print(f"STR_REPLACE_OK: replaced 1 occurrence in {path}")',
  ].join("\n");

  // Write the script into the container as a temp file, then execute it
  const tmpPath = `/tmp/_str_replace_${Date.now()}.py`;
  const writeResult = await execInContainer(
    `cat > ${tmpPath} << 'PYEOF'\n${script}\nPYEOF`,
  );
  if (writeResult.exitCode !== 0) {
    return writeResult;
  }
  const result = await execInContainer(
    `python3 ${tmpPath} && rm -f ${tmpPath}`,
  );
  return result;
}

/**
 * Read a file from the container and return its contents as a string.
 * Use this before str_replace to verify the old_str exists.
 */
export async function readFileFromContainer(
  filePath: string,
  startLine?: number,
  endLine?: number,
): Promise<ShellResult> {
  if (
    startLine == null &&
    endLine == null
  ) {
    return execInContainer(`cat ${shellQuote(filePath)}`);
  }

  const script = [
    "import sys",
    `path = ${JSON.stringify(filePath)}`,
    `start = ${startLine == null ? 'None' : Math.max(1, Math.floor(startLine))}`,
    `end = ${endLine == null ? 'None' : Math.max(1, Math.floor(endLine))}`,
    'if start is not None and end is not None and end < start:',
    '    print("READ_FILE_ERROR: end_line must be greater than or equal to start_line", file=sys.stderr)',
    "    sys.exit(1)",
    'with open(path, "r", encoding="utf-8") as f:',
    '    lines = f.readlines()',
    'start_index = 0 if start is None else start - 1',
    'end_index = len(lines) if end is None else end',
    'sys.stdout.write("".join(lines[start_index:end_index]))',
  ].join("\n");

  const tmpPath = `/tmp/_read_file_${Date.now()}.py`;
  const writeResult = await execInContainer(
    `cat > ${tmpPath} << 'PYEOF'\n${script}\nPYEOF`,
  );
  if (writeResult.exitCode !== 0) {
    return writeResult;
  }
  return execInContainer(`python3 ${tmpPath} && rm -f ${tmpPath}`);
}

export async function listFilesInContainer(
  dirPath: string,
  maxDepth = 4,
): Promise<ShellResult> {
  const safeDepth = Math.max(1, Math.min(8, Math.floor(maxDepth)));
  const command = [
    `find ${shellQuote(dirPath)}`,
    `-maxdepth ${safeDepth}`,
    `\\( -path '*/.git' -o -path '*/node_modules' -o -path '*/.next' \\) -prune -o`,
    `\\( -type f -o -type d \\) -print`,
    `| sort`,
  ].join(' ');
  return execInContainer(command);
}

export async function searchCodeInContainer(
  dirPath: string,
  pattern: string,
  glob?: string,
): Promise<ShellResult> {
  const globArg = glob?.trim() ? ` -g ${shellQuote(glob.trim())}` : '';
  const command =
    `rg -n --hidden --glob '!**/.git/**' --glob '!**/node_modules/**' --glob '!**/.next/**'` +
    `${globArg} ${shellQuote(pattern)} ${shellQuote(dirPath)}`;
  return execInContainer(command);
}

export async function getRepoStatusInContainer(
  dirPath: string,
): Promise<ShellResult> {
  return execInContainer(
    `cd ${shellQuote(dirPath)} && git rev-parse --show-toplevel && echo '---' && git status --short --branch`,
  );
}

async function containerHasSecretsMount(): Promise<boolean> {
  try {
    const result = await execDockerCommand([
      'inspect',
      '-f',
      '{{range .Mounts}}{{println .Destination}}{{end}}',
      CONTAINER_NAME,
    ], { quiet: true, quietOnError: true });
    return result.stdout.split(/\r?\n/).some((line) => line.trim() === '/run/openforge');
  } catch {
    return false;
  }
}

async function writeRuntimeEnvFile(): Promise<void> {
  const githubAuth = await readGithubAuthConfig();
  const envPath = path.join(getRuntimeSecretsDir(), 'env.sh');
  const lines = [
    'export OPENFORGE_RUNTIME_SECRETS_DIR=/run/openforge',
    `export OPENFORGE_AGENT_MAIL_PATH=${shellQuote(getContainerAgentMailPath())}`,
  ];

  if (githubAuth?.token) {
    lines.push(`export GH_TOKEN=${shellQuote(githubAuth.token)}`);
  }
  if (githubAuth?.username) {
    lines.push(`export GIT_AUTHOR_NAME=${shellQuote(githubAuth.username)}`);
    lines.push(`export GIT_COMMITTER_NAME=${shellQuote(githubAuth.username)}`);
  }
  if (githubAuth?.email) {
    lines.push(`export GIT_AUTHOR_EMAIL=${shellQuote(githubAuth.email)}`);
    lines.push(`export GIT_COMMITTER_EMAIL=${shellQuote(githubAuth.email)}`);
  }

  await ensureRuntimeSecretsDir();
  await fs.writeFile(envPath, `${lines.join('\n')}\n`, 'utf-8');
}

async function applyGitIdentityInContainer(): Promise<void> {
  const githubAuth = await readGithubAuthConfig();
  if (!githubAuth?.username || !githubAuth.email) {
    return;
  }

  await execInContainer(
    `git config --global user.name ${shellQuote(githubAuth.username)} && ` +
      `git config --global user.email ${shellQuote(githubAuth.email)}`,
  );

  if (githubAuth?.token) {
    await execInContainer(
      `echo ${shellQuote(githubAuth.token)} | gh auth login --with-token 2>/dev/null || true`,
    );
    await execInContainer(
      `git config --global url.${JSON.stringify(`https://x-access-token:${githubAuth.token}@github.com/`)}.insteadOf ${JSON.stringify('https://github.com/')}`,
    );
  }
}

export async function syncRuntimeSecretsToContainer(): Promise<void> {
  await writeRuntimeEnvFile();

  const status = await getWorkspaceStatus();
  if (status.status !== 'running') {
    return;
  }

  if (!(await containerHasSecretsMount())) {
    await execDockerCommand(['rm', '-f', CONTAINER_NAME]);
    await startContainer();
    return;
  }

  await applyGitIdentityInContainer();
}

export interface GithubRuntimeHealth {
  checkedAt: number;
  containerStatus: 'running' | 'stopped' | 'missing';
  secretsMountPresent: boolean;
  serverHasToken: boolean;
  serverUsername?: string;
  serverEmail?: string;
  ghInstalled: boolean;
  ghAuthReady: boolean;
  ghTokenVisible: boolean;
  gitUserName?: string;
  gitUserEmail?: string;
  gitIdentityReady: boolean;
  notes: string[];
}

export async function getGithubRuntimeHealth(): Promise<GithubRuntimeHealth> {
  const githubAuth = await readGithubAuthConfig();
  const workspaceStatus = await getWorkspaceStatus();
  const secretsMountPresent =
    workspaceStatus.status === 'running' ? await containerHasSecretsMount() : false;

  const health: GithubRuntimeHealth = {
    checkedAt: Date.now(),
    containerStatus: workspaceStatus.status,
    secretsMountPresent,
    serverHasToken: Boolean(githubAuth?.token),
    serverUsername: githubAuth?.username,
    serverEmail: githubAuth?.email,
    ghInstalled: false,
    ghAuthReady: false,
    ghTokenVisible: false,
    gitUserName: undefined,
    gitUserEmail: undefined,
    gitIdentityReady: false,
    notes: [],
  };

  if (workspaceStatus.status !== 'running') {
    health.notes.push('Workspace container is not running.');
    return health;
  }

  if (!secretsMountPresent) {
    health.notes.push('Workspace container is missing the /run/openforge secret mount.');
    return health;
  }

  const ghCheck = await execInContainer('command -v gh >/dev/null 2>&1 && echo installed || echo missing');
  health.ghInstalled = ghCheck.stdout.trim() === 'installed';
  if (!health.ghInstalled) {
    health.notes.push('GitHub CLI is not installed in the container.');
  }

  const tokenCheck = await execInContainer('[ -n "$GH_TOKEN" ] && echo present || echo missing');
  health.ghTokenVisible = tokenCheck.stdout.trim() === 'present';
  if (!health.ghTokenVisible) {
    health.notes.push('GH_TOKEN is not visible inside the container runtime.');
  }

  const gitName = await execInContainer('git config --global --get user.name || true');
  const gitEmail = await execInContainer('git config --global --get user.email || true');
  health.gitUserName = gitName.stdout.trim() || undefined;
  health.gitUserEmail = gitEmail.stdout.trim() || undefined;
  health.gitIdentityReady = Boolean(health.gitUserName && health.gitUserEmail);
  if (!health.gitIdentityReady) {
    health.notes.push('Global git user.name or user.email is missing inside the container.');
  }

  if (health.ghInstalled) {
    const authCheck = await execInContainer('gh auth status >/dev/null 2>&1 && echo ok || echo missing');
    health.ghAuthReady = authCheck.stdout.trim() === 'ok';
    if (!health.ghAuthReady) {
      health.notes.push('gh auth status is failing inside the container.');
    }
  }

  if (health.notes.length === 0) {
    health.notes.push('GitHub runtime is ready.');
  }

  return health;
}

export async function pathExistsInContainer(filePath: string): Promise<boolean> {
  const result = await execInContainer(`test -e ${shellQuote(filePath)}`);
  return result.exitCode === 0;
}

/**
 * Insert text at a specific line number in a file inside the container.
 * lineNumber is 1-based. Inserts BEFORE the given line.
 */
export async function insertAtLineInContainer(
  filePath: string,
  lineNumber: number,
  textToInsert: string,
): Promise<ShellResult> {
  const script = [
    "import sys",
    `path = ${JSON.stringify(filePath)}`,
    `line_no = ${lineNumber}`,
    `insert_text = ${JSON.stringify(textToInsert)}`,
    'with open(path, "r", encoding="utf-8") as f:',
    "    lines = f.readlines()",
    "if line_no < 1 or line_no > len(lines) + 1:",
    '    print(f"INSERT_ERROR: line {line_no} out of range (file has {len(lines)} lines)", file=sys.stderr)',
    "    sys.exit(1)",
    "# Ensure insert text ends with newline",
    'if not insert_text.endswith("\\n"):',
    '    insert_text += "\\n"',
    "lines.insert(line_no - 1, insert_text)",
    'with open(path, "w", encoding="utf-8") as f:',
    "    f.writelines(lines)",
    'print(f"INSERT_OK: inserted at line {line_no} in {path}")',
  ].join("\n");

  const tmpPath = `/tmp/_insert_line_${Date.now()}.py`;
  await execInContainer(`cat > ${tmpPath} << 'PYEOF'\n${script}\nPYEOF`);
  return execInContainer(`python3 ${tmpPath} && rm -f ${tmpPath}`);
}

/**
 * Delete a block from a file using deterministic anchor text.
 * Removes everything from the first occurrence of startAnchor up to the first
 * occurrence of endAnchor after it. endAnchor is also removed.
 */
export async function deleteBlockInContainer(
  filePath: string,
  startAnchor: string,
  endAnchor: string,
): Promise<ShellResult> {
  const script = [
    "import sys",
    `path = ${JSON.stringify(filePath)}`,
    `start_anchor = ${JSON.stringify(startAnchor)}`,
    `end_anchor = ${JSON.stringify(endAnchor)}`,
    'with open(path, "r", encoding="utf-8") as f:',
    "    content = f.read()",
    "start_index = content.find(start_anchor)",
    "if start_index == -1:",
    '    print("DELETE_BLOCK_ERROR: start_anchor not found", file=sys.stderr)',
    "    sys.exit(1)",
    "end_index = content.find(end_anchor, start_index + len(start_anchor))",
    "if end_index == -1:",
    '    print("DELETE_BLOCK_ERROR: end_anchor not found", file=sys.stderr)',
    "    sys.exit(1)",
    "end_index += len(end_anchor)",
    "new_content = content[:start_index] + content[end_index:]",
    'with open(path, "w", encoding="utf-8") as f:',
    "    f.write(new_content)",
    'print(f"DELETE_BLOCK_OK: removed block from {path}")',
  ].join("\n");

  const tmpPath = `/tmp/_delete_block_${Date.now()}.py`;
  await execInContainer(`cat > ${tmpPath} << 'PYEOF'\n${script}\nPYEOF`);
  return execInContainer(`python3 ${tmpPath} && rm -f ${tmpPath}`);
}

/**
 * Returns the list of pre-installed packages so the agent prompt
 * can inform the agent what's already available without reinstalling.
 */
export async function getPreinstalledPackages(): Promise<{ npm: string[], pip: string[] }> {
  const npmResult = await execInContainer('cat /etc/openforge-preinstalled-npm 2>/dev/null || echo ""');
  const pipResult = await execInContainer('cat /etc/openforge-preinstalled-pip 2>/dev/null || echo ""');
  return {
    npm: npmResult.stdout.trim().split(' ').filter(Boolean),
    pip: pipResult.stdout.trim().split(' ').filter(Boolean),
  };
}
