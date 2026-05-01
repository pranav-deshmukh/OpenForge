import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createTask, getAllTasks, getTask, getMemoryForTask, setIo } from './memory.js';
import { startQueueWorker } from './queue.js';

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
export const io = new Server(httpServer, {
  cors: {
    origin: '*',
  }
});
setIo(io);

io.on('connection', (socket) => {
  console.log('[Socket] Client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('[Socket] Client disconnected:', socket.id);
  });
});

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
import { getAllMemory } from './memory.js';
import { discoverSkills } from './skills.js';
import fs from 'fs/promises';
import path from 'path';

// --- Workspace endpoints ---
const WORKSPACE_DIR = path.join(process.cwd(), 'workspace');

async function getDirectoryTree(dir: string, baseDir: string): Promise<any> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const children = await Promise.all(dirents.map(async (dirent) => {
    const fullPath = path.join(dir, dirent.name);
    const relPath = path.relative(baseDir, fullPath);
    if (dirent.isDirectory()) {
      return {
        name: dirent.name,
        type: 'directory',
        path: relPath,
        children: await getDirectoryTree(fullPath, baseDir)
      };
    } else {
      return {
        name: dirent.name,
        type: 'file',
        path: relPath,
      };
    }
  }));
  return children;
}

app.get('/workspace/files', async (_req, res) => {
  try {
    const tree = await getDirectoryTree(WORKSPACE_DIR, WORKSPACE_DIR);
    res.json([{ name: 'workspace', type: 'directory', path: '', children: tree }]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read workspace' });
  }
});

app.get('/workspace/file', async (req, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: 'Path required' });
    
    const absolutePath = path.join(WORKSPACE_DIR, filePath);
    // Basic security check
    if (!absolutePath.startsWith(WORKSPACE_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const content = await fs.readFile(absolutePath, 'utf-8');
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read file' });
  }
});

app.get('/memory', (_req, res) => {
  res.json(getAllMemory());
});

app.get('/skills', async (_req, res) => {
  try {
    const skills = discoverSkills('./skills');
    res.json(skills);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read skills' });
  }
});

app.post('/skills', async (req, res) => {
  const { name, description, instructions } = req.body;
  if (!name || !description || !instructions) return res.status(400).json({ error: 'Missing required fields' });
  const dirPath = path.join(process.cwd(), 'skills', name);
  try {
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, 'SKILL.md'), instructions);
    res.json({ success: true, name });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save skill' });
  }
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  startQueueWorker(5000);
});