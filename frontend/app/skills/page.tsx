"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";

type Skill = {
  name: string;
  description: string;
  instructions: string;
};

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newSkillForm, setNewSkillForm] = useState({ name: "", description: "", instructions: "" });

  useEffect(() => {
    fetchSkills();
  }, []);

  const fetchSkills = async () => {
    try {
      const data = await api.getSkills();
      setSkills(data || []);
    } catch(err) {}
  };

  const handleCreate = async () => {
    if (!newSkillForm.name || !newSkillForm.description || !newSkillForm.instructions) return;
    try {
      await api.createSkill(newSkillForm.name, newSkillForm.description, newSkillForm.instructions);
      setIsModalOpen(false);
      setNewSkillForm({ name: "", description: "", instructions: "" });
      fetchSkills();
    } catch(err) {}
  };

  return (
    <AppShell>
      <div className="flex flex-col h-full min-h-[calc(100vh-48px)] p-6 bg-bg-base relative">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-sm font-mono tracking-[2px] uppercase text-text-primary">Skills</h1>
          <button 
            onClick={() => setIsModalOpen(true)}
            className="px-4 py-2 bg-accent-purple text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors hover:bg-opacity-90"
          >
            CREATE SKILL
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-max items-start">
          {skills.map((s, i) => (
            <div key={i} className="border border-bg-border bg-bg-surface flex flex-col hover:border-accent-purple transition-colors">
              <div className="p-4 border-b border-bg-border flex items-center gap-3">
                <span className="text-accent-purple w-2 h-2 rounded-full leading-none shrink-0" />
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-text-primary break-all">{s.name}</span>
              </div>
              <div className="p-4 text-sm font-sans text-text-secondary leading-relaxed line-clamp-3 min-h-[80px]">
                {s.description || "No description provided."}
              </div>
              <div className="p-3 border-t border-bg-border font-mono text-xs tracking-wider text-text-dim flex gap-4 uppercase bg-bg-elevated">
                <button className="hover:text-accent-blue transition-colors">[VIEW]</button>
                <button className="hover:text-accent-orange transition-colors">[EDIT]</button>
                <button className="hover:text-accent-red transition-colors ml-auto">[DELETE]</button>
              </div>
            </div>
          ))}
          
          {skills.length === 0 && (
            <div className="col-span-full border border-dashed border-bg-border text-center py-12 text-sm font-mono text-text-dim">
              No skills found. Create one.
            </div>
          )}
        </div>

        {isModalOpen && (
          <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
            <div className="bg-bg-surface border border-bg-border w-full max-w-2xl flex flex-col font-mono text-sm max-h-[90vh]">
              <div className="flex justify-between items-center p-4 border-b border-bg-border text-xs uppercase tracking-widest text-text-secondary">
                <span>NEW SKILL</span>
                <button onClick={() => setIsModalOpen(false)} className="hover:text-white">[✕]</button>
              </div>
              <div className="p-6 flex flex-col gap-4 overflow-y-auto">
                <div className="flex flex-col gap-2">
                  <label className="text-xs text-text-dim uppercase tracking-wider">Skill Name</label>
                  <input 
                    type="text" 
                    value={newSkillForm.name}
                    onChange={(e) => setNewSkillForm({...newSkillForm, name: e.target.value})}
                    placeholder="e.g. WEB-RESEARCH" 
                    className="p-3 bg-bg-base border border-bg-border outline-none focus:border-accent-purple text-text-primary"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-xs text-text-dim uppercase tracking-wider">Description</label>
                  <input 
                    type="text" 
                    value={newSkillForm.description}
                    onChange={(e) => setNewSkillForm({...newSkillForm, description: e.target.value})}
                    placeholder="Use when you need to search..." 
                    className="p-3 bg-bg-base border border-bg-border outline-none focus:border-accent-purple text-text-primary"
                  />
                </div>
                <div className="flex flex-col gap-2 flex-1">
                  <label className="text-xs text-text-dim uppercase tracking-wider">Instructions (Markdown)</label>
                  <textarea 
                    value={newSkillForm.instructions}
                    onChange={(e) => setNewSkillForm({...newSkillForm, instructions: e.target.value})}
                    placeholder="# Web Research Rules..." 
                    className="p-3 bg-bg-base border border-bg-border outline-none focus:border-accent-purple text-text-primary min-h-[300px] resize-none"
                  />
                </div>
                <button 
                  onClick={handleCreate} 
                  className="mt-2 py-3 bg-accent-purple text-white uppercase tracking-widest font-bold focus:opacity-80 transition-opacity"
                >
                  SAVE SKILL
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}