"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";
import { GithubAuthConfig, GithubRuntimeHealth } from "@/lib/types";
import { relativeTime } from "@/lib/time";

type GithubFormState = {
  token: string;
  username: string;
  email: string;
};

function toForm(config: GithubAuthConfig | null): GithubFormState {
  return {
    token: "",
    username: config?.username ?? "",
    email: config?.email ?? "",
  };
}

export default function GithubPage() {
  const [config, setConfig] = useState<GithubAuthConfig | null>(null);
  const [health, setHealth] = useState<GithubRuntimeHealth | null>(null);
  const [form, setForm] = useState<GithubFormState>(toForm(null));
  const [status, setStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshingHealth, setIsRefreshingHealth] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const [next, nextHealth] = await Promise.all([
          api.getGithubAuthConfig(),
          api.getGithubRuntimeHealth(),
        ]);
        setConfig(next);
        setForm(toForm(next));
        setHealth(nextHealth);
      } catch {
        setStatus("Failed to load GitHub settings.");
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
      const saved = await api.saveGithubAuthConfig(form);
      const nextHealth = await api.getGithubRuntimeHealth();
      setConfig(saved);
      setHealth(nextHealth);
      setForm((current) => ({ ...current, token: "" }));
      setStatus("GitHub credentials saved and provisioned to the workspace runtime.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save GitHub settings.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleRefreshHealth = async () => {
    if (isRefreshingHealth) return;
    setIsRefreshingHealth(true);
    try {
      setHealth(await api.getGithubRuntimeHealth());
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to refresh GitHub runtime health.");
    } finally {
      setIsRefreshingHealth(false);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
        <div>
          <h1 className="font-display text-4xl tracking-tight text-text-primary">GitHub Auth</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
            Store GitHub credentials on the server and provision them into the Docker runtime without exposing them in the shared workspace.
          </p>
        </div>

        <form onSubmit={handleSave} className="rounded-[28px] border border-bg-border bg-bg-surface p-6 shadow-soft">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm text-text-secondary md:col-span-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-dim">GitHub Token</span>
              <input
                type="password"
                value={form.token}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
                className="rounded-2xl border border-bg-border bg-bg-base px-4 py-3 text-text-primary outline-none focus:border-accent-gold"
                placeholder={config?.hasToken ? "Leave blank to keep current token" : "Personal access token"}
              />
            </label>

            <label className="flex flex-col gap-2 text-sm text-text-secondary">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-dim">Git Username</span>
              <input
                type="text"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                className="rounded-2xl border border-bg-border bg-bg-base px-4 py-3 text-text-primary outline-none focus:border-accent-gold"
                placeholder="Your git user.name"
                required
              />
            </label>

            <label className="flex flex-col gap-2 text-sm text-text-secondary">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-dim">Git Email</span>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="rounded-2xl border border-bg-border bg-bg-base px-4 py-3 text-text-primary outline-none focus:border-accent-gold"
                placeholder="you@example.com"
                required
              />
            </label>
          </div>

          <div className="mt-6 flex items-center justify-between gap-4">
            <div className="text-xs text-text-dim">
              {config?.hasToken ? "Token stored privately and injected at runtime." : "GitHub token not configured yet."}
            </div>
            <button
              type="submit"
              disabled={isSaving}
              className="rounded-2xl bg-[#2b2620] px-6 py-3 font-mono text-xs font-bold uppercase tracking-[0.24em] text-white transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? "Saving..." : "Save GitHub Auth"}
            </button>
          </div>

          <div className="mt-4 text-xs leading-6 text-text-dim">
            The token is stored outside the shared workspace and made available to the container at runtime for <span className="font-mono">gh</span> and <span className="font-mono">git</span>.
          </div>

          {status ? <div className="mt-3 text-sm text-text-secondary">{status}</div> : null}
        </form>

        <section className="rounded-[28px] border border-bg-border bg-bg-surface p-6 shadow-soft">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-2xl tracking-tight text-text-primary">Runtime Health</h2>
              <p className="mt-2 text-sm leading-6 text-text-secondary">
                Verify that GitHub auth is not only saved on the server but also visible inside the Docker runtime.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleRefreshHealth()}
              disabled={isRefreshingHealth}
              className="rounded-2xl border border-bg-border bg-bg-base px-4 py-2 font-mono text-[11px] uppercase tracking-[0.22em] text-text-primary transition hover:border-text-dim disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRefreshingHealth ? "Checking..." : "Refresh Health"}
            </button>
          </div>

          {health ? (
            <>
              <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
                <HealthItem label="Server token saved" ok={health.serverHasToken} detail={health.serverHasToken ? "Present" : "Missing"} />
                <HealthItem label="Container running" ok={health.containerStatus === "running"} detail={health.containerStatus} />
                <HealthItem label="Secret mount present" ok={health.secretsMountPresent} detail={health.secretsMountPresent ? "/run/openforge mounted" : "Missing mount"} />
                <HealthItem label="GH_TOKEN in container" ok={health.ghTokenVisible} detail={health.ghTokenVisible ? "Visible" : "Missing"} />
                <HealthItem label="gh installed" ok={health.ghInstalled} detail={health.ghInstalled ? "Installed" : "Missing"} />
                <HealthItem label="gh auth ready" ok={health.ghAuthReady} detail={health.ghAuthReady ? "Ready" : "Not authenticated"} />
                <HealthItem label="git identity ready" ok={health.gitIdentityReady} detail={health.gitIdentityReady ? `${health.gitUserName} <${health.gitUserEmail}>` : "Missing name or email"} />
                <HealthItem label="Saved git identity" ok={Boolean(health.serverUsername && health.serverEmail)} detail={health.serverUsername && health.serverEmail ? `${health.serverUsername} <${health.serverEmail}>` : "Missing on server"} />
              </div>

              <div className="mt-5 rounded-3xl border border-bg-border bg-bg-base p-4">
                <div className="text-[11px] font-mono uppercase tracking-[0.24em] text-text-dim">Notes</div>
                <div className="mt-3 space-y-2 text-sm text-text-secondary">
                  {health.notes.map((note) => (
                    <div key={note}>{note}</div>
                  ))}
                </div>
                <div className="mt-4 text-xs text-text-dim">
                  Last checked {relativeTime(health.checkedAt)}
                </div>
              </div>
            </>
          ) : (
            <div className="mt-6 text-sm text-text-dim">Runtime health has not been loaded yet.</div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function HealthItem({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="rounded-3xl border border-bg-border bg-bg-base p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-text-primary">{label}</div>
        <div
          className={`rounded-full px-2 py-1 text-[10px] font-mono uppercase tracking-[0.18em] ${
            ok ? "bg-emerald-500/10 text-emerald-600" : "bg-rose-500/10 text-rose-500"
          }`}
        >
          {ok ? "OK" : "Fail"}
        </div>
      </div>
      <div className="mt-2 text-xs text-text-dim">{detail}</div>
    </div>
  );
}
