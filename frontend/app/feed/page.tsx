"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";
import { io } from "socket.io-client";
import Link from "next/link";

export default function FeedPage() {
  const [activeTask, setActiveTask] = useState<any>(null);
  const [memories, setMemories] = useState<any[]>([]);
  const [goalInput, setGoalInput] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const feedContainerRef = useRef<HTMLDivElement>(null);
  const feedEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const fetchedTasks = await api.getTasks() || [];
        const running = fetchedTasks.find((t: any) => t.status === "running") || fetchedTasks[0];
        
        if (running) {
          setActiveTask(running);
          const mem = await api.getTaskMemory(running.id);
          setMemories(mem || []);
        }
      } catch (err) {}
    };
    fetchData();

    const socket = io("http://localhost:3000");
    let pollingInterval: NodeJS.Timeout;

    socket.on("connect", () => {
      clearInterval(pollingInterval);
    });

    socket.on("disconnect", () => {
      pollingInterval = setInterval(fetchData, 2000);
    });

    socket.on("task:update", (task: any) => {
      setActiveTask((prev: any) => (prev?.id === task.id || task.status === 'running') ? task : prev);
    });

    socket.on("task:memory", (memoryItem: any) => {
      setMemories((prev) => {
        if (prev.find(m => m.id === memoryItem.id)) return prev;
        return [...prev, memoryItem];
      });
    });

    return () => {
      clearInterval(pollingInterval);
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (autoScroll) {
      feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [memories, autoScroll]);

  const deployTask = async () => {
    if (!goalInput.trim()) return;
    try {
      const res = await fetch("http://localhost:3000/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: goalInput })
      });
      const t = await res.json();
      setGoalInput("");
      setActiveTask(t);
      setMemories([]);
    } catch(err) {}
  };

  const isRunning = activeTask?.status === "running";

  // Group memories by iteration to make it readable
  const iterationGroups = useMemo(() => {
    const groups: { [key: number]: any[] } = {};
    let currentIteration = 0;

    memories.forEach((mem) => {
      // Try to detect iteration from thought content if not explicitly tagged
      if (mem.type === 'thought') {
        const match = mem.content.match(/Iteration (\d+):/i);
        if (match) currentIteration = parseInt(match[1]);
      }
      
      if (!groups[currentIteration]) groups[currentIteration] = [];
      groups[currentIteration].push(mem);
    });

    return Object.entries(groups).sort(([a], [b]) => parseInt(a) - parseInt(b));
  }, [memories]);

  return (
    <AppShell>
      <div className="flex flex-col h-[calc(100vh-48px)] w-full relative bg-bg-base overflow-hidden">
        
        {/* HEADER */}
        <div className="h-14 border-b border-bg-border bg-bg-surface flex items-center justify-between px-6 sticky top-0 z-10 font-mono">
          <div className="flex items-center gap-6 overflow-hidden">
            <Link href="/" className="text-text-dim hover:text-text-primary transition-colors flex items-center gap-2 group">
              <span className="group-hover:-translate-x-1 transition-transform">←</span> 
              <span className="hidden sm:inline">DASHBOARD</span>
            </Link>
            <div className="h-4 w-[1px] bg-bg-border hidden sm:block"></div>
            {activeTask ? (
              <div className="flex items-center gap-3 truncate max-w-md">
                <span className="text-accent-purple text-[10px] font-bold tracking-widest border border-accent-purple/30 px-1.5 py-0.5 rounded">ACTIVE</span>
                <span className="text-text-primary text-xs truncate font-medium">"{activeTask.goal}"</span>
              </div>
            ) : (
              <span className="text-text-dim text-xs tracking-widest">NO ACTIVE MISSION</span>
            )}
          </div>
          
          <div className="flex items-center gap-6 text-[10px] font-bold">
            <div className="flex items-center gap-2">
              <span className="text-text-dim tracking-widest uppercase">ITERATIONS</span>
              <span className="text-text-primary tabular-nums border border-bg-border px-2 py-0.5 bg-bg-base">{activeTask?.iterations || 0}</span>
            </div>
            <div className={`flex items-center gap-2 px-3 py-1 border rounded-sm transition-colors ${isRunning ? 'border-accent-orange/30 bg-accent-orange/5 text-accent-orange' : 'border-bg-border text-text-dim'}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${isRunning ? 'bg-accent-orange animate-pulse' : 'bg-text-dim'}`}></div>
              <span className="tracking-[2px] uppercase">{isRunning ? 'LIVE' : 'IDLE'}</span>
            </div>
          </div>
        </div>

        {/* FEED CONTAINER */}
        <div 
          ref={feedContainerRef}
          className="flex-1 overflow-y-auto p-6 md:px-12 lg:px-24 flex flex-col gap-8 font-mono pb-32 scroll-smooth"
          onScroll={(e) => {
            const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
            const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
            setAutoScroll(isAtBottom);
          }}
        >
          {!activeTask && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-text-dim animate-in fade-in duration-700">
              <div className="text-2xl font-light">⬡</div>
              <div className="text-xs tracking-[4px] uppercase">Awaiting Mission Input</div>
              <div className="w-12 h-[1px] bg-bg-border"></div>
            </div>
          )}
          
          {iterationGroups.map(([iteration, items]) => (
            <div key={iteration} className="flex flex-col gap-4 animate-in slide-in-from-bottom-2 duration-300">
              <div className="flex items-center gap-4">
                <div className="text-[10px] font-black text-text-dim tracking-[4px] whitespace-nowrap uppercase">
                  Iteration {iteration}
                </div>
                <div className="flex-1 h-[1px] bg-bg-border/50"></div>
              </div>
              
              <div className="flex flex-col gap-3">
                {items.map((mem, i) => {
                  const time = new Date(mem.createdAt || Date.now()).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  let label = "OUTPUT";
                  let content = mem.content || mem.output || '(empty)';
                  let icon = "○";
                  let theme = "border-bg-border text-text-secondary bg-bg-surface/50";

                  if (mem.type === 'thought') {
                    label = "THOUGHT";
                    icon = "◈";
                    theme = "border-accent-purple/20 text-accent-purple bg-accent-purple/5 shadow-[0_0_15px_-5px_rgba(124,58,237,0.1)]";
                    content = (mem.thought || mem.content).replace(/Iteration \d+:/i, '').trim();
                  } else if (mem.type === 'command' || mem.type === 'code') {
                    label = "COMMAND";
                    icon = "$";
                    theme = "border-accent-blue/20 text-accent-blue bg-accent-blue/5";
                    content = mem.command || mem.content;
                  } else if (mem.type === 'error') {
                    label = "ERROR";
                    icon = "⚠";
                    theme = "border-accent-red/20 text-accent-red bg-accent-red/5";
                    content = mem.content;
                  }

                  return (
                    <div key={mem.id || i} className={`border rounded flex flex-col transition-all duration-300 ${theme}`}>
                      <div className="flex justify-between items-center px-4 py-2 border-b border-inherit/20 text-[9px] font-bold tracking-[2px] uppercase">
                        <div className="flex items-center gap-2">
                          <span className="text-lg leading-none mt-[-2px]">{icon}</span>
                          <span>{label}</span>
                        </div>
                        <span className="opacity-50 font-medium">{time}</span>
                      </div>
                      <div className={`p-4 text-sm leading-relaxed text-text-primary break-words whitespace-pre-wrap ${mem.type === 'command' || mem.type === 'code' ? 'font-mono bg-black/20' : ''}`}>
                        {content}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div ref={feedEndRef} />
        </div>

        {/* BOTTOM INPUT BAR */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-3xl flex flex-col gap-2 z-20">
          {!autoScroll && memories.length > 0 && (
            <button 
              onClick={() => setAutoScroll(true)}
              className="mx-auto mb-2 px-4 py-1.5 bg-accent-purple text-white text-[10px] font-bold tracking-widest uppercase rounded-full shadow-lg hover:scale-105 transition-transform"
            >
              ↓ Resume Auto-scroll
            </button>
          )}
          <div className="h-14 bg-bg-surface border border-bg-border rounded-lg flex shadow-2xl overflow-hidden focus-within:border-accent-purple/50 transition-colors">
            <input 
              type="text"
              className="flex-1 bg-transparent text-text-primary px-6 outline-none font-mono text-sm placeholder-text-dim"
              placeholder="Deploy a new mission..."
              value={goalInput}
              onChange={(e) => setGoalInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && deployTask()}
            />
            <button 
              onClick={deployTask}
              disabled={!goalInput.trim()}
              className="px-8 bg-accent-purple text-white font-mono uppercase tracking-[2px] text-xs font-bold hover:bg-opacity-90 disabled:bg-text-dim disabled:cursor-not-allowed transition-all active:scale-95"
            >
              Deploy
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}