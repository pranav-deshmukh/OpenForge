"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";
import { io } from "socket.io-client";

export default function DashboardPage() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [memories, setMemories] = useState<any[]>([]);
  
  useEffect(() => {
    // Initial fetch
    const fetchData = async () => {
      try {
        const fetchedTasks = await api.getTasks() || [];
        setTasks(fetchedTasks);
        
        // Find active task to get recent memory
        const running = fetchedTasks.find((t: any) => t.status === "running") || fetchedTasks[0];
        if (running) {
          const mem = await api.getTaskMemory(running.id);
          setMemories((mem || []).slice(-8)); // last 8
        }
      } catch (err) {}
    };
    fetchData();

    // Socket Setup
    const socket = io("http://localhost:3000");
    let pollingInterval: NodeJS.Timeout;

    socket.on("connect", () => {
      console.log("Socket connected");
      clearInterval(pollingInterval);
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected, falling back to polling");
      pollingInterval = setInterval(fetchData, 2000);
    });

    socket.on("task:update", (task: any) => {
      setTasks((prev) => {
        const idx = prev.findIndex(t => t.id === task.id);
        if (idx >= 0) {
          const newTasks = [...prev];
          newTasks[idx] = task;
          return newTasks;
        }
        return [task, ...prev];
      });
    });

    socket.on("task:memory", (memoryItem: any) => {
      setMemories((prev) => [...prev, memoryItem].slice(-8));
    });

    return () => {
      clearInterval(pollingInterval);
      socket.disconnect();
    };
  }, []);

  const total = tasks.length;
  const done = tasks.filter(t => t.status === "done").length;
  const failed = tasks.filter(t => t.status === "failed").length;

  return (
    <AppShell>
      <div className="flex flex-col lg:flex-row h-full min-h-[calc(100vh-48px)] w-full">
        {/* Left Column 60% */}
        <div className="w-full lg:w-[60%] p-6 lg:border-r lg:border-bg-border flex flex-col gap-8">
          
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-bg-surface border border-bg-border p-4 flex flex-col gap-1 items-center justify-center">
              <div className="text-[10px] text-text-dim uppercase tracking-[1px] font-mono">TOTAL</div>
              <div className="text-[32px] text-white font-mono leading-none">{total}</div>
            </div>
            <div className="bg-bg-surface border border-bg-border p-4 flex flex-col gap-1 items-center justify-center">
              <div className="text-[10px] text-text-dim uppercase tracking-[1px] font-mono">DONE</div>
              <div className="text-[32px] text-accent-green font-mono leading-none">{done}</div>
            </div>
            <div className="bg-bg-surface border border-bg-border p-4 flex flex-col gap-1 items-center justify-center">
              <div className="text-[10px] text-text-dim uppercase tracking-[1px] font-mono">FAILED</div>
              <div className="text-[32px] text-accent-red font-mono leading-none">{failed}</div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-xs font-mono text-text-secondary uppercase tracking-wider mb-2">Recent Tasks</h2>
            {tasks.map(task => (
              <div key={task.id} className="flex flex-col md:flex-row md:items-center justify-between p-3 border-b border-bg-border hover:bg-bg-elevated cursor-pointer group transition-colors">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${
                    task.status === 'running' ? 'bg-accent-orange animate-pulse-opacity' :
                    task.status === 'completed' ? 'bg-accent-green' :
                    task.status === 'failed' ? 'bg-accent-red' :
                    'bg-text-dim'
                  }`} />
                  <span className="text-sm font-sans line-clamp-1">{task.goal}</span>
                </div>
                <div className="flex items-center gap-3 mt-2 md:mt-0 text-xs font-mono text-text-dim">
                  <span className={`px-2 py-0.5 text-[10px] uppercase tracking-wider rounded-sm border ${
                    task.status === 'running' ? 'text-accent-orange border-accent-orange/30 bg-accent-orange/10' :
                    task.status === 'completed' ? 'text-accent-green border-accent-green/30 bg-accent-green/10' :
                    task.status === 'failed' ? 'text-accent-red border-accent-red/30 bg-accent-red/10' :
                    'text-text-secondary border-text-dim/30 bg-text-dim/10'
                  }`}>
                    {task.status}
                  </span>
                  <span className="opacity-0 group-hover:opacity-100 transition-opacity text-text-secondary">&gt;</span>
                </div>
              </div>
            ))}
            {tasks.length === 0 && (
              <div className="text-sm font-mono text-text-dim p-4 border border-bg-border bg-bg-surface text-center">
                No tasks available.
              </div>
            )}
          </div>

        </div>

        {/* Right Column 40% */}
        <div className="w-full lg:w-[40%] flex flex-col bg-bg-surface">
          <div className="p-4 border-b border-bg-border flex items-center justify-between bg-bg-base">
            <span className="text-xs text-text-secondary font-mono tracking-wider uppercase">Live Feed</span>
          </div>
          
          <div className="flex-1 overflow-auto p-4 flex flex-col gap-3 font-mono text-sm max-h-[80vh]">
            {memories.length === 0 && <div className="text-text-dim">waiting...</div>}
            {memories.map((mem, i) => (
              <div 
                key={mem.id || i}
                className={`p-3 text-xs leading-relaxed border-l-2 bg-text-primary border-opacity-5 ${
                  mem.type === 'thought' ? 'border-accent-purple bg-accent-purple/5' :
                  mem.type === 'command' ? 'border-accent-blue bg-accent-blue/5' :
                  mem.type === 'output' ? 'border-text-dim bg-white/5' :
                  mem.type === 'error' ? 'border-accent-red bg-accent-red/5' :
                  'border-text-dim bg-white/5'
                }`}
              >
                <div className="line-clamp-2 text-text-primary whitespace-pre-wrap">
                  {mem.content || mem.thought || mem.command || mem.output || '(empty)'}
                </div>
              </div>
            ))}
          </div>
          
        </div>
      </div>
    </AppShell>
  );
}