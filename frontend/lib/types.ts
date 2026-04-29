export type TaskStatus = "pending" | "running" | "done" | "failed";

export type TaskType = "research" | "builder";

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

export interface MemoryEntry {
  id: string;
  taskId: string;
  type: "research" | "finding" | "summary";
  content: string;
  createdAt: number;
}

export interface MemoryWithTask extends MemoryEntry {
  taskGoal: string;
}
