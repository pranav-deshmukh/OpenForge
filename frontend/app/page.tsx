"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createResearchTask, getTask, getTaskMemory, getTasks } from "@/lib/api";
import { MemoryEntry, Task, TaskStatus } from "@/lib/types";
import { relativeTime } from "@/lib/time";
import { MemoryMarkdown } from "@/components/memory-markdown";

type Tab = "interface" | "working" | "memory";
type StepKind = "thought" | "research" | "code" | "output" | "error" | "summary";

type CombinedMemoryEntry = MemoryEntry & {
  taskGoal: string;
  stepKind: StepKind;
};

const STEP_STYLES: Record<StepKind, { border: string; badge: string; icon: string }> = {
  thought: { border: "border-violet-500", badge: "bg-violet-500/20 text-violet-200", icon: "TH" },
  research: { border: "border-blue-500", badge: "bg-blue-500/20 text-blue-200", icon: "RS" },
  code: { border: "border-emerald-500", badge: "bg-emerald-500/20 text-emerald-200", icon: "</>" },
  output: { border: "border-zinc-500", badge: "bg-zinc-500/20 text-zinc-200", icon: "OT" },
  error: { border: "border-rose-500", badge: "bg-rose-500/20 text-rose-200", icon: "ER" },
  summary: { border: "border-amber-500", badge: "bg-amber-500/20 text-amber-200", icon: "SM" },
};

function inferStepKind(entry: MemoryEntry): StepKind {
  if (entry.type === "research") return "research";
  if (entry.type === "summary") return "summary";

  const content = entry.content.toLowerCase();
  if (content.includes("error") || content.includes("failed") || content.includes("exception")) return "error";
  if (content.includes("```") || content.includes("code:")) return "code";
  if (content.includes("output") || content.includes("stdout") || content.includes("stderr")) return "output";
  if (content.includes("thought") || content.includes("plan") || content.includes("reason")) return "thought";
  return "output";
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-GB", { hour12: false });
}

function truncate(text: string, max = 120): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function StatusBadge({ status }: { status: TaskStatus }) {
  if (status === "running" || status === "pending") {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-violet-400/35 bg-violet-500/15 px-3 py-1 text-xs text-violet-200">
        <span className="h-1.5 w-1.5 rounded-full bg-violet-300 animate-pulse" />
        Thinking...
      </div>
    );
  }

  if (status === "done") {
    return (
      <div className="inline-flex rounded-full border border-emerald-400/35 bg-emerald-500/15 px-3 py-1 text-xs text-emerald-200">
        Done
      </div>
    );
  }

  return (
    <div className="inline-flex rounded-full border border-rose-400/35 bg-rose-500/15 px-3 py-1 text-xs text-rose-200">
      Failed
    </div>
  );
}

export default function AgentUiPage() {
  const [activeTab, setActiveTab] = useState<Tab>("interface");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskMemoryMap, setTaskMemoryMap] = useState<Record<string, MemoryEntry[]>>({});
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);

  const [chatInput, setChatInput] = useState("");
  const [optimisticTasks, setOptimisticTasks] = useState<Array<{ tempId: string; goal: string; createdAt: number }>>([]);
  const [isSending, setIsSending] = useState(false);

  const [interfaceError, setInterfaceError] = useState<string | null>(null);
  const [workingError, setWorkingError] = useState<string | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryFilter, setMemoryFilter] = useState<"all" | StepKind>("all");
  const [expandedMemory, setExpandedMemory] = useState<Record<string, boolean>>({});

  const workingFeedRef = useRef<HTMLDivElement | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const list = await getTasks();
      setTasks(list);
      setInterfaceError(null);
    } catch (err) {
      setInterfaceError(err instanceof Error ? err.message : "Failed to load tasks.");
    }
  }, []);

  const loadTaskMemory = useCallback(async (taskId: string) => {
    try {
      const entries = await getTaskMemory(taskId);
      setTaskMemoryMap((prev) => ({ ...prev, [taskId]: entries }));
      setWorkingError(null);
      return entries;
    } catch (err) {
      setWorkingError(err instanceof Error ? err.message : "Failed to load task memory.");
      throw err;
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    if (currentTaskId && tasks.some((task) => task.id === currentTaskId)) return;
    const running = tasks.find((task) => task.status === "running");
    setCurrentTaskId(running?.id ?? tasks[0]?.id ?? null);
  }, [tasks, currentTaskId]);

  useEffect(() => {
    const runningIds = tasks.filter((task) => task.status === "running").map((task) => task.id);
    if (runningIds.length === 0) return;

    const timer = setInterval(() => {
      void (async () => {
        try {
          const updates = await Promise.all(runningIds.map((id) => getTask(id)));
          setTasks((prev) => prev.map((task) => updates.find((update) => update.id === task.id) ?? task));
        } catch {
          // Keep stale state until next successful refresh.
        }
      })();
    }, 3000);

    return () => clearInterval(timer);
  }, [tasks]);

  useEffect(() => {
    if (!currentTaskId) return;
    const task = tasks.find((item) => item.id === currentTaskId);
    if (!task) return;

    if (!taskMemoryMap[currentTaskId]) {
      void loadTaskMemory(currentTaskId);
    }

    if (task.status !== "running") return;

    const timer = setInterval(() => {
      void loadTaskMemory(currentTaskId);
    }, 2000);

    return () => clearInterval(timer);
  }, [currentTaskId, tasks, taskMemoryMap, loadTaskMemory]);

  useEffect(() => {
    if (activeTab !== "memory") return;
    if (tasks.length === 0) return;

    void (async () => {
      try {
        const rows = await Promise.all(tasks.map(async (task) => ({ id: task.id, entries: await getTaskMemory(task.id) })));
        setTaskMemoryMap((prev) => {
          const next = { ...prev };
          for (const row of rows) next[row.id] = row.entries;
          return next;
        });
        setMemoryError(null);
      } catch (err) {
        setMemoryError(err instanceof Error ? err.message : "Failed to load memory entries.");
      }
    })();
  }, [activeTab, tasks]);

  const currentTask = useMemo(() => tasks.find((task) => task.id === currentTaskId) ?? null, [tasks, currentTaskId]);

  const currentTaskEntries = useMemo(() => {
    if (!currentTaskId) return [];
    return taskMemoryMap[currentTaskId] ?? [];
  }, [currentTaskId, taskMemoryMap]);

  useEffect(() => {
    if (activeTab !== "working") return;
    const box = workingFeedRef.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  }, [activeTab, currentTaskEntries.length]);

  const isAnyTaskRunning = useMemo(() => tasks.some((task) => task.status === "running"), [tasks]);

  const combinedChatItems = useMemo(() => {
    const committed = tasks.map((task) => ({
      id: task.id,
      goal: task.goal,
      status: task.status,
      createdAt: task.createdAt,
      agentMessage: (taskMemoryMap[task.id] ?? []).slice(-1)[0]?.content ?? "Task accepted. I will start working on this now.",
    }));

    const pending = optimisticTasks.map((item) => ({
      id: item.tempId,
      goal: item.goal,
      status: "running" as const,
      createdAt: item.createdAt,
      agentMessage: "Task accepted. I will start working on this now.",
    }));

    return [...committed, ...pending].sort((a, b) => a.createdAt - b.createdAt);
  }, [tasks, optimisticTasks, taskMemoryMap]);

  const allMemoryEntries = useMemo<CombinedMemoryEntry[]>(() => {
    return tasks
      .flatMap((task) => {
        const entries = taskMemoryMap[task.id] ?? [];
        return entries.map((entry) => ({ ...entry, taskGoal: task.goal, stepKind: inferStepKind(entry) }));
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [tasks, taskMemoryMap]);

  const filteredMemoryEntries = useMemo(() => {
    if (memoryFilter === "all") return allMemoryEntries;
    return allMemoryEntries.filter((entry) => entry.stepKind === memoryFilter);
  }, [allMemoryEntries, memoryFilter]);

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const goal = chatInput.trim();
    if (!goal) return;

    setChatInput("");
    setIsSending(true);
    setInterfaceError(null);

    const tempId = `temp-${Date.now()}`;
    setOptimisticTasks((prev) => [...prev, { tempId, goal, createdAt: Date.now() }]);

    try {
      const task = await createResearchTask(goal);
      setOptimisticTasks((prev) => prev.filter((item) => item.tempId !== tempId));
      setTasks((prev) => [task, ...prev]);
      setCurrentTaskId(task.id);
    } catch (err) {
      setOptimisticTasks((prev) => prev.filter((item) => item.tempId !== tempId));
      setInterfaceError(err instanceof Error ? err.message : "Failed to submit task.");
    } finally {
      setIsSending(false);
    }
  };

  const renderTabButton = (tab: Tab, label: string) => {
    const selected = activeTab === tab;
    return (
      <button
        key={tab}
        onClick={() => setActiveTab(tab)}
        className={`rounded-full px-4 py-2 text-sm transition ${
          selected
            ? "bg-violet-500 text-white shadow-[0_0_20px_rgba(139,92,246,0.35)]"
            : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="mx-auto max-w-6xl px-3 pb-4 pt-4 md:px-6">
        <div className="mb-4 flex justify-center gap-2">
          {renderTabButton("interface", "Interface")}
          {renderTabButton("working", "Working")}
          {renderTabButton("memory", "Memory")}
        </div>

        {isAnyTaskRunning && (
          <div className="mb-3 rounded-xl border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-sm text-violet-200">
            Agent is working on a task...
          </div>
        )}

        {activeTab === "interface" && (
          <section className="surface-card flex min-h-[78vh] flex-col rounded-2xl border border-white/10">
            <div className="flex-1 space-y-6 overflow-y-auto p-4 md:p-6">
              {combinedChatItems.map((item) => (
                <div key={item.id} className="space-y-3">
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl bg-violet-600 px-4 py-3 text-sm md:max-w-[75%]">{item.goal}</div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="mt-1 flex h-7 w-7 items-center justify-center rounded-full bg-violet-500/20 text-sm text-violet-200">
                      AI
                    </div>
                    <div className="max-w-[88%] space-y-2 md:max-w-[76%]">
                      <div className="rounded-2xl border border-white/10 bg-zinc-900 px-4 py-3 text-sm">
                        <MemoryMarkdown content={item.agentMessage} />
                      </div>
                      <StatusBadge status={item.status} />
                    </div>
                  </div>
                </div>
              ))}

              {combinedChatItems.length === 0 && (
                <div className="text-center text-sm text-zinc-400">Give me a goal to research or build...</div>
              )}

              {interfaceError && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
                  {interfaceError}
                </div>
              )}
            </div>

            <form onSubmit={handleSend} className="border-t border-white/10 p-3 md:p-4">
              <div className="flex gap-2">
                <input
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="Give me a goal to research or build..."
                  className="flex-1 rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-sm outline-none ring-violet-400/60 placeholder:text-zinc-500 focus:ring"
                />
                <button
                  disabled={isSending}
                  className="rounded-xl bg-violet-500 px-4 py-3 text-sm font-medium text-white hover:bg-violet-400 disabled:opacity-60"
                >
                  Send
                </button>
              </div>
            </form>
          </section>
        )}

        {activeTab === "working" && (
          <section className="surface-card flex min-h-[78vh] flex-col rounded-2xl border border-white/10 p-4 md:p-6">
            {!currentTask ? (
              <div className="my-auto text-center text-sm text-zinc-400">No active task</div>
            ) : (
              <>
                <div className="mb-4 flex items-start justify-between gap-3 border-b border-white/10 pb-3">
                  <h2 className="text-sm font-medium text-zinc-200 md:text-base">{truncate(currentTask.goal, 110)}</h2>
                  <div className="rounded-full border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-xs text-violet-200">
                    Iteration {currentTaskEntries.length}/20
                  </div>
                </div>

                <div ref={workingFeedRef} className="flex-1 space-y-3 overflow-y-auto pr-1">
                  {currentTaskEntries.map((entry) => {
                    const kind = inferStepKind(entry);
                    const style = STEP_STYLES[kind];
                    return (
                      <article key={entry.id} className={`rounded-xl border border-white/10 bg-black/25 p-3 pl-4 border-l-4 ${style.border}`}>
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs">{style.icon}</span>
                            <span className={`rounded-full px-2 py-1 text-[10px] uppercase tracking-wider ${style.badge}`}>
                              {kind}
                            </span>
                          </div>
                          <span className="text-xs text-zinc-500">{formatClock(entry.createdAt)}</span>
                        </div>
                        <MemoryMarkdown content={entry.content} />
                      </article>
                    );
                  })}

                  {currentTaskEntries.length === 0 && (
                    <div className="text-sm text-zinc-400">No live steps yet.</div>
                  )}

                  {workingError && (
                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
                      {workingError}
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        )}

        {activeTab === "memory" && (
          <section className="surface-card min-h-[78vh] rounded-2xl border border-white/10 p-4 md:p-6">
            <div className="mb-4 flex flex-wrap gap-2">
              {(["all", "thought", "research", "code", "output", "summary", "error"] as const).map((filter) => (
                <button
                  key={filter}
                  onClick={() => setMemoryFilter(filter)}
                  className={`rounded-full border px-3 py-1.5 text-xs capitalize ${
                    memoryFilter === filter
                      ? "border-violet-400/40 bg-violet-500/20 text-violet-200"
                      : "border-white/10 bg-white/5 text-zinc-300"
                  }`}
                >
                  {filter}
                </button>
              ))}
            </div>

            <div className="space-y-3">
              {filteredMemoryEntries.map((entry) => {
                const style = STEP_STYLES[entry.stepKind];
                const expanded = expandedMemory[entry.id] ?? false;

                return (
                  <article key={entry.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className={`rounded-full px-2 py-1 text-[10px] uppercase tracking-wider ${style.badge}`}>
                        {entry.stepKind}
                      </span>
                      <span className="text-xs text-zinc-500">{relativeTime(entry.createdAt)}</span>
                    </div>
                    <p className="mb-2 text-xs text-zinc-400">{truncate(entry.taskGoal, 130)}</p>
                    <button
                      onClick={() =>
                        setExpandedMemory((prev) => ({
                          ...prev,
                          [entry.id]: !expanded,
                        }))
                      }
                      className="text-xs text-violet-300 hover:text-violet-200"
                    >
                      {expanded ? "Collapse" : "Expand"}
                    </button>
                    {expanded && (
                      <div className="mt-3 rounded-lg border border-white/10 bg-black/25 p-3">
                        <MemoryMarkdown content={entry.content} />
                      </div>
                    )}
                  </article>
                );
              })}

              {filteredMemoryEntries.length === 0 && (
                <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-zinc-400">No memory entries found.</div>
              )}

              {memoryError && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
                  {memoryError}
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
