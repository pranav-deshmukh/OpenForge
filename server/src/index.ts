import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createTask, getAllTasks, getTask, getMemoryForTask } from './memory.js';
import { startQueueWorker } from './queue.js';

const app = express();
app.use(cors());
app.use(express.json());

// One endpoint for everything — agent decides research vs code itself
app.post('/tasks', (req, res) => {
  const { goal } = req.body;
  if (!goal) return res.status(400).json({ error: 'goal is required' });
  const task = createTask(goal);
  res.json(task);
});

app.get('/tasks', (_req, res) => res.json(getAllTasks()));
app.get('/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  res.json(task);
});
app.get('/tasks/:id/memory', (req, res) => {
  res.json(getMemoryForTask(req.params.id));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  startQueueWorker(5000);
});