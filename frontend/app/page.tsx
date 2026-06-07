"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";

export default function HomePage() {
  const [goal, setGoal] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const task = await api.createResearchTask(goal);
      router.push("/tasks");
    } catch (err) {
      alert("Failed to create task. Is the server running?");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppShell>
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] px-4">
        <div className="w-full max-w-2xl animate-fade-up">
          <div className="text-center mb-10">
            <h1 className="font-display text-5xl md:text-6xl tracking-tight text-text-primary mb-4">
              Mission Control
            </h1>
            <p className="text-text-secondary text-lg">
              Deploy autonomous agents to solve complex engineering tasks.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-accent-gold via-accent-purple to-accent-blue rounded-[32px] blur opacity-15 group-hover:opacity-25 transition duration-1000"></div>
            <div className="relative bg-bg-surface border border-bg-border rounded-[28px] p-2 shadow-soft flex flex-col md:flex-row gap-2">
              <input
                type="text"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="What should the agents build or research today?"
                className="flex-1 px-6 py-4 bg-transparent text-text-primary placeholder-text-dim focus:outline-none text-lg"
                autoFocus
              />
              <button
                type="submit"
                disabled={!goal.trim() || isSubmitting}
                className={`px-8 py-4 rounded-2xl font-bold uppercase tracking-widest text-sm transition-all shadow-soft
                  ${goal.trim() && !isSubmitting 
                    ? "bg-[#2b2620] text-white hover:translate-y-[-1px] active:translate-y-[0px]" 
                    : "bg-bg-base text-text-dim cursor-not-allowed"
                  }`}
              >
                {isSubmitting ? "Launching..." : "Launch"}
              </button>
            </div>
          </form>

          <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-6 rounded-3xl border border-bg-border bg-bg-surface/50">
              <div className="text-accent-gold text-2xl mb-3">◈</div>
              <h3 className="font-semibold text-text-primary mb-1">Autonomous</h3>
              <p className="text-xs text-text-secondary leading-relaxed">
                Agents will plan, execute, and verify their own work.
              </p>
            </div>
            <div className="p-6 rounded-3xl border border-bg-border bg-bg-surface/50">
              <div className="text-accent-purple text-2xl mb-3">⬢</div>
              <h3 className="font-semibold text-text-primary mb-1">Multi-Agent</h3>
              <p className="text-xs text-text-secondary leading-relaxed">
                Specialized agents collaborate to solve different parts of the problem.
              </p>
            </div>
            <div className="p-6 rounded-3xl border border-bg-border bg-bg-surface/50">
              <div className="text-accent-blue text-2xl mb-3">▣</div>
              <h3 className="font-semibold text-text-primary mb-1">Sandboxed</h3>
              <p className="text-xs text-text-secondary leading-relaxed">
                All code runs in secure, isolated Docker containers.
              </p>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
