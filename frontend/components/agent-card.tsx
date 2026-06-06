import { AgentSnapshot } from "@/lib/types";

function phaseLabel(phase: AgentSnapshot["phase"]) {
  switch (phase) {
    case "idle":
      return "Idle";
    case "routing":
      return "Routing";
    case "planning":
      return "Planning";
    case "delegating":
      return "Delegating";
    case "working":
      return "Working";
    case "verifying":
      return "Verifying";
    case "critiquing":
      return "Critiquing";
    case "reflecting":
      return "Reflecting";
    case "blocked":
      return "Blocked";
    default:
      return "Offline";
  }
}

function phaseTone(agent: AgentSnapshot) {
  if (!agent.online || agent.phase === "offline") {
    return {
      dot: "bg-text-dim",
      pill: "bg-[#f1ebe3] text-text-secondary",
      border: "border-bg-border",
    };
  }
  if (agent.phase === "blocked") {
    return {
      dot: "bg-accent-red",
      pill: "bg-[#f6e3df] text-[#934233]",
      border: "border-[#ebc2ba]",
    };
  }
  if (agent.phase === "idle") {
    return {
      dot: "bg-accent-gold",
      pill: "bg-[#f8edd9] text-[#8f6519]",
      border: "border-[#ecd9b8]",
    };
  }
  return {
    dot: "bg-accent-green",
    pill: "bg-[#e2f2ea] text-[#2a7853]",
    border: "border-[#c6e4d5]",
  };
}

export function AgentCard({ agent }: { agent: AgentSnapshot }) {
  const tone = phaseTone(agent);
  const isForge = agent.id === "Forge";

  return (
    <article
      className={`animate-fade-up rounded-[22px] border bg-bg-surface p-5 shadow-soft transition hover:-translate-y-[1px] ${
        isForge ? "border-[#e0c98f] shadow-[0_18px_45px_rgba(182,141,68,0.12)]" : "border-bg-border"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-display text-[2rem] leading-none tracking-tight text-text-primary">
              {agent.name}
            </h2>
            <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${tone.dot}`} />
            <span className="text-[11px] text-text-secondary">{agent.role}</span>
          </div>
          <div className="mt-2 text-[11px] leading-5 text-text-secondary">
            <span>{agent.modelLabel}</span>
            <span className="mx-1.5 text-text-dim">•</span>
            <span>{agent.containerLabel}</span>
          </div>
        </div>

        <div className={`rounded-full border px-3 py-2 text-[11px] leading-4 ${tone.border} ${tone.pill}`}>
          <div>{phaseLabel(agent.phase)}</div>
          <div>{agent.online ? "online" : "offline"}</div>
        </div>
      </div>

      <p className="mt-5 text-[15px] leading-7 text-text-secondary">{agent.description}</p>

      <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-text-secondary">
        {agent.capabilities.map((item) => (
          <span
            key={`${agent.id}-${item}`}
            className="rounded-full bg-[#f4eee5] px-2.5 py-1.5"
          >
            {item}
          </span>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-[11px] text-text-secondary">
        <div>
          <div className="uppercase tracking-[0.16em] text-text-dim">Current</div>
          <div className="mt-1 text-[13px] leading-5 text-text-primary">
            {agent.currentSubTaskTitle ?? agent.currentTaskGoal ?? "No active assignment"}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-[0.16em] text-text-dim">Memory</div>
          <div className="mt-1 text-[13px] leading-5 text-text-primary">{agent.memoryScope}</div>
        </div>
        <div>
          <div className="uppercase tracking-[0.16em] text-text-dim">Completed</div>
          <div className="mt-1 text-[13px] text-text-primary">{agent.completedSubTasks}</div>
        </div>
        <div>
          <div className="uppercase tracking-[0.16em] text-text-dim">Active</div>
          <div className="mt-1 text-[13px] text-text-primary">
            {agent.activeSubTasks}
            {agent.blockedSubTasks > 0 ? ` • ${agent.blockedSubTasks} blocked` : ""}
          </div>
        </div>
      </div>

      {agent.note && (
        <div className="mt-5 rounded-2xl bg-[#faf5ee] px-3 py-3 text-[12px] leading-6 text-text-secondary">
          {agent.note}
        </div>
      )}
    </article>
  );
}
