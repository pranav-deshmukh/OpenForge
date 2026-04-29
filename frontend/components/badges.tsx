import { Task, TaskStatus } from "@/lib/types";

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
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`rounded-full border px-2 py-1 text-xs font-medium capitalize ${STATUS_STYLES[status]}`}>
      {status}
    </span>
  );
}
