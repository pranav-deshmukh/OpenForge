import { spawn } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';

const CONTAINER_NAME = 'phd-agent-workspace';
const WORKSPACE_IMAGE = 'phd-agent-workspace:latest';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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

    const settle = (result: ShellResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());

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
  // Check if container already running
  try {
    const result = await execDockerCommand([
      'inspect', '-f', '{{.State.Running}}', CONTAINER_NAME
    ]);
    if (result.stdout.trim() === 'true') {
      console.log(`[Shell] Workspace container already running`);
      return;
    }
  } catch {}

  // Build image
  console.log(`[Shell] Building workspace image...`);

  const dockerfile = `FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \\
    curl wget git vim nano \\
    python3 python3-pip python3-venv \\
    nodejs npm \\
    build-essential \\
    jq unzip zip \\
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install requests numpy pandas matplotlib scipy
RUN npm install -g typescript ts-node
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
    '-p', '4000-4010:4000-4010',
    '-e', `TAVILY_API_KEY=${process.env.TAVILY_API_KEY ?? ''}`,
    '-e', `OPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY ?? ''}`,
    WORKSPACE_IMAGE,
  ]);

  console.log(`[Shell] Workspace container started`);
}

// Helper for docker commands that don't need stdin
function execDockerCommand(args: string[]): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());

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