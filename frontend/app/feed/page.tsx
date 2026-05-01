"use client";

import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";
import { io } from "socket.io-client";
import Link from "next/link";

export default function FeedPage() {
  const [activeTask, setActiveTask] = useState<any>(null);
  const [memories, setMemories] = useState<any[]>([]);
  const [goalInput, setGoalInput] = useState("");
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
        // Simple distinct check to avoid dupes visually
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
    feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [memories]);

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

  return (
    <AppShell>
      <div className="flex flex-col h-[calc(100vh-48px)] w-full relative">
        
        {/* HEADER */}
        <div className="h-12 border-b border-bg-border bg-bg-surface flex items-center justify-between px-4 sticky top-0 z-10 font-mono">
          <div className="flex items-center gap-4 hidden sm:flex">
            <Link href="/" className="text-text-secondary hover:text-text-primary">
              [← back]
            </Link>
            <span className="text-white uppercase tracking-widest text-xs">LIVE FEED</span>
          </div>
          
          {activeTask && (
            <div className="flex-1 flex max-w-[60%] sm:max-w-[40%] text-xs text-text-dim items-center truncate">
              Task: "{activeTask.goal}"
            </div>
          )}
          
          <div className="flex items-center gap-4 text-xs ml-auto">
            <div className="text-text-dim">
              Iteration {activeTask?.iteration || 0} / 30
            </div>
            <div className={`font-bold flex items-center gap-1 ${isRunning ? 'text-accent-red animate-pulse-opacity' : 'text-text-dim'}`}>
              ●REC
            </div>
          </div>
        </div>

        {/* FEED */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 font-mono text-sm tracking-tight pb-24">
          {!activeTask && (
            <div className="text-text-dim mt-4">Waiting for next task<span className="animate-pulse">_</span></div>
          )}
          
          {memories.map((mem, i) => {
            const time = new Date(mem.createdAt || Date.now()).toLocaleTimeString();
            let borderClass = "border-text-dim";
            let bgClass = "bg-white/[0.02]";
            let textClass = "text-text-secondary";
            let label = "OUTPUT";
            let content = mem.content || mem.output || '(empty)';

            if (mem.type === 'thought') {
               borderClass = "border-accent-purple";
               bgClass = "bg-accent-purple/5";
               textClass = "text-accent-purple";
               label = "◈ THOUGHT";
               content = mem.thought || mem.content;
            } else if (mem.type === 'command') {
               borderClass = "border-accent-blue";
               bgClass = "bg-accent-blue/5";
               textClass = "text-accent-blue";
               label = "$ COMMAND";
               content = mem.command || mem.content;
            } else if (mem.type === 'error') {
               borderClass = "border-accent-red";
               bgClass = "bg-accent-red/5";
               textClass = "text-accent-red";
               label = "⚠ ERROR";
               content = mem.content;
            }

            return (
              <div key={mem.id || i} className={`border-l-2 border border-y-bg-border border-r-bg-border ${borderClass} ${bgClass} rounded-br rounded-tr flex flex-col`}>
                <div className="flex justify-between items-center px-4 py-2 border-b border-bg-border/50 text-xs">
                  <span className={`${textClass} font-semibold uppercase tracking-wider`}>{label}</span>
                  <span className="text-text-dim">{time}</span>
                </div>
                <div className="p-4 whitespace-pre-wrap leading-relaxed text-text-primary break-words">
                  {content}
                </div>
              </div>
            );
          })}
          <div ref={feedEndRef} />
        </div>

        {/* BOTTOM INPUT */}
        <div className="absolute bottom-0 left-0 right-0 h-14 bg-bg-surface border-t border-bg-border flex z-20">
          <input 
            type="text"
            className="flex-1 bg-transparent text-text-primary px-4 outline-none font-mono text-sm placeholder-text-dim"
            placeholder="Give the agent a new goal..."
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && deployTask()}
          />
          <button 
            onClick={deployTask}
            className="px-8 bg-accent-purple text-white font-mono uppercase tracking-[1px] text-xs font-bold hover:bg-opacity-90 transition-colors"
          >
            Deploy
          </button>
        </div>
      </div>
    </AppShell>
  );
}