"use client";

import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";
import { MemoryEntry, SubTask, SystemStatus, Task } from "@/lib/types";

function mergeUniqueTasks(tasks: Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    const existing = byId.get(task.id);
    if (!existing || (task.createdAt ?? 0) >= (existing.createdAt ?? 0)) {
      byId.set(task.id, task);
    }
  }
  return [...byId.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export default function HomePage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [subTasks, setSubTasks] = useState<SubTask[]>([]);
  const [goal, setGoal] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedTask = useMemo(() => {
    if (selectedTaskId) {
      return tasks.find((task) => task.id === selectedTaskId) ?? null;
    }
    return tasks.find((task) => task.status === "running") ?? tasks[0] ?? null;
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [fetchedTasks, fetchedSystem] = await Promise.all([
          api.getTasks(),
          api.getSystemStatus(),
        ]);
        if (!cancelled) {
          setTasks(mergeUniqueTasks(fetchedTasks || []));
          setSystem(fetchedSystem);
          if (!selectedTaskId && fetchedTasks[0]) {
            setSelectedTaskId(fetchedTasks[0].id);
          }
        }
      } catch {
        if (!cancelled) {
          setSystem(null);
        }
      }
    };

    void load();
    const interval = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedTaskId]);

  useEffect(() => {
    if (!selectedTask?.id) {
      setMemory([]);
      setSubTasks([]);
      return;
    }

    let cancelled = false;
    const loadTaskDetails = async () => {
      try {
        const [memories, subTaskList] = await Promise.all([
          api.getTaskMemory(selectedTask.id),
          api.getSubTasks(selectedTask.id),
        ]);
        if (!cancelled) {
          setMemory(memories || []);
          setSubTasks(subTaskList || []);
        }
      } catch {
        if (!cancelled) {
          setMemory([]);
          setSubTasks([]);
        }
      }
    };

    void loadTaskDetails();
    return () => {
      cancelled = true;
    };
  }, [selectedTask?.id]);

  useEffect(() => {
    const socket = io(api.SOCKET_BASE);

    socket.on("task:update", (updatedTask: Task) => {
      setTasks((prev) => {
        const existing = prev.findIndex((task) => task.id === updatedTask.id);
        if (existing === -1) {
          return mergeUniqueTasks([updatedTask, ...prev]);
        }
        const next = [...prev];
        next[existing] = updatedTask;
        return mergeUniqueTasks(next);
      });
    });

    socket.on("task:memory", (entry: MemoryEntry) => {
      if (entry.taskId === selectedTask?.id) {
        setMemory((prev) => (prev.some((item) => item.id === entry.id) ? prev : [...prev, entry]));
      }
    });

    socket.on("subtask:create", (entry: SubTask) => {
      if (entry.taskId === selectedTask?.id) {
        setSubTasks((prev) => (prev.some((item) => item.id === entry.id) ? prev : [...prev, entry]));
      }
    });

    socket.on("subtask:update", (entry: SubTask) => {
      if (entry.taskId === selectedTask?.id) {
        setSubTasks((prev) => {
          const index = prev.findIndex((item) => item.id === entry.id);
          if (index === -1) return [...prev, entry];
          const next = [...prev];
          next[index] = entry;
          return next;
        });
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [selectedTask?.id]);

  const handleCreateTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!goal.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const task = await api.createResearchTask(goal.trim());
      setGoal("");
      setSelectedTaskId(task.id);
      setTasks((prev) => mergeUniqueTasks([task, ...prev]));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedTask?.id || !message.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await api.sendTaskInput(selectedTask.id, message.trim());
      setMessage("");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!selectedTask?.id || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await api.cancelTask(selectedTask.id);
    } finally {
      setIsSubmitting(false);
    }
  };

  const waitingForInput = memory.some(
    (entry) => entry.type === "thought" && entry.content.includes("WAITING FOR USER"),
  );

  return (
    <AppShell>
      <div className="mx-auto h-[calc(100vh-56px)] max-w-7xl overflow-hidden px-4 py-6 md:px-6">
        <section className="grid gap-3 md:grid-cols-4">
          <div className="rounded border border-bg-border bg-bg-surface p-4">
            <div className="text-xs uppercase tracking-wide text-text-secondary">Server</div>
            <div className="mt-2 text-sm">{system?.ready ? "Ready" : "Unavailable"}</div>
          </div>
          <div className="rounded border border-bg-border bg-bg-surface p-4">
            <div className="text-xs uppercase tracking-wide text-text-secondary">Workspace</div>
            <div className="mt-2 text-sm capitalize">{system?.workspace.status ?? "unknown"}</div>
          </div>
          <div className="rounded border border-bg-border bg-bg-surface p-4">
            <div className="text-xs uppercase tracking-wide text-text-secondary">Running</div>
            <div className="mt-2 text-sm">{system?.tasks.running ?? 0} task(s)</div>
          </div>
          <div className="rounded border border-bg-border bg-bg-surface p-4">
            <div className="text-xs uppercase tracking-wide text-text-secondary">Queued</div>
            <div className="mt-2 text-sm">{system?.queue.pendingCount ?? 0} task(s)</div>
          </div>
        </section>

        <section className="mt-6 grid min-h-0 gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto pr-1">
            <div className="space-y-6">
              <div className="rounded border border-bg-border bg-bg-surface p-4">
              <h1 className="text-lg font-semibold">Start a task</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Ask a question, request a code change, or describe a larger build task.
              </p>
              <form onSubmit={handleCreateTask} className="mt-4 space-y-3">
                <textarea
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder="Example: Fix the queue lifecycle and make the dashboard easier to use."
                  className="min-h-32 w-full rounded border border-bg-border bg-bg-base px-3 py-3 text-sm outline-none transition-colors focus:border-accent-purple"
                />
                <button
                  type="submit"
                  disabled={isSubmitting || !goal.trim()}
                  className="w-full rounded bg-accent-purple px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  Create task
                </button>
              </form>
              </div>

              <div className="rounded border border-bg-border bg-bg-surface">
                <div className="border-b border-bg-border px-4 py-3 text-sm font-medium">
                  Recent tasks
                </div>
                <div className="max-h-[520px] overflow-y-auto">
                  {tasks.length === 0 && (
                    <div className="px-4 py-6 text-sm text-text-secondary">No tasks yet.</div>
                  )}
                  {tasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => setSelectedTaskId(task.id)}
                      className={`block w-full border-b border-bg-border px-4 py-3 text-left transition-colors last:border-b-0 ${
                        selectedTask?.id === task.id ? "bg-bg-base" : "hover:bg-bg-base"
                      }`}
                    >
                      <div className="line-clamp-2 text-sm">{task.goal}</div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-text-secondary">
                        <span className="rounded border border-bg-border px-2 py-1 capitalize">{task.status}</span>
                        <span className="rounded border border-bg-border px-2 py-1">
                          {task.mode ?? "routing"}
                        </span>
                        <span className="rounded border border-bg-border px-2 py-1">
                          {task.iterations ?? 0} steps
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="min-h-0 overflow-y-auto pr-1">
            <section className="rounded border border-bg-border bg-bg-surface">
              <div className="border-b border-bg-border px-4 py-3">
                <div className="text-sm font-medium">Selected task</div>
              </div>
              {!selectedTask ? (
                <div className="px-4 py-8 text-sm text-text-secondary">
                  Select a task to see progress.
                </div>
              ) : (
                <div className="space-y-4 px-4 py-4">
                  <div>
                    <div className="text-lg font-semibold leading-7">{selectedTask.goal}</div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-text-secondary">
                      <span className="rounded border border-bg-border px-2 py-1 capitalize">
                        {selectedTask.status}
                      </span>
                      <span className="rounded border border-bg-border px-2 py-1">
                        {selectedTask.mode ?? "routing"}
                      </span>
                      <span className="rounded border border-bg-border px-2 py-1">
                        {selectedTask.iterations ?? 0} steps
                      </span>
                    </div>
                  </div>

                  {selectedTask.result && (
                    <div className="rounded border border-emerald-500/20 bg-emerald-500/5 px-3 py-3 text-sm whitespace-pre-wrap">
                      {selectedTask.result}
                    </div>
                  )}

                  {selectedTask.error && selectedTask.status !== "done" && (
                    <div className="rounded border border-rose-500/20 bg-rose-500/5 px-3 py-3 text-sm whitespace-pre-wrap">
                      {selectedTask.error}
                    </div>
                  )}

                  <div className="space-y-4">
                    <div className="rounded border border-bg-border bg-bg-base">
                      <div className="border-b border-bg-border px-3 py-2 text-xs uppercase tracking-wide text-text-secondary">
                        Steps
                      </div>
                      <div className="flex flex-wrap gap-2 px-3 py-3">
                        {subTasks.length === 0 && (
                          <div className="text-sm text-text-secondary">No subtasks yet.</div>
                        )}
                        {subTasks.map((subTask) => (
                          <div key={subTask.id} className="rounded border border-bg-border bg-bg-surface px-3 py-2">
                            <div className="text-sm">{subTask.title}</div>
                            <div className="mt-1 text-xs capitalize text-text-secondary">
                              {subTask.status.replaceAll("_", " ")}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded border border-bg-border bg-bg-base">
                      <div className="border-b border-bg-border px-3 py-2 text-xs uppercase tracking-wide text-text-secondary">
                        Activity
                      </div>
                      <div className="min-h-[420px] max-h-[520px] space-y-3 overflow-y-auto px-3 py-3">
                        {memory.length === 0 && (
                          <div className="text-sm text-text-secondary">No activity yet.</div>
                        )}
                        {memory.map((entry) => (
                          <div key={entry.id} className="rounded border border-bg-border bg-bg-surface px-3 py-3">
                            <div className="flex items-center justify-between text-xs text-text-secondary">
                              <span className="uppercase tracking-wide">{entry.type}</span>
                              <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
                            </div>
                            <div className="mt-2 whitespace-pre-wrap text-sm leading-6">{entry.content}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <form onSubmit={handleSendMessage} className="space-y-3">
                    <textarea
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder={waitingForInput ? "The agent is waiting for your answer." : "Send guidance or feedback to this task."}
                      className="min-h-24 w-full rounded border border-bg-border bg-bg-base px-3 py-3 text-sm outline-none transition-colors focus:border-accent-purple"
                    />
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="submit"
                        disabled={isSubmitting || !message.trim()}
                        className="rounded bg-accent-purple px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                      >
                        Send message
                      </button>
                      {selectedTask.status === "running" && (
                        <button
                          type="button"
                          onClick={handleCancel}
                          disabled={isSubmitting}
                          className="rounded border border-rose-500/30 px-4 py-2 text-sm text-rose-300 disabled:opacity-50"
                        >
                          Cancel task
                        </button>
                      )}
                    </div>
                  </form>
                </div>
              )}
            </section>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
