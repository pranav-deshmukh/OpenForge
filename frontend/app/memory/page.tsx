"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";
import { MemoryEntry } from "@/lib/types";

type MemoryFilter = "All" | "Thought" | "Command" | "Output" | "Error";

export default function MemoryPage() {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [filter, setFilter] = useState<MemoryFilter>("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // Initial load
    const fetchMemory = async () => {
      try {
        const mems = await api.getAllMemory();
        setMemories(mems || []);
      } catch (err) {}
    };
    fetchMemory();
    const interval = setInterval(fetchMemory, 5000);
    return () => clearInterval(interval);
  }, []);

  const toggleExpand = (id: string) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const filteredMemories = memories.filter(m => {
    // Search match
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!m.content?.toLowerCase().includes(q) && !m.taskId.includes(q)) {
        return false;
      }
    }
    // Type match
    if (filter === "All") return true;
    if (filter === "Thought" && m.type === "thought") return true;
    if (filter === "Command" && m.type === "command") return true;
    if (filter === "Output" && m.type === "output") return true;
    if (filter === "Error" && m.type === "error") return true;
    return false;
  });

  return (
    <AppShell>
      <div className="flex flex-col h-full min-h-[calc(100vh-48px)] p-6 bg-bg-base font-sans">
        
        <div className="flex flex-col md:flex-row gap-4 justify-between md:items-center mb-8">
          <div className="w-full md:w-1/3">
            <input 
              type="text"
              placeholder="Search memory..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-bg-surface border border-bg-border focus:border-accent-purple px-4 py-2 font-mono text-sm outline-none placeholder-text-dim text-text-primary transition-colors"
            />
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-mono">
            {(["All", "Thought", "Command", "Output", "Error"] as MemoryFilter[]).map(f => (
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
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-4 auto-rows-max items-start">
          {filteredMemories.map((mem) => {
            const isExpanded = expanded[mem.id];
            const timeAgo = Math.floor((Date.now() - new Date(mem.createdAt).getTime()) / 60000);
            const timeStr = timeAgo < 60 ? `${timeAgo}m ago` : `${Math.floor(timeAgo/60)}h ago`;

            let borderClass = "border-text-dim";
            let bgClass = "bg-white/[0.02]";
            let textClass = "text-text-secondary";
            let label = "OUTPUT";

            if (mem.type === 'thought') {
               borderClass = "border-accent-purple";
               bgClass = "bg-accent-purple/5";
               textClass = "text-accent-purple";
               label = "◈ THOUGHT";
            } else if (mem.type === 'command') {
               borderClass = "border-accent-blue";
               bgClass = "bg-accent-blue/5";
               textClass = "text-accent-blue";
               label = "$ COMMAND";
            } else if (mem.type === 'error') {
               borderClass = "border-accent-red";
               bgClass = "bg-accent-red/5";
               textClass = "text-accent-red";
               label = "⚠ ERROR";
            }

            return (
              <div 
                key={mem.id} 
                className={`border-l-2 bg-bg-surface flex flex-col border border-y-bg-border border-r-bg-border ${borderClass}`}
              >
                <div className={`flex justify-between items-center px-4 py-3 border-b border-bg-border/50 bg-bg-base/50 ${textClass}`}>
                  <span className="font-mono text-xs font-semibold uppercase tracking-wider">{label}</span>
                  <span className="font-mono text-[10px] opacity-70">{timeStr}</span>
                </div>
                
                <div className="px-4 py-2 border-b border-bg-border/30 bg-bg-elevated text-xs font-sans text-text-secondary line-clamp-1">
                  Task: {mem.taskId}
                </div>

                <div className="p-4 bg-transparent font-mono text-sm leading-relaxed text-text-primary overflow-x-auto">
                  <div className={isExpanded ? "" : "line-clamp-4"}>
                    {mem.content || "(empty content)"}
                  </div>
                </div>
                
                {mem.content && mem.content.split('\n').length > 4 && (
                  <button 
                    onClick={() => toggleExpand(mem.id)}
                    className="w-full text-right px-4 pb-3 pt-1 text-xs font-mono font-medium text-text-dim hover:text-text-primary transition-colors uppercase tracking-wider"
                  >
                    [{isExpanded ? "Collapse ↑" : "Expand ↓"}]
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {filteredMemories.length === 0 && (
          <div className="w-full text-center text-text-dim font-mono text-sm py-12 border border-dashed border-bg-border">
            No memories found matching the current criteria.
          </div>
        )}
      </div>
    </AppShell>
  );
}