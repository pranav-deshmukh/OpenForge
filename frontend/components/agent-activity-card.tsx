import { AgentActivitySnapshot } from "@/lib/types";

function phaseTone(agent: AgentActivitySnapshot) {
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

function labelForType(type: string) {
  switch (type) {
    case "thought":
      return "Thought";
    case "command":
      return "Command";
    case "output":
      return "Output";
    case "error":
      return "Error";
    case "critique":
      return "Critique";
    case "security_alert":
      return "Security";
    case "input":
      return "User";
    default:
      return type;
  }
}

export function AgentActivityCard({ agent }: { agent: AgentActivitySnapshot }) {
  const tone = phaseTone(agent);
  const isForge = agent.id === "Forge";

  return (
    <article
      className={`animate-fade-up rounded-[22px] border bg-bg-surface p-5 shadow-soft ${
        isForge ? "border-[#e0c98f]" : "border-bg-border"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-display text-[2rem] leading-none tracking-tight">{agent.name}</h2>
            <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${tone.dot}`} />
            <span className="text-[11px] text-text-secondary">{agent.role}</span>
          </div>
          <div className="mt-2 text-[11px] text-text-secondary">
            {agent.currentSubTaskTitle ?? agent.currentTaskGoal ?? "No active assignment"}
          </div>
        </div>

        <div className={`rounded-full border px-3 py-2 text-[11px] ${tone.border} ${tone.pill}`}>
          {agent.phase}
        </div>
      </div>

      <div className="mt-5 rounded-2xl bg-[#faf5ee] px-4 py-4">
        <div className="text-[10px] uppercase tracking-[0.18em] text-text-dim">Current Brief</div>
        <div className="mt-2 text-sm leading-6 text-text-primary">{agent.note ?? "Waiting for work."}</div>
      </div>

      <div className="mt-5">
        <div className="mb-3 text-[10px] uppercase tracking-[0.18em] text-text-dim">Recent Activity</div>
        <div className="space-y-3">
          {agent.recentEntries.length === 0 && (
            <div className="rounded-2xl border border-dashed border-bg-border px-4 py-4 text-sm text-text-secondary">
              No live entries for this agent yet.
            </div>
          )}
          {agent.recentEntries.map((entry) => (
            <div key={entry.id} className="rounded-2xl border border-bg-border bg-white px-3 py-3">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-text-dim">
                <span>{labelForType(entry.type)}</span>
                <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
              </div>
              <div className="mt-2 line-clamp-4 whitespace-pre-wrap text-[13px] leading-6 text-text-secondary">
                {entry.content}
              </div>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}
