export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

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
}

export interface MemoryEntry {
  id: string;
  taskId: string;
  type: 'research' | 'finding' | 'summary' | 'code' | 'output' | 'error' | 'thought';
  content: string;
  createdAt: number;
}

export type MessageRole = 'user' | 'assistant';

export interface Message {
  role: MessageRole;
  content: string;
}

export interface LoopState {
  goal: string;
  taskId: string;
  iterations: number;
  maxIterations: number;
  lastOutput: string;
  memory: string[];       // compressed memory fed to agent
}