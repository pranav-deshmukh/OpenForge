"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";
import { AgentMailConfig } from "@/lib/types";

type MailFormState = {
  email: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  authorizationCode: string;
  redirectUri: string;
  displayName: string;
  ownerEmail: string;
  signature: string;
};

function toForm(config: AgentMailConfig | null): MailFormState {
  return {
    email: config?.email ?? "",
    clientId: config?.clientId ?? "",
    clientSecret: "",
    refreshToken: "",
    accessToken: "",
    authorizationCode: "",
    redirectUri: "",
    displayName: config?.displayName ?? "",
    ownerEmail: config?.ownerEmail ?? "",
    signature: config?.signature ?? "",
  };
}

export default function MailPage() {
  const [config, setConfig] = useState<AgentMailConfig | null>(null);
  const [form, setForm] = useState<MailFormState>(toForm(null));
  const [status, setStatus] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const next = await api.getAgentMailConfig();
        setConfig(next);
        setForm(toForm(next));
      } catch {
        setStatus("Failed to load agent mail settings.");
      }
    };

    void load();
  }, []);

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSaving) return;

    setIsSaving(true);
    setStatus("");
    try {
      const saved = await api.saveAgentMailConfig(form);
      setConfig(saved);
      setForm((current) => ({
        ...current,
        clientSecret: "",
        refreshToken: "",
        accessToken: "",
        authorizationCode: "",
      }));
      setStatus("Agent mailbox saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save settings.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
        <div>
          <h1 className="font-display text-4xl tracking-tight text-text-primary">Agent Mail</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
            Store one Gmail account for the agent. The <span className="font-mono">gmail-assistant</span> skill will use Google OAuth token refresh and the Gmail API instead of SMTP, and the credentials are kept outside the shared workspace.
          </p>
        </div>

        <form onSubmit={handleSave} className="rounded-[28px] border border-bg-border bg-bg-surface p-6 shadow-soft">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm text-text-secondary">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-dim">Gmail Address</span>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="rounded-2xl border border-bg-border bg-bg-base px-4 py-3 text-text-primary outline-none focus:border-accent-gold"
                placeholder="agent@gmail.com"
                required
              />
            </label>

            <label className="flex flex-col gap-2 text-sm text-text-secondary">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-dim">OAuth Client ID</span>
              <input
                type="text"
                value={form.clientId}
                onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                className="rounded-2xl border border-bg-border bg-bg-base px-4 py-3 text-text-primary outline-none focus:border-accent-gold"
                placeholder="Google OAuth client id"
                required
              />
            </label>

            <label className="flex flex-col gap-2 text-sm text-text-secondary">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-dim">OAuth Client Secret</span>
              <input
                type="password"
                value={form.clientSecret}
                onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
                className="rounded-2xl border border-bg-border bg-bg-base px-4 py-3 text-text-primary outline-none focus:border-accent-gold"
                placeholder={config?.hasClientSecret ? "Leave blank to keep current client secret" : "Google OAuth client secret"}
              />
            </label>

            <label className="flex flex-col gap-2 text-sm text-text-secondary">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-dim">Refresh Token</span>
              <input
                type="password"
                value={form.refreshToken}
                onChange={(e) => setForm({ ...form, refreshToken: e.target.value })}
                className="rounded-2xl border border-bg-border bg-bg-base px-4 py-3 text-text-primary outline-none focus:border-accent-gold"
                placeholder={config?.hasRefreshToken ? "Leave blank to keep current refresh token" : "Optional if using auth code exchange"}
              />
            </label>

            <label className="flex flex-col gap-2 text-sm text-text-secondary">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-dim">Access Token</span>
              <input
                type="password"
                value={form.accessToken}
                onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
                className="rounded-2xl border border-bg-border bg-bg-base px-4 py-3 text-text-primary outline-none focus:border-accent-gold"
                placeholder={config?.hasAccessToken ? "Optional override cached token" : "Optional cached access token"}
              />
            </label>

            <label className="flex flex-col gap-2 text-sm text-text-secondary">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-dim">Authorization Code</span>
              <input
                type="password"
                value={form.authorizationCode}
                onChange={(e) => setForm({ ...form, authorizationCode: e.target.value })}
                className="rounded-2xl border border-bg-border bg-bg-base px-4 py-3 text-text-primary outline-none focus:border-accent-gold"
                placeholder="Paste one-time OAuth code to mint refresh token"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm text-text-secondary">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-dim">Redirect URI</span>
              <input
                type="text"
                value={form.redirectUri}
                onChange={(e) => setForm({ ...form, redirectUri: e.target.value })}
                className="rounded-2xl border border-bg-border bg-bg-base px-4 py-3 text-text-primary outline-none focus:border-accent-gold"
                placeholder="Must exactly match the OAuth redirect URI used for the auth code"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm text-text-secondary">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-dim">Display Name</span>
              <input
                type="text"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                className="rounded-2xl border border-bg-border bg-bg-base px-4 py-3 text-text-primary outline-none focus:border-accent-gold"
                placeholder="Forge Agent"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm text-text-secondary">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-dim">Owner Email</span>
              <input
                type="email"
                value={form.ownerEmail}
                onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })}
                className="rounded-2xl border border-bg-border bg-bg-base px-4 py-3 text-text-primary outline-none focus:border-accent-gold"
                placeholder="your@email.com"
              />
            </label>
          </div>

          <label className="mt-4 flex flex-col gap-2 text-sm text-text-secondary">
            <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-dim">Signature</span>
            <textarea
              value={form.signature}
              onChange={(e) => setForm({ ...form, signature: e.target.value })}
              className="min-h-[140px] rounded-3xl border border-bg-border bg-bg-base px-4 py-3 text-text-primary outline-none focus:border-accent-gold"
              placeholder="Sent by Forge"
            />
          </label>

          <div className="mt-6 flex items-center justify-between gap-4">
            <div className="text-xs text-text-dim">
              {config?.hasRefreshToken ? "OAuth tokens configured." : "OAuth tokens not configured yet."}
            </div>
            <button
              type="submit"
              disabled={isSaving}
              className="rounded-2xl bg-[#2b2620] px-6 py-3 font-mono text-xs font-bold uppercase tracking-[0.24em] text-white transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? "Saving..." : "Save Mailbox"}
            </button>
          </div>

          <div className="mt-4 text-xs leading-6 text-text-dim">
            Required Google scope: <span className="font-mono">https://www.googleapis.com/auth/gmail.modify</span>
          </div>

          <div className="mt-2 text-xs leading-6 text-text-dim">
            To auto-generate a refresh token, obtain an OAuth authorization code using
            {" "}
            <span className="font-mono">access_type=offline</span>
            {" "}
            and
            {" "}
            <span className="font-mono">prompt=consent</span>
            , then save it here with the matching redirect URI.
          </div>

          <div className="mt-2 text-xs leading-6 text-text-dim">
            Mail secrets are stored on the server and mounted into the runtime separately from <span className="font-mono">/workspace</span>.
          </div>

          {status ? <div className="mt-3 text-sm text-text-secondary">{status}</div> : null}
        </form>
      </div>
    </AppShell>
  );
}
