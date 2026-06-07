"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";
import { StatusBadge, SubTaskStatusBadge } from "@/components/badges";
import { Task, SubTask, Artifact, MemoryEntry } from "@/lib/types";

type FilterType = "All" | "Running" | "Done" | "Failed" | "Pending";

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<FilterType>("All");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedSubTasks, setExpandedSubTasks] = useState<SubTask[]>([]);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Artifact[]>([]);
  const [expandedMemory, setExpandedMemory] = useState<MemoryEntry[]>([]);

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
      setExpandedSubTasks([]);
      setExpandedArtifacts([]);
      setExpandedMemory([]);
      return;
    }
    setExpandedId(taskId);
    try {
      const [subTasks, artifacts, memory] = await Promise.all([
        api.getSubTasks(taskId),
        api.getArtifacts(taskId),
        api.getTaskMemory(taskId)
      ]);
      setExpandedSubTasks(subTasks || []);
      setExpandedArtifacts(artifacts || []);
      setExpandedMemory(memory || []);
    } catch (err) {}
  };

  const filteredTasks = tasks.filter(t => {
    if (filter === "All") return true;
    if (filter === "Running") return t.status === "running";
    if (filter === "Done") return t.status === "done";
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
          <Link href="/" className="rounded bg-[#2b2620] px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-white md:block">
            New Mission
          </Link>
        </div>

        <div className="flex-1 w-full overflow-x-auto relative">
          <div className="min-w-[800px]">
            <div className="grid grid-cols-[120px_4fr_100px_120px_100px] gap-4 py-3 px-4 text-[10px] uppercase font-mono tracking-widest text-text-dim border-b border-bg-border">
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
                      className="grid grid-cols-[120px_4fr_100px_120px_100px] gap-4 py-4 px-4 items-center"
                      onClick={() => handleExpand(task.id)}
                    >
                      <div>
                        <StatusBadge status={task.status} />
                      </div>
                      <div className="font-mono text-text-primary line-clamp-1">{task.goal}</div>
                      <div className="font-mono text-text-secondary text-xs">{task.iterations || 0} steps</div>
                      <div className="font-mono text-text-secondary text-xs">{createdAt.toLocaleTimeString()}</div>
                      <div className="font-mono text-text-secondary text-xs">{dur}</div>
                    </div>
                    
                    {isExpanded && (
                      <div className="px-4 pb-6 w-full animate-in fade-in slide-in-from-top-2 duration-300">
                        {/* SubTasks Section */}
                        <div className="mb-6">
                          <h4 className="text-[10px] font-mono text-text-dim uppercase tracking-widest mb-3 flex items-center gap-2">
                            <span>⬡ Execution DAG</span>
                            <div className="flex-1 h-[1px] bg-bg-border"></div>
                          </h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            {expandedSubTasks.map(st => (
                              <div key={st.id} className="p-3 border border-bg-border bg-bg-surface rounded-sm flex flex-col gap-2">
                                <div className="flex justify-between items-start gap-2">
                                  <span className="font-mono text-xs font-bold text-text-primary leading-tight">{st.title}</span>
                                  <SubTaskStatusBadge status={st.status} />
                                </div>
                                <p className="text-[10px] text-text-secondary line-clamp-2">{st.description}</p>
                                {st.critique && (
                                  <div className="mt-1 p-2 bg-rose-500/5 border border-rose-500/20 text-[9px] text-rose-300 italic">
                                    {st.critique}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Artifacts Section */}
                        {expandedArtifacts.length > 0 && (
                          <div className="mb-6">
                            <h4 className="text-[10px] font-mono text-text-dim uppercase tracking-widest mb-3 flex items-center gap-2">
                              <span>⬡ Produced Artifacts</span>
                              <div className="flex-1 h-[1px] bg-bg-border"></div>
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {expandedArtifacts.map(art => (
                                <div key={art.id} className="px-3 py-1.5 border border-accent-blue/20 bg-accent-blue/5 text-accent-blue text-[10px] font-mono rounded-sm">
                                  {art.name} ({art.type})
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Memory Section */}
                        <h4 className="text-[10px] font-mono text-text-dim uppercase tracking-widest mb-3 flex items-center gap-2">
                          <span>⬡ Reasoning Trace</span>
                          <div className="flex-1 h-[1px] bg-bg-border"></div>
                        </h4>
                        <div className="bg-bg-base border border-bg-border p-4 max-h-[400px] overflow-y-auto flex flex-col gap-2 rounded-sm shadow-inner mb-4">
                          {expandedMemory.length === 0 ? (
                            <div className="text-text-dim font-mono text-xs">No memory entries yet.</div>
                          ) : (
                            expandedMemory.map((mem, i) => (
                              <div key={i} className={`p-3 text-xs leading-relaxed border-l-2 bg-text-primary border-opacity-5 ${
                                mem.type === 'thought' ? 'border-accent-purple bg-accent-purple/5 text-accent-purple' :
                                mem.type === 'command' ? 'border-accent-blue bg-accent-blue/5 text-accent-blue' :
                                mem.type === 'critique' ? 'border-accent-orange bg-accent-orange/5 text-accent-orange' :
                                mem.type === 'security_alert' ? 'border-accent-red bg-accent-red/20 text-accent-red font-bold' :
                                mem.type === 'error' ? 'border-accent-red bg-accent-red/5 text-accent-red' :
                                mem.type === 'input' ? 'border-accent-green bg-accent-green/5 text-accent-green' :
                                'border-text-dim bg-white/5 text-text-secondary'
                              }`}>
                                <div className="font-semibold uppercase tracking-wider mb-2 opacity-80 flex justify-between">
                                  <span>
                                    {mem.type === 'thought' ? '◈ THOUGHT' : 
                                     mem.type === 'command' ? '$ COMMAND' : 
                                     mem.type === 'critique' ? '✍ CRITIQUE' :
                                     mem.type === 'security_alert' ? '⚠ SECURITY AUDIT' :
                                     mem.type === 'error' ? '⚠ ERROR' : 
                                     mem.type === 'input' ? '👤 USER INPUT' : 'OUTPUT'}
                                  </span>
                                  {mem.layer && <span className="text-[8px] opacity-50">{mem.layer}</span>}
                                </div>
                                <div className="whitespace-pre-wrap font-mono break-words">
                                  {mem.content || '(empty)'}
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                        
                        {task.status === 'running' && (
                          <form 
                            className="flex gap-2"
                            onSubmit={async (e) => {
                              e.preventDefault();
                              const form = e.target as HTMLFormElement;
                              const input = form.elements.namedItem('content') as HTMLInputElement;
                              const content = input.value.trim();
                              if (!content) return;
                              try {
                                await api.sendTaskInput(task.id, content);
                                input.value = '';
                                const mem = await api.getTaskMemory(task.id);
                                setExpandedMemory(mem || []);
                              } catch (err) {
                                alert("Failed to send input");
                              }
                            }}
                          >
                            <input 
                              name="content"
                              placeholder="Send guidance or feedback to this task..."
                              className="flex-1 bg-bg-surface border border-bg-border px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:border-accent-purple"
                              autoFocus
                            />
                            <button 
                              type="submit"
                              className="px-4 py-2 bg-accent-purple text-white text-[10px] font-mono font-bold uppercase tracking-wider"
                            >
                              SEND
                            </button>
                          </form>
                        )}
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
