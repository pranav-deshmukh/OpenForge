import { getIo } from './memory.js';
import type {
  AgentActivitySnapshot,
  AgentId,
  AgentProfile,
  AgentRuntimePhase,
  AgentRuntimeStatus,
  AgentSnapshot,
  MemoryEntry,
  SubTask,
} from './types.js';

const AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'Forge',
    name: 'Forge',
    role: 'Supervisor',
    description: 'Top-level orchestrator that routes work, delegates subtasks, and synthesizes final outcomes.',
    tools: ['queue control', 'delegation', 'task routing', 'artifact overview'],
    capabilities: ['Task Routing', 'Delegation', 'DAG Execution', 'Final Synthesis'],
    memoryScope: 'Global task state and team coordination',
    modelLabel: process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-2.5-pro',
    containerLabel: 'Shared workspace container',
    isolated: false,
    sortOrder: 0,
  },
  {
    id: 'Atlas',
    name: 'Atlas',
    role: 'Planning and Architecture',
    description: 'Breaks goals into task contracts, dependencies, artifact flows, and replanning steps.',
    tools: ['planner prompt', 'dependency mapping', 'artifact planning'],
    capabilities: ['Planning', 'Architecture', 'Task Contracts', 'Replanning'],
    memoryScope: 'Goal, DAG, architecture notes, and planner reflections',
    modelLabel: process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-2.5-pro',
    containerLabel: 'Shared workspace container',
    isolated: false,
    sortOrder: 1,
  },
  {
    id: 'Sage',
    name: 'Sage',
    role: 'Research',
    description: 'Handles research, source gathering, synthesis, and context expansion for execution tasks.',
    tools: ['web-research', 'memory lookup', 'artifact synthesis'],
    capabilities: ['Web Research', 'Summaries', 'Source Analysis'],
    memoryScope: 'Research findings and source summaries',
    modelLabel: process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-2.5-pro',
    containerLabel: 'Shared workspace container',
    isolated: false,
    sortOrder: 2,
  },
  {
    id: 'Cipher',
    name: 'Cipher',
    role: 'Backend Engineering',
    description: 'Builds backend features, APIs, integrations, and operational code paths.',
    tools: ['shell', 'file edits', 'tests'],
    capabilities: ['Backend', 'APIs', 'Refactors', 'DevOps'],
    memoryScope: 'Code execution notes and backend artifact context',
    modelLabel: process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-2.5-pro',
    containerLabel: 'Shared workspace container',
    isolated: false,
    sortOrder: 3,
  },
  {
    id: 'Loom',
    name: 'Loom',
    role: 'Frontend Engineering',
    description: 'Builds interfaces, interaction patterns, and design-consistent frontend deliverables.',
    tools: ['shell', 'file edits', 'build checks'],
    capabilities: ['Frontend', 'UI Systems', 'Interaction Design'],
    memoryScope: 'UI implementation notes and presentation artifacts',
    modelLabel: process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-2.5-pro',
    containerLabel: 'Shared workspace container',
    isolated: false,
    sortOrder: 4,
  },
  {
    id: 'Crucible',
    name: 'Crucible',
    role: 'Verification',
    description: 'Runs acceptance checks, verification passes, and quality review on completed work.',
    tools: ['verifier prompt', 'critic prompt', 'test review'],
    capabilities: ['Verification', 'Testing', 'Quality Gates'],
    memoryScope: 'Verification summaries and quality signals',
    modelLabel: process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-2.5-pro',
    containerLabel: 'Shared workspace container',
    isolated: false,
    sortOrder: 5,
  },
  {
    id: 'Sentry',
    name: 'Sentry',
    role: 'Security',
    description: 'Audits commands, flags risky actions, and enforces safe execution patterns.',
    tools: ['security prompt', 'command audit'],
    capabilities: ['Security Review', 'Shell Audit', 'Risk Control'],
    memoryScope: 'Security alerts and command review outcomes',
    modelLabel: process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-2.5-pro',
    containerLabel: 'Shared workspace container',
    isolated: true,
    sortOrder: 6,
  },
  {
    id: 'Echo',
    name: 'Echo',
    role: 'Reflection and Memory',
    description: 'Analyzes failures, stores lessons, and summarizes project memory for later reuse.',
    tools: ['reflection prompt', 'memory synthesis'],
    capabilities: ['Reflection', 'Memory', 'Failure Analysis'],
    memoryScope: 'Reflections, summaries, and episodic notes',
    modelLabel: process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-2.5-pro',
    containerLabel: 'Shared workspace container',
    isolated: false,
    sortOrder: 7,
  },
];

const runtimeState = new Map<AgentId, AgentRuntimeStatus>();

function createIdleStatus(agentId: AgentId): AgentRuntimeStatus {
  return {
    agentId,
    phase: 'idle',
    online: true,
    activeSubTasks: 0,
    completedSubTasks: 0,
    failedSubTasks: 0,
    blockedSubTasks: 0,
    lastUpdated: Date.now(),
  };
}

for (const profile of AGENT_PROFILES) {
  runtimeState.set(profile.id, createIdleStatus(profile.id));
}

function emitAgentUpdate(agentId: AgentId): void {
  const io = getIo();
  if (!io) return;
  const snapshot = getAgentSnapshot(agentId);
  if (snapshot) {
    io.emit('agent:update', snapshot);
  }
}

export function getAgentProfiles(): AgentProfile[] {
  return AGENT_PROFILES.slice().sort((a, b) => a.sortOrder - b.sortOrder);
}

export function getAgentSnapshot(agentId: AgentId): AgentSnapshot | null {
  const profile = AGENT_PROFILES.find((entry) => entry.id === agentId);
  const runtime = runtimeState.get(agentId);
  if (!profile || !runtime) return null;
  return {
    ...profile,
    ...runtime,
  };
}

export function getAgentSnapshots(subTasks: SubTask[] = []): AgentSnapshot[] {
  const subTasksByAgent = new Map<AgentId, SubTask[]>();
  for (const subTask of subTasks) {
    if (!subTask.assignedAgent) continue;
    const current = subTasksByAgent.get(subTask.assignedAgent) ?? [];
    current.push(subTask);
    subTasksByAgent.set(subTask.assignedAgent, current);
  }

  return getAgentProfiles().map((profile) => {
    const runtime = runtimeState.get(profile.id) ?? createIdleStatus(profile.id);
    const agentSubTasks = subTasksByAgent.get(profile.id) ?? [];
    return {
      ...profile,
      ...runtime,
      activeSubTasks: agentSubTasks.filter((entry) => ['running', 'verifying', 'critiquing', 'retrying', 'waiting_for_human'].includes(entry.status)).length,
      completedSubTasks: agentSubTasks.filter((entry) => entry.status === 'done').length,
      failedSubTasks: agentSubTasks.filter((entry) => entry.status === 'failed').length,
      blockedSubTasks: agentSubTasks.filter((entry) => entry.status === 'blocked').length,
    };
  });
}

export function getAgentActivitySnapshots(
  subTasks: SubTask[],
  memories: MemoryEntry[],
): AgentActivitySnapshot[] {
  return getAgentSnapshots(subTasks).map((snapshot) => {
    const relevantEntries = memories
      .filter((entry) => {
        if (snapshot.currentSubTaskId) {
          return entry.subTaskId === snapshot.currentSubTaskId;
        }
        if (snapshot.currentTaskId) {
          return entry.taskId === snapshot.currentTaskId && !entry.subTaskId;
        }
        return false;
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 4);

    return {
      ...snapshot,
      recentEntries: relevantEntries,
    };
  });
}

export function setAgentPhase(
  agentId: AgentId,
  phase: AgentRuntimePhase,
  details: Partial<AgentRuntimeStatus> = {},
): void {
  const current = runtimeState.get(agentId) ?? createIdleStatus(agentId);
  runtimeState.set(agentId, {
    ...current,
    ...details,
    agentId,
    phase,
    online: details.online ?? true,
    lastUpdated: Date.now(),
  });
  emitAgentUpdate(agentId);
}

export function clearAgentAssignment(agentId: AgentId): void {
  const current = runtimeState.get(agentId) ?? createIdleStatus(agentId);
  runtimeState.set(agentId, {
    ...current,
    phase: 'idle',
    note: undefined,
    currentTaskId: undefined,
    currentTaskGoal: undefined,
    currentSubTaskId: undefined,
    currentSubTaskTitle: undefined,
    online: true,
    lastUpdated: Date.now(),
  });
  emitAgentUpdate(agentId);
}

export function emitDelegationEvent(
  event: 'start' | 'complete',
  payload: {
    from: AgentId;
    to: AgentId;
    taskId: string;
    taskGoal: string;
    subTaskId?: string;
    subTaskTitle?: string;
    note?: string;
  },
): void {
  const io = getIo();
  if (!io) return;
  io.emit(`agent:delegation:${event}`, {
    ...payload,
    timestamp: Date.now(),
  });
}

export function resolveAssignedAgent(subTask: Pick<SubTask, 'type' | 'title' | 'description'>): AgentId {
  switch (subTask.type) {
    case 'planning':
      return 'Atlas';
    case 'reflection':
      return 'Echo';
    case 'research':
      return 'Sage';
    case 'frontend':
      return 'Loom';
    case 'backend':
    case 'devops':
      return 'Cipher';
    case 'testing':
    case 'verification':
    case 'quality_check':
      return 'Crucible';
    case 'security':
      return 'Sentry';
    default: {
      const text = `${subTask.title} ${subTask.description}`.toLowerCase();
      if (/(ui|frontend|design|page|dashboard|layout)/.test(text)) return 'Loom';
      if (/(research|analyze|source|study)/.test(text)) return 'Sage';
      if (/(test|verify|validate|quality|review)/.test(text)) return 'Crucible';
      if (/(secure|security|audit|sandbox)/.test(text)) return 'Sentry';
      if (/(reflect|retry|failure|memory|summary)/.test(text)) return 'Echo';
      return 'Cipher';
    }
  }
}
