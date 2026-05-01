"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";

type FilterType = "All" | "Running" | "Done" | "Failed" | "Pending";

export default function TasksPage() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [filter, setFilter] = useState<FilterType>("All");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedMemory, setExpandedMemory] = useState<any[]>([]);

  useEffect(() => {
    const fetchTasks = async () => {
      try {
        const fetched = await api.getTasks();
        setTasks(fetched || []);
      } catch (err) {}
    };
    fetchTasks();
    const interval = setInterval(fetchTasks, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleExpand = async (taskId: string) => {
    if (expandedId === taskId) {
      setExpandedId(null);
      setExpandedMemory([]);
      return;
    }
    setExpandedId(taskId);
    try {
      const mem = await api.getTaskMemory(taskId);
      setExpandedMemory(mem || []);
    } catch (err) {}
  };

  const filteredTasks = tasks.filter(t => {
    if (filter === "All") return true;
    if (filter === "Running") return t.status === "running";
    if (filter === "Done") return t.status === "completed";
    if (filter === "Failed") return t.status === "failed";
    if (filter === "Pending") return t.status === "pending";
    return true;
  });

  return (
    <AppShell>
      <div className="flex flex-col h-full min-h-[calc(100vh-48px)] p-6 bg-bg-base">
        <div className="flex justify-between items-center mb-6">
          <div className="flex gap-2 text-xs font-mono">
            {(["All", "Running", "Done", "Failed", "Pending"] as FilterType[]).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 border rounded-sm transition-colors ${
                  filter === f 
                    ? "bg-bg-elevated border-text-dim text-text-primary" 
                    : "border-bg-border text-text-secondary hover:text-text-primary hover:border-text-dim"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <button className="px-4 py-1.5 bg-accent-purple text-white font-mono text-xs font-bold uppercase tracking-wider hidden md:block">
            NEW GOAL
          </button>
        </div>

        <div className="flex-1 w-full overflow-x-auto relative">
          <div className="min-w-[800px]">
            <div className="grid grid-cols-[100px_4fr_100px_120px_100px] gap-4 py-3 px-4 text-[10px] uppercase font-mono tracking-widest text-text-dim border-b border-bg-border">
              <div>STATUS</div>
              <div>GOAL</div>
              <div>ITERATIONS</div>
              <div>STARTED</div>
              <div>DURATION</div>
            </div>

            <div className="flex flex-col text-sm font-sans">
              {filteredTasks.map(task => {
                const isExpanded = expandedId === task.id;
                const createdAt = new Date(task.createdAt);
                
                let dur = "-";
                if (task.startedAt) {
                  const end = task.completedAt || Date.now();
                  const diff = Math.floor((end - task.startedAt) / 1000);
                  const m = Math.floor(diff / 60);
                  const s = diff % 60;
                  dur = `${m}m ${s}s`;
                }
                
                return (
                  <div key={task.id} className="flex flex-col border-b border-bg-border cursor-pointer group hover:bg-bg-surface transition-colors">
                    <div 
                      className="grid grid-cols-[100px_4fr_100px_120px_100px] gap-4 py-4 px-4 items-center"
                      onClick={() => handleExpand(task.id)}
                    >
                      <div className="flex items-center gap-2 text-xs font-mono">
                        <span className={`w-2 h-2 rounded-full ${
                          task.status === 'running' ? 'bg-accent-orange animate-pulse-opacity' :
                          task.status === 'completed' ? 'bg-accent-green' :
                          task.status === 'failed' ? 'bg-accent-red' : 'bg-text-dim'
                        }`} />
                        <span className="capitalize">{task.status === "completed" ? "done" : task.status}</span>
                      </div>
                      <div className="font-mono text-text-primary line-clamp-1">{task.goal}</div>
                      <div className="font-mono text-text-secondary text-xs">{task.iterations || 0}/30</div>
                      <div className="font-mono text-text-secondary text-xs">{createdAt.toLocaleTimeString()}</div>
                      <div className="font-mono text-text-secondary text-xs">{dur}</div>
                    </div>
                    
                    {isExpanded && (
                      <div className="px-4 pb-4 w-full">
                        <div className="bg-bg-base border border-bg-border p-4 max-h-[400px] overflow-y-auto flex flex-col gap-2 rounded-sm shadow-inner">
                          {expandedMemory.length === 0 ? (
                            <div className="text-text-dim font-mono text-xs">No memory entries yet.</div>
                          ) : (
                            expandedMemory.map((mem, i) => (
                              <div key={i} className={`p-3 text-xs leading-relaxed border-l-2 bg-text-primary border-opacity-5 ${
                                mem.type === 'thought' ? 'border-accent-purple bg-accent-purple/5 text-accent-purple' :
                                mem.type === 'command' ? 'border-accent-blue bg-accent-blue/5 text-accent-blue' :
                                mem.type === 'output' ? 'border-text-dim bg-white/5 text-text-secondary' :
                                mem.type === 'error' ? 'border-accent-red bg-accent-red/5 text-accent-red' :
                                'border-text-dim bg-white/5 text-text-secondary'
                              }`}>
                                <div className="font-semibold uppercase tracking-wider mb-2 opacity-80">
                                  {mem.type === 'thought' ? '◈ THOUGHT' : mem.type === 'command' ? '$ COMMAND' : mem.type === 'error' ? '⚠ ERROR' : 'OUTPUT'}
                                </div>
                                <div className="whitespace-pre-wrap font-mono break-words">
                                  {mem.content || mem.thought || mem.command || mem.output || '(empty)'}
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              
              {filteredTasks.length === 0 && (
                <div className="p-8 text-center text-text-dim font-mono text-sm border-b border-bg-border border-dashed">
                  No {filter !== "All" ? filter.toLowerCase() : ""} tasks found.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}