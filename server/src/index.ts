import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import fs from 'fs/promises';
import { createServer } from 'http';
import path from 'path';
import { Server } from 'socket.io';
import {
  createTask,
  getAllMemory,
  getAllTasks,
  getArtifactsForTask,
  getMemoryForTask,
  getSubTasksForTask,
  getTask,
  recoverInterruptedTasks,
  saveMemory,
  setIo,
  updateSubTask,
  updateTask,
} from './memory.js';
import { getQueueSnapshot, nudgeQueue, startQueueWorker } from './queue.js';
import { getWorkspaceStatus } from './shell.js';
import { discoverSkills } from './skills.js';

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
export const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
});
setIo(io);

io.on('connection', (socket) => {
  console.log('[Socket] Client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('[Socket] Client disconnected:', socket.id);
  });
});

const WORKSPACE_DIR = path.join(process.cwd(), 'workspace');

async function getDirectoryTree(dir: string, baseDir: string): Promise<any> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const children = await Promise.all(
    dirents.map(async (dirent) => {
      const fullPath = path.join(dir, dirent.name);
      const relPath = path.relative(baseDir, fullPath);
      if (dirent.isDirectory()) {
        return {
          name: dirent.name,
          type: 'directory',
          path: relPath,
          children: await getDirectoryTree(fullPath, baseDir),
        };
      }
      return {
        name: dirent.name,
        type: 'file',
        path: relPath,
      };
    }),
  );
  return children;
}

app.get('/ready', async (_req, res) => {
  res.json({
    ready: true,
    queue: getQueueSnapshot(),
    workspace: await getWorkspaceStatus(),
    timestamp: Date.now(),
  });
});

app.get('/system/status', async (_req, res) => {
  const tasks = getAllTasks();
  res.json({
    ready: true,
    queue: getQueueSnapshot(),
    workspace: await getWorkspaceStatus(),
    tasks: {
      total: tasks.length,
      pending: tasks.filter((task) => task.status === 'pending').length,
      running: tasks.filter((task) => task.status === 'running').length,
      completed: tasks.filter((task) => task.status === 'done').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
      cancelled: tasks.filter((task) => task.status === 'cancelled').length,
    },
    timestamp: Date.now(),
  });
});

app.post('/tasks', (req, res) => {
  const goal = String(req.body?.goal ?? '').trim();
  if (!goal) {
    return res.status(400).json({ error: 'goal is required' });
  }
  const task = createTask(goal);
  nudgeQueue();
  res.status(202).json(task);
});

app.get('/tasks', (_req, res) => {
  res.json(getAllTasks());
});

app.get('/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(task);
});

app.get('/tasks/:id/memory', (req, res) => {
  res.json(getMemoryForTask(req.params.id));
});

app.get('/tasks/:id/subtasks', (req, res) => {
  res.json(getSubTasksForTask(req.params.id));
});

app.get('/tasks/:id/artifacts', (req, res) => {
  res.json(getArtifactsForTask(req.params.id));
});

app.post('/tasks/:id/input', (req, res) => {
  const content = String(req.body?.content ?? '').trim();
  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const entry = saveMemory(req.params.id, 'input', content);
  res.json(entry);
});

app.post('/tasks/:id/cancel', (req, res) => {
  const { id } = req.params;
  const task = getTask(id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  updateTask(id, {
    status: 'cancelled',
    completedAt: Date.now(),
    error: 'Cancelled by user',
  });

  for (const subTask of getSubTasksForTask(id)) {
    if (!['done', 'failed', 'cancelled'].includes(subTask.status)) {
      updateSubTask(subTask.id, {
        status: 'cancelled',
        completedAt: Date.now(),
        error: 'Parent task cancelled',
      });
    }
  }

  nudgeQueue();
  res.json({ success: true, message: 'Task cancelled' });
});

app.get('/workspace/files', async (_req, res) => {
  try {
    const tree = await getDirectoryTree(WORKSPACE_DIR, WORKSPACE_DIR);
    res.json([{ name: 'workspace', type: 'directory', path: '', children: tree }]);
  } catch {
    res.status(500).json({ error: 'Failed to read workspace' });
  }
});

app.get('/workspace/file', async (req, res) => {
  try {
    const filePath = String(req.query.path ?? '');
    if (!filePath) {
      return res.status(400).json({ error: 'Path required' });
    }

    const absolutePath = path.resolve(WORKSPACE_DIR, filePath);
    if (!absolutePath.startsWith(WORKSPACE_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const content = await fs.readFile(absolutePath, 'utf-8');
    res.json({ content });
  } catch {
    res.status(500).json({ error: 'Failed to read file' });
  }
});

app.get('/memory', (_req, res) => {
  res.json(getAllMemory());
});

app.get('/skills', async (_req, res) => {
  try {
    res.json(discoverSkills('./skills'));
  } catch {
    res.status(500).json({ error: 'Failed to read skills' });
  }
});

app.post('/skills', async (req, res) => {
  const { name, description, instructions } = req.body ?? {};
  if (!name || !description || !instructions) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const dirPath = path.join(process.cwd(), 'skills', String(name));
  try {
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, 'SKILL.md'), String(instructions));
    res.json({ success: true, name });
  } catch {
    res.status(500).json({ error: 'Failed to save skill' });
  }
});

const PORT = Number(process.env.PORT || 3000);
httpServer.listen(PORT, () => {
  recoverInterruptedTasks();
  console.log(`[Server] Running on http://localhost:${PORT}`);
  startQueueWorker(5000);
});
