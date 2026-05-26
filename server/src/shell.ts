import { spawn } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';

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

export async function execInContainer(
  command: string,
  timeoutMs = 60000
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const proc = spawn('docker', [
      'exec', '-i', CONTAINER_NAME, 'bash', '-c', command
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
  try {
    const result = await execDockerCommand([
      'inspect', '-f', '{{.State.Status}}', CONTAINER_NAME
    ]);
    const status = result.stdout.trim();
    
    if (status === 'running') {
      console.log(`[Shell] Workspace container is already running`);
      return;
    }
    
    if (status === 'exited' || status === 'created' || status === 'paused') {
      console.log(`[Shell] Workspace container exists (${status}). Starting...`);
      await execDockerCommand(['start', CONTAINER_NAME]);
      return;
    }
  } catch (err) {
    // Container does not exist, proceed to check image
  }

  // 2. Check if the image already exists
  try {
    await execDockerCommand(['inspect', WORKSPACE_IMAGE]);
    console.log(`[Shell] Workspace image found. Starting new container...`);
    await startContainer();
    return;
  } catch (err) {
    // Image does not exist, must build
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
    python3 python3-pip python3-venv \\
    nodejs npm \\
    build-essential \\
    jq unzip zip \\
    ripgrep fd-find \\
    && rm -rf /var/lib/apt/lists/*

# Upgrade npm itself
RUN npm install -g npm@latest

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

  await execDockerCommand(['build', '-t', WORKSPACE_IMAGE, '.docker-tmp']);
  console.log(`[Shell] Workspace image built`);

  await startContainer();
}

async function startContainer(): Promise<void> {
  // Remove old stopped container if exists
  try {
    await execDockerCommand(['rm', '-f', CONTAINER_NAME]);
  } catch {}

  const skillsPath = process.cwd() + '/skills';
  const workspacePath = process.cwd() + '/workspace';

  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(skillsPath, { recursive: true });

  await execDockerCommand([
    'run', '-d',
    '--name', CONTAINER_NAME,
    '--memory=1g',
    '--cpus=1',
    '-v', `${skillsPath}:/skills`,
    '-v', `${workspacePath}:/workspace`,
    '-v', `openforge-npm-global:/usr/local/share/npm-global`,
    '-v', `openforge-pip-packages:/usr/local/lib/python3`,
    '-v', `openforge-root-cache:/root/.cache`,
    '-v', `openforge-root-local:/root/.local`,
    '-p', '4000-4010:4000-4010',
    '-e', `TAVILY_API_KEY=${process.env.TAVILY_API_KEY ?? ''}`,
    '-e', `OPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY ?? ''}`,
    WORKSPACE_IMAGE,
  ]);

  console.log(`[Shell] Workspace container started`);
}

export async function getWorkspaceStatus(): Promise<{
  containerName: string;
  imageName: string;
  status: 'running' | 'stopped' | 'missing';
}> {
  try {
    const result = await execDockerCommand([
      'inspect', '-f', '{{.State.Status}}', CONTAINER_NAME,
    ]);
    const status = result.stdout.trim();
    if (status === 'running') {
      return { containerName: CONTAINER_NAME, imageName: WORKSPACE_IMAGE, status: 'running' };
    }
    return { containerName: CONTAINER_NAME, imageName: WORKSPACE_IMAGE, status: 'stopped' };
  } catch {
    return { containerName: CONTAINER_NAME, imageName: WORKSPACE_IMAGE, status: 'missing' };
  }
}

// Helper for docker commands that don't need stdin
function execDockerCommand(args: string[]): Promise<ShellResult> {
  console.log(`[Shell] $ docker ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      process.stdout.write(chunk);
    });
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      process.stderr.write(chunk);
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
): Promise<ShellResult> {
  return execInContainer(`cat ${shellQuote(filePath)}`);
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
