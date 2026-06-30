"use client";

import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { AgentCard } from "@/components/agent-card";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";
import { AgentSnapshot, SystemStatus, Task } from "@/lib/types";

function mergeAgents(agents: AgentSnapshot[]): AgentSnapshot[] {
  const byId = new Map<string, AgentSnapshot>();
  for (const agent of agents) {
    byId.set(agent.id, agent);
  }
  return [...byId.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}

function mergeTasks(tasks: Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    byId.set(task.id, task);
  }
  return [...byId.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [nextAgents, nextSystem, nextTasks] = await Promise.all([
          api.getAgents(),
          api.getSystemStatus(),
          api.getTasks(),
        ]);
        if (!cancelled) {
          setAgents(mergeAgents(nextAgents));
          setSystem(nextSystem);
          setTasks(mergeTasks(nextTasks));
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError(`Cannot reach server at ${api.API_BASE}. Is it running?`);
          setSystem(null);
        }
      }
    };

    void load();
    const interval = window.setInterval(load, 6000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const socket = io(api.SOCKET_BASE);

    socket.on("agent:update", (entry: AgentSnapshot) => {
      setAgents((prev) => mergeAgents([...prev.filter((agent) => agent.id !== entry.id), entry]));
    });

    socket.on("task:update", (entry: Task) => {
      setTasks((prev) => mergeTasks([...prev.filter((task) => task.id !== entry.id), entry]));
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const isolatedCount = agents.filter((agent) => agent.isolated).length;
  const activeCount = agents.filter((agent) => agent.phase !== "idle" && agent.phase !== "offline").length;
  const runningTasks = tasks.filter((task) => task.status === "running").slice(0, 3);

  return (
    <AppShell>
      <section className="animate-fade-up rounded-[28px] border border-bg-border bg-bg-surface/85 px-5 py-7 shadow-soft md:px-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="font-display text-4xl leading-none tracking-tight md:text-5xl">
              Agent Team
            </h1>
            <p className="mt-3 text-sm text-text-secondary">
              {agents.length} agents • {isolatedCount} isolated, {Math.max(agents.length - isolatedCount, 0)} shared
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-bg-border bg-[#fbf7f1] px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-dim">Runtime</div>
              <div className="mt-1 text-sm text-text-primary">
                {system?.ready ? "Ready" : "Unavailable"}
              </div>
            </div>
            <div className="rounded-2xl border border-bg-border bg-[#fbf7f1] px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-dim">Workspace</div>
              <div className="mt-1 text-sm capitalize text-text-primary">
                {system?.workspace.status ?? "unknown"}
              </div>
            </div>
            <div className="rounded-2xl border border-bg-border bg-[#fbf7f1] px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-dim">Active Agents</div>
              <div className="mt-1 text-sm text-text-primary">{activeCount}</div>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-2xl border border-rose-300/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-400 font-mono">
            {error}
          </div>
        )}

        <div className="mt-8 grid gap-5 xl:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      </section>

      <section className="mt-6 grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-[24px] border border-bg-border bg-bg-surface/85 p-5 shadow-soft">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-3xl tracking-tight">Current Work</h2>
            <span className="text-xs text-text-secondary">{system?.queue.pendingCount ?? 0} queued</span>
          </div>
          <div className="mt-5 space-y-3">
            {runningTasks.length === 0 && (
              <div className="rounded-2xl border border-dashed border-bg-border px-4 py-5 text-sm text-text-secondary">
                No active tasks right now.
              </div>
            )}
            {runningTasks.map((task) => (
              <div key={task.id} className="rounded-2xl border border-bg-border bg-[#fbf7f1] px-4 py-4">
                <div className="text-sm leading-6 text-text-primary">{task.goal}</div>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-text-secondary">
                  <span className="rounded-full bg-white px-2.5 py-1">status {task.status}</span>
                  <span className="rounded-full bg-white px-2.5 py-1">{task.mode ?? "routing"}</span>
                  <span className="rounded-full bg-white px-2.5 py-1">{task.iterations ?? 0} steps</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[24px] border border-bg-border bg-bg-surface/85 p-5 shadow-soft">
          <h2 className="font-display text-3xl tracking-tight">Signal</h2>
          <div className="mt-5 space-y-4 text-sm text-text-secondary">
            <div className="rounded-2xl bg-[#fbf7f1] px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-dim">Running Tasks</div>
              <div className="mt-2 text-base text-text-primary">{system?.tasks.running ?? 0}</div>
            </div>
            <div className="rounded-2xl bg-[#fbf7f1] px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-dim">Failures</div>
              <div className="mt-2 text-base text-text-primary">
                {(system?.tasks.failed ?? 0) + (system?.tasks.cancelled ?? 0)}
              </div>
            </div>
            <div className="rounded-2xl bg-[#fbf7f1] px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.18em] text-text-dim">Completed</div>
              <div className="mt-2 text-base text-text-primary">{system?.tasks.completed ?? 0}</div>
            </div>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
