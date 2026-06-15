"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/lib/api";
import { SystemStatus, Task } from "@/lib/types";
import { relativeTime } from "@/lib/time";

type NavItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
};

type NavSection = {
  label: string;
  items: NavItem[];
};

function IconFrame({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-4 w-4 items-center justify-center text-text-secondary">
      {children}
    </span>
  );
}

const navSections: NavSection[] = [
  {
    label: "Launch",
    items: [
      { href: "/", label: "New Mission", icon: <IconFrame>◈</IconFrame> },
    ],
  },
  {
    label: "Overview",
    items: [
      { href: "/agents", label: "Agent Team", icon: <IconFrame>⌂</IconFrame> },
      { href: "/briefings", label: "Agent Activity", icon: <IconFrame>≡</IconFrame> },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/tasks", label: "Tasks", icon: <IconFrame>✓</IconFrame> },
      { href: "/memory", label: "Memory", icon: <IconFrame>⌘</IconFrame> },
      { href: "/workspace", label: "Workspace", icon: <IconFrame>◫</IconFrame> },
    ],
  },
  {
    label: "Configuration",
    items: [
      { href: "/skills", label: "Coding", icon: <IconFrame>{"</>"}</IconFrame> },
      { href: "/github", label: "GitHub", icon: <IconFrame>#</IconFrame> },
      { href: "/mail", label: "Agent Mail", icon: <IconFrame>@</IconFrame> },
    ],
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [notifications, setNotifications] = useState<TaskNotification[]>([]);
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const knownCompletedTaskIdsRef = useRef<Set<string>>(new Set());
  const notificationsInitializedRef = useRef(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(TASK_NOTIFICATIONS_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as TaskNotification[];
      if (Array.isArray(parsed)) {
        setNotifications(parsed);
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(TASK_NOTIFICATIONS_KEY, JSON.stringify(notifications));
    } catch {}
  }, [notifications]);

  useEffect(() => {
    let cancelled = false;

    const loadStatus = async () => {
      try {
        const next = await api.getSystemStatus();
        if (!cancelled) {
          setSystem(next);
        }
      } catch {
        if (!cancelled) {
          setSystem(null);
        }
      }
    };

    void loadStatus();
    const interval = window.setInterval(loadStatus, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const syncTaskNotifications = async () => {
      try {
        const tasks = await api.getTasks();
        if (cancelled) return;
        setNotifications((current) => mergeTaskNotifications(current, tasks, knownCompletedTaskIdsRef, notificationsInitializedRef));
      } catch {}
    };

    void syncTaskNotifications();
    const interval = window.setInterval(syncTaskNotifications, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const failedCount = (system?.tasks.failed ?? 0) + (system?.tasks.cancelled ?? 0);
  const unreadCount = notifications.filter((notification) => !notification.read).length;
  const recentNotifications = useMemo(() => notifications.slice(0, 8), [notifications]);

  return (
    <div className="h-screen overflow-hidden">
      <div className="mx-auto flex h-full max-w-[1600px]">
        <aside className="glass-panel hidden w-[184px] shrink-0 overflow-y-auto border-r border-bg-border px-5 py-7 md:block">
          <div className="mb-10 flex items-center justify-between gap-3">
            <Link href="/agents" className="flex items-center gap-2">
              <span className="font-display text-[2rem] leading-none tracking-tight">Forge</span>
              <span className="mt-2 h-2.5 w-2.5 rounded-full bg-accent-gold" />
            </Link>
            <div>
              <button
                type="button"
                onClick={() => {
                  setIsNotificationOpen((current) => !current);
                  setNotifications((current) => current.map((notification) => ({ ...notification, read: true })));
                }}
                className="relative flex h-10 w-10 items-center justify-center rounded-full border border-bg-border bg-bg-surface text-text-secondary transition hover:text-text-primary"
                aria-label="Open notifications"
              >
                <span className="text-base">◔</span>
                {unreadCount > 0 ? (
                  <span className="absolute -right-1 -top-1 min-w-[18px] rounded-full bg-[#cb5f51] px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-white">
                    {unreadCount}
                  </span>
                ) : null}
              </button>
            </div>
          </div>

          {isNotificationOpen ? (
            <div className="mb-6 rounded-3xl border border-bg-border bg-bg-surface p-4 shadow-soft">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-text-primary">Notifications</div>
                <span className="text-[10px] uppercase tracking-[0.22em] text-text-dim">
                  {unreadCount > 0 ? `${unreadCount} new` : "all caught up"}
                </span>
              </div>
              <div className="space-y-2">
                {recentNotifications.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-bg-border px-4 py-6 text-sm text-text-dim">
                    Completed tasks will appear here.
                  </div>
                ) : (
                  recentNotifications.map((notification) => (
                    <Link
                      key={notification.id}
                      href="/tasks"
                      onClick={() => setIsNotificationOpen(false)}
                      className="block rounded-2xl border border-bg-border bg-bg-base px-4 py-3 transition hover:border-text-dim"
                    >
                      <div className="mb-1 text-xs uppercase tracking-[0.18em] text-emerald-600">
                        Task completed
                      </div>
                      <div className="line-clamp-3 text-sm text-text-primary">{notification.goal}</div>
                      <div className="mt-2 text-xs text-text-dim">
                        {relativeTime(notification.completedAt)}
                      </div>
                    </Link>
                  ))
                )}
              </div>
            </div>
          ) : null}

          <nav className="space-y-8">
            {navSections.map((section) => (
              <section key={section.label}>
                <div className="mb-3 text-[10px] uppercase tracking-[0.22em] text-text-dim">
                  {section.label}
                </div>
                <div className="space-y-1">
                  {section.items.map((item) => {
                    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                    return (
                      <Link
                        key={`${section.label}-${item.label}`}
                        href={item.href}
                        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] transition ${
                          active
                            ? "bg-[#ede6dc] text-text-primary"
                            : "text-text-secondary hover:bg-[#f1ebe3] hover:text-text-primary"
                        }`}
                      >
                        {item.icon}
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </nav>

          {/* <div className="mt-8">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#cb5f51] bg-[#d35c4d] px-4 py-2 text-xs text-white shadow-soft">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-white/40 bg-white/10">
                {failedCount}
              </span>
              <span>{failedCount === 1 ? "Issue" : "Issues"}</span>
            </div>
          </div> */}
        </aside>

        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-4 md:px-7 md:py-6">
          <header className="mb-5 flex items-center justify-between rounded-2xl border border-bg-border bg-bg-surface/80 px-4 py-3 shadow-soft md:hidden">
            <Link href="/agents" className="flex items-center gap-2">
              <span className="font-display text-2xl tracking-tight">Forge</span>
              <span className="mt-1 h-2 w-2 rounded-full bg-accent-gold" />
            </Link>
            <div className="text-xs text-text-secondary">
              {system?.workspace.status === "running" ? "Workspace ready" : "Workspace offline"}
            </div>
          </header>

          <main>{children}</main>
        </div>
      </div>

      <button
        type="button"
        className="fixed bottom-5 right-5 flex h-14 w-14 items-center justify-center rounded-full bg-[#2b2620] text-lg text-white shadow-soft transition hover:translate-y-[-1px]"
        aria-label="Open chat"
      >
        ◫
      </button>
    </div>
  );
}

type TaskNotification = {
  id: string;
  goal: string;
  completedAt: number;
  read: boolean;
};

const TASK_NOTIFICATIONS_KEY = "forge.task-notifications";

function mergeTaskNotifications(
  current: TaskNotification[],
  tasks: Task[],
  knownCompletedTaskIdsRef: React.MutableRefObject<Set<string>>,
  notificationsInitializedRef: React.MutableRefObject<boolean>,
): TaskNotification[] {
  const currentIds = new Set(current.map((notification) => notification.id));
  const completedTasks = tasks.filter((task) => task.status === "done" && task.completedAt);

  if (!notificationsInitializedRef.current) {
    for (const task of completedTasks) {
      knownCompletedTaskIdsRef.current.add(task.id);
    }
    notificationsInitializedRef.current = true;
    return current;
  }

  const additions: TaskNotification[] = [];
  for (const task of completedTasks) {
    if (knownCompletedTaskIdsRef.current.has(task.id) || currentIds.has(task.id) || !task.completedAt) {
      continue;
    }
    knownCompletedTaskIdsRef.current.add(task.id);
    additions.unshift({
      id: task.id,
      goal: task.goal,
      completedAt: task.completedAt,
      read: false,
    });
  }

  if (additions.length === 0) {
    return current;
  }

  return [...additions, ...current].slice(0, 20);
}
