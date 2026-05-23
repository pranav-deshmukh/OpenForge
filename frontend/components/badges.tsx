import { Task, TaskStatus, SubTaskStatus } from "@/lib/types";

export function taskType(task: Task): "Research" | "Builder" {
  const lower = task.goal.toLowerCase();
  return lower.includes("build") || lower.includes("script") || lower.includes("code")
    ? "Builder"
    : "Research";
}

export function TypeBadge({ type }: { type: "Research" | "Builder" }) {
  const style =
    type === "Research"
      ? "bg-blue-500/20 text-blue-300 border-blue-400/30"
      : "bg-violet-500/20 text-violet-300 border-violet-400/30";

  return <span className={`rounded-full border px-2 py-1 text-xs font-medium ${style}`}>{type}</span>;
}

const STATUS_STYLES: Record<TaskStatus, string> = {
  pending: "bg-zinc-500/20 text-zinc-300 border-zinc-400/30",
  running: "bg-amber-500/20 text-amber-300 border-amber-400/30 animate-pulse",
  done: "bg-emerald-500/20 text-emerald-300 border-emerald-400/30",
  failed: "bg-rose-500/20 text-rose-300 border-rose-400/30",
  cancelled: "bg-zinc-500/20 text-zinc-300 border-zinc-400/30",
};

const SUBTASK_STATUS_STYLES: Record<SubTaskStatus, string> = {
  pending: "bg-zinc-500/20 text-zinc-300 border-zinc-400/30",
  running: "bg-amber-500/20 text-amber-300 border-amber-400/30 animate-pulse",
  verifying: "bg-cyan-500/20 text-cyan-300 border-cyan-400/30 animate-pulse",
  critiquing: "bg-indigo-500/20 text-indigo-300 border-indigo-400/30 animate-pulse",
  done: "bg-emerald-500/20 text-emerald-300 border-emerald-400/30",
  failed: "bg-rose-500/20 text-rose-300 border-rose-400/30",
  blocked: "bg-orange-500/20 text-orange-300 border-orange-400/30",
  retrying: "bg-amber-500/20 text-amber-300 border-amber-400/30",
  cancelled: "bg-zinc-500/20 text-zinc-300 border-zinc-400/30",
  waiting_for_human: "bg-purple-500/20 text-purple-300 border-purple-400/30 animate-bounce",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`rounded-full border px-2 py-1 text-xs font-medium capitalize ${STATUS_STYLES[status]}`}>
      {status}
    </span>
  );
}

export function SubTaskStatusBadge({ status }: { status: SubTaskStatus }) {
  return (
    <span className={`rounded-full border px-2 py-1 text-xs font-medium capitalize ${SUBTASK_STATUS_STYLES[status]}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
