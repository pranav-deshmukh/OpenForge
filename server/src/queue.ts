import { getPendingTasks, updateTask } from './memory.js';
import { processTask } from './loop.js';

const MAX_CONCURRENT_TASKS = 5;
const runningTaskIds = new Set<string>();

export async function processQueue(): Promise<void> {
  if (runningTaskIds.size >= MAX_CONCURRENT_TASKS) return;

  const pending = getPendingTasks();
  if (pending.length === 0) return;

  // Filter out tasks already running (shouldn't happen with status='pending', but safe)
  const toStart = pending.filter(t => !runningTaskIds.has(t.id)).slice(0, MAX_CONCURRENT_TASKS - runningTaskIds.size);

  for (const task of toStart) {
    runningTaskIds.add(task.id);
    console.log(`[Queue] Starting task: ${task.id} (${task.goal.substring(0, 50)}...)`);
    
    // Mark as running immediately so it's not picked up again
    updateTask(task.id, { status: 'running', startedAt: Date.now() });

    // Run in background
    (async () => {
      try {
        await processTask(task);
      } catch (err) {
        console.error(`[Queue] Unexpected error in task ${task.id}:`, err);
        updateTask(task.id, { status: 'failed', error: String(err) });
      } finally {
        runningTaskIds.delete(task.id);
        console.log(`[Queue] Finished task: ${task.id}. Active tasks: ${runningTaskIds.size}`);
      }
    })();
  }
}

export function startQueueWorker(intervalMs = 5000): void {
  console.log(`[Queue] Worker started (Concurrency: ${MAX_CONCURRENT_TASKS}), polling every ${intervalMs}ms`);
  setInterval(processQueue, intervalMs);
}
