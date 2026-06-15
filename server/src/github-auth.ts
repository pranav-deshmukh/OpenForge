import fs from 'fs/promises';
import {
  ensureRuntimeSecretsDir,
  getGithubAuthSecretPath,
  getLegacyGithubAuthSecretPath,
} from './runtime-secrets.js';

export interface GithubAuthSecretConfig {
  token?: string;
  username?: string;
  email?: string;
  updatedAt: number;
}

export interface GithubAuthPublicConfig {
  username?: string;
  email?: string;
  hasToken: boolean;
  updatedAt?: number;
}

export async function readGithubAuthConfig(): Promise<GithubAuthSecretConfig | null> {
  try {
    const raw = await readGithubAuthRaw();
    const parsed = JSON.parse(raw) as Partial<GithubAuthSecretConfig>;
    return {
      token: parsed.token?.trim() || undefined,
      username: parsed.username?.trim() || undefined,
      email: parsed.email?.trim() || undefined,
      updatedAt: parsed.updatedAt || Date.now(),
    };
  } catch {
    return null;
  }
}

async function readGithubAuthRaw(): Promise<string> {
  try {
    return await fs.readFile(getGithubAuthSecretPath(), 'utf-8');
  } catch {
    return fs.readFile(getLegacyGithubAuthSecretPath(), 'utf-8');
  }
}

export async function readGithubAuthPublicConfig(): Promise<GithubAuthPublicConfig | null> {
  const config = await readGithubAuthConfig();
  if (!config) return null;

  return {
    username: config.username,
    email: config.email,
    hasToken: Boolean(config.token),
    updatedAt: config.updatedAt,
  };
}

export async function writeGithubAuthConfig(input: {
  token?: string;
  username?: string;
  email?: string;
}): Promise<GithubAuthPublicConfig> {
  const existing = await readGithubAuthConfig();
  const token = input.token?.trim() || existing?.token || '';
  const username = input.username?.trim() || existing?.username || '';
  const email = input.email?.trim() || existing?.email || '';

  if (!token) {
    throw new Error('GitHub token is required');
  }
  if (!username) {
    throw new Error('Git username is required');
  }
  if (!email) {
    throw new Error('Git email is required');
  }

  const payload: GithubAuthSecretConfig = {
    token,
    username,
    email,
    updatedAt: Date.now(),
  };

  await ensureRuntimeSecretsDir();
  await fs.writeFile(getGithubAuthSecretPath(), JSON.stringify(payload, null, 2), 'utf-8');

  return {
    username: payload.username,
    email: payload.email,
    hasToken: true,
    updatedAt: payload.updatedAt,
  };
}
