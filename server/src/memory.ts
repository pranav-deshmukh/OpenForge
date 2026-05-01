import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { Task, MemoryEntry } from './types.js';

let ioInstance: any = null;
export function setIo(io: any) {
  ioInstance = io;
}

const db = new Database('phd-agent.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    createdAt INTEGER NOT NULL,
    startedAt INTEGER,
    completedAt INTEGER,
    result TEXT,
    error TEXT,
    iterations INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY (taskId) REFERENCES tasks(id)
  );
`);

// Migrate existing db
try {
  db.exec(`ALTER TABLE tasks ADD COLUMN iterations INTEGER DEFAULT 0`);
} catch {
  // Column already exists, ignore
}

// Tasks
export function createTask(goal: string): Task {
  const task: Task = {
    id: uuid(),
    goal,
    status: 'pending',
    createdAt: Date.now(),
    iterations: 0,
  };
  db.prepare(`
    INSERT INTO tasks (id, goal, status, createdAt, iterations)
    VALUES (@id, @goal, @status, @createdAt, @iterations)
  `).run(task);
  return task;
}

export function updateTask(id: string, updates: Partial<Task>) {
  const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE tasks SET ${fields} WHERE id = @id`).run({ ...updates, id });
  const updatedTask = getTask(id);
  if (updatedTask && ioInstance) {
    ioInstance.emit('task:update', updatedTask);
  }
}

export function getTask(id: string): Task | null {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | null;
}

export function getAllTasks(): Task[] {
  return db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC').all() as Task[];
}

export function getPendingTasks(): Task[] {
  return db.prepare("SELECT * FROM tasks WHERE status = 'pending' ORDER BY createdAt ASC").all() as Task[];
}

// Memory
export function saveMemory(taskId: string, type: MemoryEntry['type'], content: string): MemoryEntry {
  const entry: MemoryEntry = {
    id: uuid(),
    taskId,
    type,
    content,
    createdAt: Date.now(),
  };
  db.prepare(`
    INSERT INTO memory (id, taskId, type, content, createdAt)
    VALUES (@id, @taskId, @type, @content, @createdAt)
  `).run(entry);
  
  if (ioInstance) {
    ioInstance.emit('task:memory', entry);
    // also emit the specific agent events as requested in prompt.md
    if (type === 'thought') ioInstance.emit('agent:thought', entry);
    if (type === 'code' || type === 'command') ioInstance.emit('agent:command', entry);
    if (type === 'output') ioInstance.emit('agent:output', entry);
  }
  
  return entry;
}

export function getMemoryForTask(taskId: string): MemoryEntry[] {
  return db.prepare('SELECT * FROM memory WHERE taskId = ? ORDER BY createdAt ASC').all(taskId) as MemoryEntry[];
}

export function getAllMemory(): MemoryEntry[] {
  return db.prepare('SELECT * FROM memory ORDER BY createdAt DESC LIMIT 100').all() as MemoryEntry[];
}