export type TaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  mode?: "chat" | "tool" | "autonomous_dag";
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
  | 'waiting_for_human'
  | 'verifying'
  | 'critiquing';

export type SubTaskType = 
  | 'research'
  | 'backend'
  | 'frontend'
  | 'testing'
  | 'verification'
  | 'devops'
  | 'planning'
  | 'reflection'
  | 'security'
  | 'quality_check';

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
  critique?: string;
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

export type MemoryType = 
  | 'research' 
  | 'finding' 
  | 'summary' 
  | 'code' 
  | 'output' 
  | 'error' 
  | 'thought' 
  | 'input' 
  | 'command' 
  | 'critique' 
  | 'security_alert';

export type MemoryLayer = 'working' | 'episodic' | 'semantic' | 'artifact';

export interface MemoryEntry {
  id: string;
  taskId: string;
  subTaskId?: string;
  type: MemoryType;
  layer?: MemoryLayer;
  content: string;
  metadata?: string;
  createdAt: number;
}

export interface MemoryWithTask extends MemoryEntry {
  taskGoal: string;
}

export interface QueueSnapshot {
  concurrency: number;
  runningTaskIds: string[];
  runningCount: number;
  pendingCount: number;
  pending: Array<{
    id: string;
    goal: string;
    createdAt: number;
    mode: string | null;
  }>;
}

export interface WorkspaceStatus {
  containerName: string;
  imageName: string;
  status: "running" | "stopped" | "missing";
}

export interface SystemStatus {
  ready: boolean;
  queue: QueueSnapshot;
  workspace: WorkspaceStatus;
  tasks: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  timestamp: number;
}

