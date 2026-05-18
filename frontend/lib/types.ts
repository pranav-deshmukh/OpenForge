export type TaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  iterations?: number;
  globalContext?: string;
  successCriteria?: string[];
}

export type SubTaskStatus = 
  | 'pending' 
  | 'running' 
  | 'done' 
  | 'failed' 
  | 'blocked' 
  | 'retrying' 
  | 'cancelled'
  | 'waiting_for_human';

export type SubTaskType = 
  | 'research'
  | 'backend'
  | 'frontend'
  | 'testing'
  | 'verification'
  | 'devops'
  | 'planning'
  | 'reflection';

export interface SubTask {
  id: string;
  taskId: string;
  title: string;
  description: string;
  type: SubTaskType;
  status: SubTaskStatus;
  dependencies: string[];
  priority: number;
  assignedAgent?: string;
  inputArtifacts: string[];
  outputArtifacts: string[];
  successCriteria: string[];
  retryCount: number;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface Artifact {
  id: string;
  taskId: string;
  name: string;
  type: string;
  content: string;
  producerSubTaskId: string;
  createdAt: number;
}

export interface MemoryEntry {
  id: string;
  taskId: string;
  subTaskId?: string;
  type: "research" | "finding" | "summary" | "code" | "output" | "error" | "thought" | "input" | "command";
  content: string;
  createdAt: number;
}

export interface MemoryWithTask extends MemoryEntry {
  taskGoal: string;
}

