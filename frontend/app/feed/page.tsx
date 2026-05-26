"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";
import { MemoryEntry, Task } from "@/lib/types";

export default function FeedPage() {
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const tasks = await api.getTasks();
        const current = tasks.find((task) => task.status === "running") ?? tasks[0] ?? null;
        setActiveTask(current);
        if (current) {
          setEntries(await api.getTaskMemory(current.id));
        }
      } catch {
        setActiveTask(null);
        setEntries([]);
      }
    };

    void load();
    const socket = io(api.SOCKET_BASE);
    socket.on("task:update", (task: Task) => {
      if (task.status === "running" || task.id === activeTask?.id) {
        setActiveTask(task);
      }
    });
    socket.on("task:memory", (entry: MemoryEntry) => {
      if (entry.taskId === activeTask?.id) {
        setEntries((prev) => (prev.some((item) => item.id === entry.id) ? prev : [...prev, entry]));
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [activeTask?.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    if (activeTask?.status === "running") {
      await api.sendTaskInput(activeTask.id, draft.trim());
    } else {
      const task = await api.createResearchTask(draft.trim());
      setActiveTask(task);
      setEntries([]);
    }
    setDraft("");
  };

  return (
    <AppShell>
      <div className="mx-auto flex h-[calc(100vh-56px)] max-w-5xl flex-col px-4 py-6 md:px-6">
        <div className="mb-4">
          <div className="text-lg font-semibold">Live activity</div>
          <div className="text-sm text-text-secondary">
            {activeTask ? activeTask.goal : "No running task. Start one below."}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded border border-bg-border bg-bg-surface p-4">
          {entries.length === 0 ? (
            <div className="py-10 text-center text-sm text-text-secondary">
              Waiting for activity.
            </div>
          ) : (
            <div className="space-y-3">
              {entries.map((entry) => (
                <div key={entry.id} className="rounded border border-bg-border bg-bg-base px-3 py-3">
                  <div className="flex items-center justify-between text-xs text-text-secondary">
                    <span className="uppercase tracking-wide">{entry.type}</span>
                    <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <div className="mt-2 whitespace-pre-wrap text-sm">{entry.content}</div>
                </div>
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="mt-4 flex gap-3">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={activeTask?.status === "running" ? "Send feedback to the running task..." : "Describe a new task..."}
            className="flex-1 rounded border border-bg-border bg-bg-surface px-4 py-3 text-sm outline-none focus:border-accent-purple"
          />
          <button
            type="submit"
            className="rounded bg-accent-purple px-4 py-3 text-sm font-medium text-white"
          >
            {activeTask?.status === "running" ? "Send" : "Create"}
          </button>
        </form>
      </div>
    </AppShell>
  );
}
