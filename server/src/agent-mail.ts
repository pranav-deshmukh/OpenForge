import fs from 'fs/promises';
import path from 'path';
import {
  ensureRuntimeSecretsDir,
  getAgentMailSecretPath,
  getLegacyAgentMailSecretPath,
} from './runtime-secrets.js';

export interface AgentMailSecretConfig {
  email: string;
  clientId: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  authorizationCode?: string;
  redirectUri?: string;
  displayName?: string;
  ownerEmail?: string;
  signature?: string;
  updatedAt: number;
}

export interface AgentMailPublicConfig {
  email: string;
  clientId: string;
  displayName?: string;
  ownerEmail?: string;
  signature?: string;
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
  hasAccessToken: boolean;
  updatedAt?: number;
}

const AGENT_MAIL_PATH = getAgentMailSecretPath();
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function getAgentMailFilePath(): string {
  return AGENT_MAIL_PATH;
}

export async function readAgentMailConfig(): Promise<AgentMailSecretConfig | null> {
  try {
    const raw = await readAgentMailRaw();
    const parsed = JSON.parse(raw) as Partial<AgentMailSecretConfig>;
    if (!parsed.email || !parsed.clientId) {
      return null;
    }
    return {
      email: parsed.email,
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret?.trim() || undefined,
      refreshToken: parsed.refreshToken?.trim() || undefined,
      accessToken: parsed.accessToken?.trim() || undefined,
      authorizationCode: parsed.authorizationCode?.trim() || undefined,
      redirectUri: parsed.redirectUri?.trim() || undefined,
      displayName: parsed.displayName?.trim() || undefined,
      ownerEmail: parsed.ownerEmail?.trim() || undefined,
      signature: parsed.signature?.trim() || undefined,
      updatedAt: parsed.updatedAt || Date.now(),
    };
  } catch {
    return null;
  }
}

async function readAgentMailRaw(): Promise<string> {
  try {
    return await fs.readFile(AGENT_MAIL_PATH, 'utf-8');
  } catch {
    return fs.readFile(getLegacyAgentMailSecretPath(), 'utf-8');
  }
}

export async function readAgentMailPublicConfig(): Promise<AgentMailPublicConfig | null> {
  const config = await readAgentMailConfig();
  if (!config) return null;

  return {
    email: config.email,
    clientId: config.clientId,
    displayName: config.displayName,
    ownerEmail: config.ownerEmail,
    signature: config.signature,
    hasClientSecret: Boolean(config.clientSecret),
    hasRefreshToken: Boolean(config.refreshToken),
    hasAccessToken: Boolean(config.accessToken),
    updatedAt: config.updatedAt,
  };
}

export async function writeAgentMailConfig(input: {
  email: string;
  clientId: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  authorizationCode?: string;
  redirectUri?: string;
  displayName?: string;
  ownerEmail?: string;
  signature?: string;
}): Promise<AgentMailPublicConfig> {
  const existing = await readAgentMailConfig();
  const nextClientSecret = input.clientSecret?.trim() || existing?.clientSecret || '';
  if (!input.email.trim() || !input.clientId.trim()) {
    throw new Error('email and clientId are required');
  }

  let nextRefreshToken = input.refreshToken?.trim() || existing?.refreshToken || '';
  let nextAccessToken = input.accessToken?.trim() || existing?.accessToken || '';

  const authorizationCode = input.authorizationCode?.trim() || '';
  const redirectUri = input.redirectUri?.trim() || '';
  if (authorizationCode) {
    if (!nextClientSecret) {
      throw new Error('clientSecret is required to exchange an authorization code');
    }
    if (!redirectUri) {
      throw new Error('redirectUri is required to exchange an authorization code');
    }

    const exchanged = await exchangeAuthorizationCode({
      clientId: input.clientId.trim(),
      clientSecret: nextClientSecret,
      authorizationCode,
      redirectUri,
    });
    nextAccessToken = exchanged.accessToken;
    nextRefreshToken = exchanged.refreshToken || nextRefreshToken;
    if (!nextRefreshToken) {
      throw new Error(
        'Google did not return a refresh token. Re-authorize with access_type=offline and prompt=consent.',
      );
    }
  }

  const payload: AgentMailSecretConfig = {
    email: input.email.trim(),
    clientId: input.clientId.trim(),
    clientSecret: nextClientSecret || undefined,
    refreshToken: nextRefreshToken || undefined,
    accessToken: nextAccessToken || undefined,
    authorizationCode: authorizationCode || existing?.authorizationCode || undefined,
    redirectUri: redirectUri || existing?.redirectUri || undefined,
    displayName: input.displayName?.trim() || undefined,
    ownerEmail: input.ownerEmail?.trim() || undefined,
    signature: input.signature?.trim() || undefined,
    updatedAt: Date.now(),
  };

  if (payload.refreshToken) {
    payload.authorizationCode = undefined;
  }

  await fs.mkdir(path.dirname(AGENT_MAIL_PATH), { recursive: true });
  await ensureRuntimeSecretsDir();
  await fs.writeFile(AGENT_MAIL_PATH, JSON.stringify(payload, null, 2), 'utf-8');

  return {
    email: payload.email,
    clientId: payload.clientId,
    displayName: payload.displayName,
    ownerEmail: payload.ownerEmail,
    signature: payload.signature,
    hasClientSecret: Boolean(payload.clientSecret),
    hasRefreshToken: Boolean(payload.refreshToken),
    hasAccessToken: Boolean(payload.accessToken),
    updatedAt: payload.updatedAt,
  };
}

async function exchangeAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  authorizationCode: string;
  redirectUri: string;
}): Promise<{ accessToken: string; refreshToken?: string }> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.authorizationCode,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const payload = (await response.json().catch(() => null)) as
    | { access_token?: string; refresh_token?: string; error?: string; error_description?: string }
    | null;

  if (!response.ok || !payload?.access_token) {
    const details = payload?.error_description || payload?.error || `HTTP ${response.status}`;
    throw new Error(`Failed to exchange authorization code: ${details}`);
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
  };
}
