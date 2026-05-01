"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import * as api from "@/lib/api";

type NavItem = {
  href: string;
  label: string;
  icon: string;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "⬡" },
  { href: "/feed", label: "Live Feed", icon: "▶" },
  { href: "/tasks", label: "Tasks", icon: "◈" },
  { href: "/workspace", label: "Workspace", icon: "◉" },
  { href: "/memory", label: "Memory", icon: "◎" },
  { href: "/skills", label: "Skills", icon: "◇" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [activeTask, setActiveTask] = useState<any>(null);
  const [pendingTasks, setPendingTasks] = useState<any[]>([]);
  
  // Minimal polling for active task in shell
  useEffect(() => {
    const fetchActive = async () => {
      try {
        const tasks = await api.getTasks() || [];
        const running = tasks.find((t: any) => t.status === "running") || tasks[0];
        setActiveTask(running || null);
        const pending = tasks.filter((t: any) => t.status === "pending");
        setPendingTasks(pending);
      } catch (err) {
        // ignore
      }
    };
    fetchActive();
    const interval = setInterval(fetchActive, 2000);
    return () => clearInterval(interval);
  }, []);

  const isRunning = activeTask?.status === "running";

  return (
    <div className="min-h-screen bg-bg-base text-text-primary flex flex-col font-sans">
      {/* TOPBAR */}
      <header className="fixed top-0 left-0 right-0 h-12 bg-bg-base border-b border-bg-border z-30 flex items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <div className="font-mono text-sm tracking-[2px]">⬡ OPENFORGE</div>
          <div className="flex items-center gap-2 text-xs font-mono font-medium">
            <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-accent-orange animate-pulse-opacity' : 'bg-text-dim'}`}></span>
            <span className={isRunning ? 'text-accent-orange' : 'text-text-dim'}>
              {isRunning ? 'AGENT ACTIVE' : 'IDLE'}
            </span>
          </div>
        </div>
        <div className="text-xs text-text-secondary font-mono">
          Task {activeTask?.id || '-'} running
        </div>
      </header>

      {/* BODY */}
      <div className="flex flex-1 pt-12 pb-14 md:pb-0">
        
        {/* LEFT SIDEBAR (desktop) */}
        <aside className="hidden md:flex flex-col w-[220px] fixed top-12 bottom-0 left-0 border-r border-bg-border bg-bg-base py-4">
          <nav className="flex-1 flex flex-col px-2 gap-1 relative">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-2 text-sm transition-all duration-150 ${
                    active 
                      ? "border-l-2 border-accent-purple bg-bg-surface text-text-primary" 
                      : "border-l-2 border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-elevated"
                  }`}
                >
                  <span className="font-mono text-lg leading-none">{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="px-5 pb-2 text-xs text-text-dim font-mono">
            v0.1.0
          </div>
        </aside>

        {/* MAIN CONTENT */}
        <main className="flex-1 md:ml-[220px] bg-bg-base relative min-w-0">
          {children}
        </main>

        {/* RIGHT PANEL (desktop) */}
        {pathname !== "/feed" && (
          <aside className="hidden lg:flex flex-col w-[280px] border-l border-bg-border bg-bg-base min-h-[calc(100vh-48px)] p-4">
            <div className="text-xs font-mono text-text-secondary mb-3 uppercase tracking-wider">Active Task</div>
            {activeTask ? (
              <div className="bg-bg-surface border border-bg-border p-4 mb-6">
                <div className="text-sm line-clamp-2 leading-relaxed mb-3">
                  {activeTask.goal}
                </div>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`px-2 py-0.5 text-[10px] uppercase tracking-wider font-mono font-medium rounded-sm border ${
                    activeTask.status === 'running' ? 'text-accent-orange border-accent-orange/30 bg-accent-orange/10' :
                    activeTask.status === 'completed' ? 'text-accent-green border-accent-green/30 bg-accent-green/10' :
                    activeTask.status === 'failed' ? 'text-accent-red border-accent-red/30 bg-accent-red/10' :
                    'text-text-secondary border-text-dim/30 bg-text-dim/10'
                  }`}>
                    {activeTask.status}
                  </span>
                  <span className="text-[10px] font-mono text-text-dim">0 / 30 iterations</span>
                </div>
                <div className="h-0.5 w-full bg-bg-border overflow-hidden">
                  {isRunning && <div className="h-full bg-accent-purple w-1/3 animate-pulse-opacity"></div>}
                </div>
              </div>
            ) : (
              <div className="text-sm text-text-dim mb-6">No active tasks.</div>
            )}

            <div className="text-xs font-mono text-text-secondary mb-3 uppercase tracking-wider mt-4 flex justify-between">
              <span>Queue</span>
              <span className="text-accent-purple">{pendingTasks.length}</span>
            </div>
            <div className="flex-1 flex flex-col gap-2 overflow-y-auto mb-4">
              {pendingTasks.map(t => (
                <div key={t.id} className="p-3 border border-bg-border bg-bg-surface flex flex-col gap-2 transition-colors hover:border-text-dim/50 cursor-default">
                  <div className="text-sm line-clamp-2 text-text-primary leading-snug">{t.goal}</div>
                  <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider font-mono font-medium rounded-sm border w-fit text-text-secondary border-text-dim/30 bg-text-dim/10">
                    pending
                  </span>
                </div>
              ))}
              {pendingTasks.length === 0 && (
                <div className="text-xs text-text-dim font-mono border border-dashed border-bg-border p-4 text-center">No pending tasks</div>
              )}
            </div>
            <div className="mt-auto pt-4 border-t border-bg-border">
              <button 
                onClick={() => {}}
                className="w-full py-2.5 border border-bg-border text-text-secondary hover:text-white hover:bg-white/5 hover:border-text-dim transition-colors text-sm font-mono tracking-wider font-medium"
              >
                + ADD TASK
              </button>
            </div>
          </aside>
        )}
      </div>

      {/* BOTTOM TAB BAR (mobile) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-14 bg-bg-surface border-t border-bg-border flex items-center justify-around z-30">
        {NAV_ITEMS.slice(0, 4).map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center w-full h-full gap-1 transition-colors ${
                active ? "text-accent-purple" : "text-text-secondary"
              }`}
            >
              <span className="font-mono text-lg leading-none">{item.icon}</span>
              <span className="text-[10px] font-mono uppercase tracking-wider">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
