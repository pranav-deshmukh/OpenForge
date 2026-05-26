"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import { SystemStatus, Task } from "@/lib/types";

type NavItem = {
  href: string;
  label: string;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home" },
  { href: "/tasks", label: "Tasks" },
  { href: "/feed", label: "Activity" },
  { href: "/workspace", label: "Workspace" },
  { href: "/memory", label: "Memory" },
  { href: "/skills", label: "Skills" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [system, setSystem] = useState<SystemStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchState = async () => {
      try {
        const [fetchedTasks, fetchedSystem] = await Promise.all([
          api.getTasks(),
          api.getSystemStatus(),
        ]);
        if (!cancelled) {
          setTasks(fetchedTasks || []);
          setSystem(fetchedSystem);
        }
      } catch {
        if (!cancelled) {
          setSystem(null);
        }
      }
    };

    fetchState();
    const interval = setInterval(fetchState, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const activeTask = useMemo(
    () => tasks.find((task) => task.status === "running") ?? tasks[0] ?? null,
    [tasks],
  );

  const workspaceLabel =
    system?.workspace.status === "running"
      ? "Workspace ready"
      : system?.workspace.status === "stopped"
        ? "Workspace stopped"
        : "Workspace missing";

  return (
    <div className="min-h-screen bg-bg-base text-text-primary">
      <header className="sticky top-0 z-30 border-b border-bg-border bg-bg-base">
        <div className="flex h-14 items-center justify-between gap-4 px-4 md:px-6">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-sm font-semibold tracking-tight">
              OpenForge
            </Link>
            <span className="hidden text-xs text-text-secondary md:inline">
              Autonomous research and engineering assistant
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className={`rounded border px-2 py-1 ${system?.ready ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-zinc-500/30 bg-zinc-500/10 text-zinc-300"}`}>
              {system?.ready ? "Ready" : "Offline"}
            </span>
            <span className={`hidden rounded border px-2 py-1 md:inline ${system?.workspace.status === "running" ? "border-sky-500/30 bg-sky-500/10 text-sky-300" : "border-zinc-500/30 bg-zinc-500/10 text-zinc-300"}`}>
              {workspaceLabel}
            </span>
            <span className="hidden rounded border border-bg-border px-2 py-1 text-text-secondary md:inline">
              Queue {system?.queue.pendingCount ?? 0}
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto flex min-h-[calc(100vh-56px)] max-w-[1600px]">
        <aside className="hidden w-56 shrink-0 border-r border-bg-border md:block">
          <nav className="flex flex-col gap-1 p-3">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded px-3 py-2 text-sm transition-colors ${
                    active
                      ? "bg-bg-surface text-text-primary"
                      : "text-text-secondary hover:bg-bg-surface hover:text-text-primary"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1">{children}</main>

        <aside className="hidden h-[calc(100vh-56px)] w-80 shrink-0 border-l border-bg-border xl:block">
          <div className="flex h-full min-h-0 flex-col p-4">
            <section className="border-b border-bg-border pb-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
                Current task
              </div>
              {activeTask ? (
                <div className="space-y-2">
                  <div className="text-sm leading-6">{activeTask.goal}</div>
                  <div className="flex flex-wrap gap-2 text-xs text-text-secondary">
                    <span className="rounded border border-bg-border px-2 py-1 capitalize">
                      {activeTask.status}
                    </span>
                    <span className="rounded border border-bg-border px-2 py-1">
                      {activeTask.mode ?? "routing"}
                    </span>
                    <span className="rounded border border-bg-border px-2 py-1">
                      {activeTask.iterations ?? 0} steps
                    </span>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-text-secondary">No tasks yet.</div>
              )}
            </section>

            <section className="flex min-h-0 flex-1 flex-col border-b border-bg-border py-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
                Queue
              </div>
              <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
                {(system?.queue.pending ?? []).slice(0, 5).map((task) => (
                  <div key={task.id} className="rounded border border-bg-border px-3 py-2 text-sm">
                    <div className="line-clamp-2">{task.goal}</div>
                    <div className="mt-1 text-xs text-text-secondary">
                      Waiting
                    </div>
                  </div>
                ))}
                {(system?.queue.pendingCount ?? 0) === 0 && (
                  <div className="text-sm text-text-secondary">No queued tasks.</div>
                )}
              </div>
            </section>

            <section className="min-h-0 py-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
                Recent tasks
              </div>
              <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                {tasks.slice(0, 6).map((task) => (
                  <div key={task.id} className="rounded border border-bg-border px-3 py-2 text-sm">
                    <div className="line-clamp-2">{task.goal}</div>
                    <div className="mt-1 text-xs capitalize text-text-secondary">
                      {task.status}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </aside>
      </div>

      <nav className="fixed bottom-0 left-0 right-0 z-30 flex h-14 items-center justify-around border-t border-bg-border bg-bg-surface md:hidden">
        {NAV_ITEMS.slice(0, 4).map((item) => {
          const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`px-2 text-xs ${active ? "text-text-primary" : "text-text-secondary"}`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
