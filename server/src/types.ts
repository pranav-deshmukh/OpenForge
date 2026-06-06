export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export type TaskMode = 'chat' | 'tool' | 'autonomous_dag';

export type AgentId =
  | 'Forge'
  | 'Atlas'
  | 'Sage'
  | 'Cipher'
  | 'Loom'
  | 'Crucible'
  | 'Sentry'
  | 'Echo';

export type AgentRuntimePhase =
  | 'idle'
  | 'routing'
  | 'planning'
  | 'delegating'
  | 'working'
  | 'verifying'
  | 'critiquing'
  | 'reflecting'
  | 'blocked'
  | 'offline';

export interface AgentProfile {
  id: AgentId;
  name: AgentId;
  role: string;
  description: string;
  tools: string[];
  capabilities: string[];
  memoryScope: string;
  modelLabel: string;
  containerLabel: string;
  isolated: boolean;
  sortOrder: number;
}

export interface AgentRuntimeStatus {
  agentId: AgentId;
  phase: AgentRuntimePhase;
  online: boolean;
  note?: string;
  currentTaskId?: string;
  currentTaskGoal?: string;
  currentSubTaskId?: string;
  currentSubTaskTitle?: string;
  activeSubTasks: number;
  completedSubTasks: number;
  failedSubTasks: number;
  blockedSubTasks: number;
  lastUpdated: number;
}

export interface AgentSnapshot extends AgentProfile, AgentRuntimeStatus {}

export interface AgentActivitySnapshot extends AgentSnapshot {
  recentEntries: MemoryEntry[];
}

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  mode?: TaskMode;
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
  assignedAgent?: AgentId;
  inputArtifacts: string[];
  outputArtifacts: string[];
  successCriteria: string[];
  workspaceScope: string[];
  lockedPaths: string[];
  retryCount: number;
  result?: string;
  error?: string;
  critique?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface Reflection {
  id: string;
  subTaskId: string;
  content: string;
  createdAt: number;
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

export type AgentPersona = 
  | 'router'
  | 'chat'
  | 'standalone_worker'
  | 'coordinator' 
  | 'planner' 
  | 'worker' 
  | 'verifier' 
  | 'critic' 
  | 'security' 
  | 'reflection';

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
  subTaskId?: string | null;
  type: MemoryType;
  layer: MemoryLayer;
  content: string;
  metadata?: string; // JSON string for extra context
  createdAt: number;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  role: MessageRole;
  content: string;
}

export interface LoopState {
  goal: string;
  taskId: string;
  subTaskId?: string;
  iterations: number;
  maxIterations: number;
  lastOutput: string;
  memory: string[];       // compressed memory fed to agent
}
