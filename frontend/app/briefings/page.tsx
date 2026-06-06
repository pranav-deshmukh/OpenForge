"use client";

import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { AgentActivityCard } from "@/components/agent-activity-card";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";
import { AgentActivitySnapshot, SystemStatus } from "@/lib/types";

function mergeAgents(agents: AgentActivitySnapshot[]): AgentActivitySnapshot[] {
  const byId = new Map<string, AgentActivitySnapshot>();
  for (const agent of agents) {
    byId.set(agent.id, agent);
  }
  return [...byId.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}

export default function BriefingsPage() {
  const [agents, setAgents] = useState<AgentActivitySnapshot[]>([]);
  const [system, setSystem] = useState<SystemStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [nextAgents, nextSystem] = await Promise.all([
          api.getAgentActivity(),
          api.getSystemStatus(),
        ]);
        if (!cancelled) {
          setAgents(mergeAgents(nextAgents));
          setSystem(nextSystem);
        }
      } catch {
        if (!cancelled) {
          setAgents([]);
          setSystem(null);
        }
      }
    };

    void load();
    const interval = window.setInterval(load, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const socket = io(api.SOCKET_BASE);
    const refresh = async () => {
      try {
        const nextAgents = await api.getAgentActivity();
        setAgents(mergeAgents(nextAgents));
      } catch {}
    };

    socket.on("agent:update", refresh);
    socket.on("task:memory", refresh);
    socket.on("subtask:update", refresh);

    return () => {
      socket.disconnect();
    };
  }, []);

  const engagedAgents = agents.filter((agent) => agent.phase !== "idle" && agent.phase !== "offline").length;

  return (
    <AppShell>
      <section className="animate-fade-up rounded-[28px] border border-bg-border bg-bg-surface/85 px-5 py-7 shadow-soft md:px-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="font-display text-4xl leading-none tracking-tight md:text-5xl">
              Agent Briefings
            </h1>
            <p className="mt-3 text-sm text-text-secondary">
              Live view of what each agent is doing when it is assigned work.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-bg-border bg-[#fbf7f1] px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-dim">Engaged</div>
              <div className="mt-1 text-sm text-text-primary">{engagedAgents}</div>
            </div>
            <div className="rounded-2xl border border-bg-border bg-[#fbf7f1] px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-dim">Running Tasks</div>
              <div className="mt-1 text-sm text-text-primary">{system?.tasks.running ?? 0}</div>
            </div>
            <div className="rounded-2xl border border-bg-border bg-[#fbf7f1] px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-dim">Queue</div>
              <div className="mt-1 text-sm text-text-primary">{system?.queue.pendingCount ?? 0}</div>
            </div>
          </div>
        </div>

        <div className="mt-8 grid gap-5 xl:grid-cols-3">
          {agents.map((agent) => (
            <AgentActivityCard key={agent.id} agent={agent} />
          ))}
        </div>
      </section>
    </AppShell>
  );
}
