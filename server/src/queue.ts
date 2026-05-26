import { getPendingTasks, updateTask } from './memory.js';
import { processTask } from './loop.js';

const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS ?? 3);
const runningTaskIds = new Set<string>();
let isProcessingQueue = false;
let queueInterval: NodeJS.Timeout | null = null;

function launchTask(task: Awaited<ReturnType<typeof getPendingTasks>>[number]): void {
  runningTaskIds.add(task.id);
  console.log(`[Queue] Starting task: ${task.id} (${task.goal.substring(0, 50)}...)`);

  updateTask(task.id, { status: 'running', startedAt: Date.now(), error: undefined });

  (async () => {
    try {
      await processTask(task);
    } catch (err) {
      console.error(`[Queue] Unexpected error in task ${task.id}:`, err);
      updateTask(task.id, { status: 'failed', error: String(err), completedAt: Date.now() });
    } finally {
      runningTaskIds.delete(task.id);
      console.log(`[Queue] Finished task: ${task.id}. Active tasks: ${runningTaskIds.size}`);
      void processQueue();
    }
  })();
}

export async function processQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  try {
    while (runningTaskIds.size < MAX_CONCURRENT_TASKS) {
      const nextTask = getPendingTasks().find((task) => !runningTaskIds.has(task.id));
      if (!nextTask) {
        break;
      }
      launchTask(nextTask);
    }
  } finally {
    isProcessingQueue = false;
  }
}

export function startQueueWorker(intervalMs = 5000): void {
  console.log(`[Queue] Worker started (Concurrency: ${MAX_CONCURRENT_TASKS}), polling every ${intervalMs}ms`);
  if (queueInterval) {
    clearInterval(queueInterval);
  }
  queueInterval = setInterval(() => {
    void processQueue();
  }, intervalMs);
  void processQueue();
}

export function nudgeQueue(): void {
  void processQueue();
}

export function getQueueSnapshot() {
  const pending = getPendingTasks();
  return {
    concurrency: MAX_CONCURRENT_TASKS,
    runningTaskIds: [...runningTaskIds],
    runningCount: runningTaskIds.size,
    pendingCount: pending.length,
    pending: pending.map((task) => ({
      id: task.id,
      goal: task.goal,
      createdAt: task.createdAt,
      mode: task.mode ?? null,
    })),
  };
}
