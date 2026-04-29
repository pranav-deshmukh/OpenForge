import { getPendingTasks } from './memory.js';
import { runAutonomousLoop } from './loop.js';

let isProcessing = false;

export async function processQueue(): Promise<void> {
  if (isProcessing) return;
  const pending = getPendingTasks();
  if (pending.length === 0) return;

  isProcessing = true;
  const task = pending[0];

  try {
    await runAutonomousLoop(task);
  } catch (err) {
    console.error('[Queue] Unexpected error:', err);
  } finally {
    isProcessing = false;
  }
}

export function startQueueWorker(intervalMs = 5000): void {
  console.log(`[Queue] Worker started, polling every ${intervalMs}ms`);
  setInterval(processQueue, intervalMs);
}