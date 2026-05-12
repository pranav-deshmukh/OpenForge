"use client";

import { useEffect, useState, useRef } from "react";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";
import { io } from "socket.io-client";

export default function DashboardPage() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [memories, setMemories] = useState<any[]>([]);
  const [newGoal, setNewGoal] = useState("");
  const [userInput, setUserInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeTask = tasks.find(t => t.id === activeTaskId) || tasks.find(t => t.status === "running") || tasks[0];

  useEffect(() => {
    if (activeTask && activeTask.id !== activeTaskId) {
      setActiveTaskId(activeTask.id);
      api.getTaskMemory(activeTask.id).then(mem => setMemories(mem || []));
    }
  }, [activeTask, activeTaskId]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const fetchedTasks = await api.getTasks() || [];
        setTasks(fetchedTasks);
      } catch (err) {}
    };
    fetchData();

    const socket = io("http://localhost:3000");
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
      if (activeTaskId && memoryItem.taskId === activeTaskId) {
        setMemories((prev) => [...prev, memoryItem]);
      } else if (!activeTaskId) {
        setMemories((prev) => [...prev, memoryItem]);
      }
    });

    return () => { socket.disconnect(); };
  }, [activeTaskId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [memories]);

  const handleStartTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGoal.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const task = await api.createResearchTask(newGoal);
      setNewGoal("");
      setActiveTaskId(task.id);
      setMemories([]);
      setTasks(prev => [task, ...prev]);
    } catch (err) {
      alert("Failed to start task");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSendInput = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userInput.trim() || !activeTaskId || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await api.sendTaskInput(activeTaskId, userInput);
      setUserInput("");
    } catch (err) {
      alert("Failed to send input");
    } finally {
      setIsSubmitting(false);
    }
  };

  const isWaiting = activeTask?.status === "running" && memories.some(m => m.type === 'thought' && m.content?.includes("WAITING FOR USER"));

  return (
    <AppShell>
      <div className="flex flex-col h-[calc(100vh-48px)] w-full bg-bg-base overflow-hidden">
        
        {/* Header: Task Input */}
        <div className="p-4 border-b border-bg-border bg-bg-surface shrink-0">
          <form onSubmit={handleStartTask} className="flex gap-2 max-w-4xl mx-auto w-full">
            <input 
              value={newGoal}
              onChange={(e) => setNewGoal(e.target.value)}
              placeholder="What do you want to achieve?"
              className="flex-1 bg-bg-base border border-bg-border px-4 py-2 text-sm font-mono text-text-primary focus:outline-none focus:border-accent-purple"
            />
            <button 
              type="submit"
              disabled={isSubmitting}
              className="px-6 py-2 bg-accent-purple text-white text-xs font-mono font-bold uppercase tracking-widest disabled:opacity-50"
            >
              RUN
            </button>
          </form>
        </div>

        {/* Main: Chat/Terminal View */}
        <div className="flex-1 overflow-hidden flex flex-col max-w-4xl mx-auto w-full border-x border-bg-border">
          <div className="p-3 border-b border-bg-border bg-bg-surface flex justify-between items-center shrink-0">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${
                activeTask?.status === 'running' ? 'bg-accent-orange animate-pulse-opacity' :
                activeTask?.status === 'completed' ? 'bg-accent-green' : 'bg-text-dim'
              }`} />
              <span className="text-[10px] font-mono uppercase tracking-widest text-text-secondary">
                {activeTask ? `TASK: ${activeTask.goal.slice(0, 50)}${activeTask.goal.length > 50 ? '...' : ''}` : 'NO ACTIVE TASK'}
              </span>
            </div>
            {activeTask && (
              <span className="text-[10px] font-mono text-text-dim">
                ITERATIONS: {activeTask.iterations}/200
              </span>
            )}
          </div>

          <div 
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 font-mono scroll-smooth"
          >
            {memories.length === 0 && !activeTaskId && (
              <div className="h-full flex flex-col items-center justify-center text-text-dim gap-4 opacity-50">
                <div className="text-4xl">◈</div>
                <div className="text-xs uppercase tracking-[0.2em]">Ready for a new goal</div>
              </div>
            )}
            {memories.map((mem, i) => (
              <div 
                key={mem.id || i}
                className={`p-4 text-xs leading-relaxed border-l-2 ${
                  mem.type === 'thought' ? 'border-accent-purple bg-accent-purple/5 text-text-primary' :
                  mem.type === 'command' ? 'border-accent-blue bg-accent-blue/5 text-accent-blue' :
                  mem.type === 'output' ? 'border-text-dim bg-white/5 text-text-secondary' :
                  mem.type === 'error' ? 'border-accent-red bg-accent-red/5 text-accent-red' :
                  mem.type === 'input' ? 'border-accent-green bg-accent-green/5 text-accent-green' :
                  'border-text-dim bg-white/5'
                }`}
              >
                <div className="flex justify-between mb-2 opacity-50 text-[10px] uppercase tracking-wider font-bold">
                  <span>{mem.type === 'thought' ? '◈ Thought' : mem.type === 'command' ? '$ Command' : mem.type === 'input' ? '👤 User Input' : 'Output'}</span>
                  <span>{new Date(mem.createdAt).toLocaleTimeString()}</span>
                </div>
                <div className="whitespace-pre-wrap break-words">
                  {mem.content || mem.thought || mem.command || mem.output || '(empty)'}
                </div>
              </div>
            ))}
          </div>

          {/* Footer: User Interaction */}
          <div className="p-4 border-t border-bg-border bg-bg-surface shrink-0">
            {activeTask?.status === 'running' ? (
              <form onSubmit={handleSendInput} className="flex gap-2">
                <input 
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder={isWaiting ? "Agent is waiting for you..." : "Talk to the agent..."}
                  className={`flex-1 bg-bg-base border px-4 py-2 text-sm font-mono text-text-primary focus:outline-none ${
                    isWaiting ? 'border-accent-green ring-1 ring-accent-green/30' : 'border-bg-border focus:border-accent-purple'
                  }`}
                  autoFocus
                />
                <button 
                  type="submit"
                  disabled={isSubmitting}
                  className={`px-6 py-2 text-white text-xs font-mono font-bold uppercase tracking-widest disabled:opacity-50 ${
                    isWaiting ? 'bg-accent-green' : 'bg-accent-purple'
                  }`}
                >
                  SEND
                </button>
              </form>
            ) : (
              <div className="text-center text-[10px] font-mono text-text-dim uppercase tracking-widest py-2">
                Start a new goal at the top to begin
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}