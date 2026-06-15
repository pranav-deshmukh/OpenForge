import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const LEGACY_RUNTIME_SECRETS_DIR = path.join(process.cwd(), '.runtime-secrets');

function getDefaultRuntimeSecretsDir(): string {
  if (process.env.OPENFORGE_SECRETS_DIR?.trim()) {
    return process.env.OPENFORGE_SECRETS_DIR.trim();
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'openforge', 'secrets');
  }

  return path.join(os.homedir(), '.openforge', 'secrets');
}

const RUNTIME_SECRETS_DIR = getDefaultRuntimeSecretsDir();

export function getRuntimeSecretsDir(): string {
  return RUNTIME_SECRETS_DIR;
}

export function getLegacyRuntimeSecretsDir(): string {
  return LEGACY_RUNTIME_SECRETS_DIR;
}

export function getAgentMailSecretPath(): string {
  return path.join(RUNTIME_SECRETS_DIR, 'agent-mail.json');
}

export function getLegacyAgentMailSecretPath(): string {
  return path.join(LEGACY_RUNTIME_SECRETS_DIR, 'agent-mail.json');
}

export function getGithubAuthSecretPath(): string {
  return path.join(RUNTIME_SECRETS_DIR, 'github-auth.json');
}

export function getLegacyGithubAuthSecretPath(): string {
  return path.join(LEGACY_RUNTIME_SECRETS_DIR, 'github-auth.json');
}

export function getContainerRuntimeSecretsDir(): string {
  return '/run/openforge';
}

export function getContainerAgentMailPath(): string {
  return `${getContainerRuntimeSecretsDir()}/agent-mail.json`;
}

export function getContainerGithubEnvPath(): string {
  return `${getContainerRuntimeSecretsDir()}/env.sh`;
}

export async function ensureRuntimeSecretsDir(): Promise<void> {
  await migrateLegacySecretsIfNeeded();
  await fs.mkdir(RUNTIME_SECRETS_DIR, { recursive: true });
}

async function migrateLegacySecretsIfNeeded(): Promise<void> {
  if (RUNTIME_SECRETS_DIR === LEGACY_RUNTIME_SECRETS_DIR) {
    return;
  }

  await fs.mkdir(RUNTIME_SECRETS_DIR, { recursive: true });

  await migrateFileIfNeeded(getLegacyAgentMailSecretPath(), getAgentMailSecretPath());
  await migrateFileIfNeeded(getLegacyGithubAuthSecretPath(), getGithubAuthSecretPath());
}

async function migrateFileIfNeeded(source: string, destination: string): Promise<void> {
  try {
    await fs.access(destination);
    return;
  } catch {}

  try {
    await fs.access(source);
  } catch {
    return;
  }

  await fs.copyFile(source, destination);
}
