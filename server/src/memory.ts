import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Task, MemoryEntry, SubTask, Reflection, Artifact, MemoryLayer } from './types.js';

let ioInstance: any = null;
export function setIo(io: any) {
  ioInstance = io;
}
export function getIo() {
  return ioInstance;
}

const db = new Database('phd-agent.db');

const VAULT_DIR = path.resolve('workspace', 'vault');
if (!fs.existsSync(VAULT_DIR)) {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
}

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    mode TEXT,
    createdAt INTEGER NOT NULL,
    startedAt INTEGER,
    completedAt INTEGER,
    result TEXT,
    error TEXT,
    iterations INTEGER DEFAULT 0,
    globalContext TEXT,
    successCriteria TEXT
  );

  CREATE TABLE IF NOT EXISTS subtasks (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    dependencies TEXT NOT NULL,
    priority INTEGER NOT NULL,
    assignedAgent TEXT,
    inputArtifacts TEXT NOT NULL,
    outputArtifacts TEXT NOT NULL,
    successCriteria TEXT NOT NULL,
    retryCount INTEGER DEFAULT 0,
    result TEXT,
    error TEXT,
    critique TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    startedAt INTEGER,
    completedAt INTEGER,
    FOREIGN KEY (taskId) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS reflections (
    id TEXT PRIMARY KEY,
    subTaskId TEXT NOT NULL,
    content TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY (subTaskId) REFERENCES subtasks(id)
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    producerSubTaskId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY (taskId) REFERENCES tasks(id),
    FOREIGN KEY (producerSubTaskId) REFERENCES subtasks(id)
  );

  CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    subTaskId TEXT,
    type TEXT NOT NULL,
    layer TEXT NOT NULL DEFAULT 'working',
    content TEXT NOT NULL,
    metadata TEXT,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY (taskId) REFERENCES tasks(id)
  );
`);

// Migrations
try {
  db.exec(`ALTER TABLE tasks ADD COLUMN iterations INTEGER DEFAULT 0`);
} catch {}
try {
  db.exec(`ALTER TABLE tasks ADD COLUMN globalContext TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE tasks ADD COLUMN successCriteria TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE tasks ADD COLUMN mode TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE subtasks ADD COLUMN critique TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE memory ADD COLUMN subTaskId TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE memory ADD COLUMN layer TEXT DEFAULT 'working'`);
} catch {}
try {
  db.exec(`ALTER TABLE memory ADD COLUMN metadata TEXT`);
} catch {}

// Helpers
function fromDbSubTask(row: any): SubTask {
  return {
    ...row,
    dependencies: JSON.parse(row.dependencies),
    inputArtifacts: JSON.parse(row.inputArtifacts),
    outputArtifacts: JSON.parse(row.outputArtifacts),
    successCriteria: JSON.parse(row.successCriteria),
  };
}

function toDbSubTask(subTask: SubTask): any {
  return {
    assignedAgent: null,
    result: null,
    error: null,
    critique: null,
    startedAt: null,
    completedAt: null,
    ...subTask,
    dependencies: JSON.stringify(subTask.dependencies),
    inputArtifacts: JSON.stringify(subTask.inputArtifacts),
    outputArtifacts: JSON.stringify(subTask.outputArtifacts),
    successCriteria: JSON.stringify(subTask.successCriteria),
  };
}

function fromDbTask(row: any): Task {
  return {
    ...row,
    successCriteria: row.successCriteria ? JSON.parse(row.successCriteria) : undefined,
  };
}

function toDbTask(task: Task): any {
  return {
    mode: null,
    globalContext: null,
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
    ...task,
    successCriteria: task.successCriteria ? JSON.stringify(task.successCriteria) : null,
  };
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
  const dbTask = toDbTask(task);
  db.prepare(`
    INSERT INTO tasks (id, goal, status, mode, createdAt, iterations, globalContext, successCriteria)
    VALUES (@id, @goal, @status, @mode, @createdAt, @iterations, @globalContext, @successCriteria)
  `).run(dbTask);
  return task;
}

export function updateTask(id: string, updates: Partial<Task>) {
  const existing = getTask(id);
  if (!existing) return;
  const merged = { ...existing, ...updates };
  const dbTask = toDbTask(merged);
  
  const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE tasks SET ${fields} WHERE id = @id`).run({ ...dbTask, id });
  
  const updatedTask = getTask(id);
  if (updatedTask && ioInstance) {
    ioInstance.emit('task:update', updatedTask);
  }
}

export function getTask(id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return row ? fromDbTask(row) : null;
}

export function getAllTasks(): Task[] {
  return db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC').all().map(fromDbTask);
}

export function getPendingTasks(): Task[] {
  return db.prepare("SELECT * FROM tasks WHERE status = 'pending' ORDER BY createdAt ASC").all().map(fromDbTask);
}

// SubTasks
export function createSubTask(subTask: Omit<SubTask, 'id' | 'createdAt' | 'updatedAt' | 'retryCount' | 'status'>): SubTask {
  const newSubTask: SubTask = {
    ...subTask,
    id: uuid(),
    status: 'pending',
    retryCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const dbSubTask = toDbSubTask(newSubTask);
  db.prepare(`
    INSERT INTO subtasks (
      id, taskId, title, description, type, status, dependencies, priority, 
      assignedAgent, inputArtifacts, outputArtifacts, successCriteria, 
      retryCount, createdAt, updatedAt
    ) VALUES (
      @id, @taskId, @title, @description, @type, @status, @dependencies, @priority, 
      @assignedAgent, @inputArtifacts, @outputArtifacts, @successCriteria, 
      @retryCount, @createdAt, @updatedAt
    )
  `).run(dbSubTask);
  
  if (ioInstance) {
    ioInstance.emit('subtask:create', newSubTask);
  }
  return newSubTask;
}

export function updateSubTask(id: string, updates: Partial<SubTask>) {
  const existing = getSubTask(id);
  if (!existing) return;
  const merged = { ...existing, ...updates, updatedAt: Date.now() };
  const dbSubTask = toDbSubTask(merged);
  
  const fields = Object.keys(updates).concat(['updatedAt']).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE subtasks SET ${fields} WHERE id = @id`).run({ ...dbSubTask, id });
  
  const updated = getSubTask(id);
  if (updated && ioInstance) {
    ioInstance.emit('subtask:update', updated);
  }
}

export function getSubTask(id: string): SubTask | null {
  const row = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id);
  return row ? fromDbSubTask(row) : null;
}

export function getSubTasksForTask(taskId: string): SubTask[] {
  return db.prepare('SELECT * FROM subtasks WHERE taskId = ? ORDER BY priority ASC, createdAt ASC').all(taskId).map(fromDbSubTask);
}

// Reflections
export function createReflection(subTaskId: string, content: string): Reflection {
  const reflection: Reflection = {
    id: uuid(),
    subTaskId,
    content,
    createdAt: Date.now(),
  };
  db.prepare(`
    INSERT INTO reflections (id, subTaskId, content, createdAt)
    VALUES (@id, @subTaskId, @content, @createdAt)
  `).run(reflection);
  return reflection;
}

export function getReflectionsForSubTask(subTaskId: string): Reflection[] {
  return db.prepare('SELECT * FROM reflections WHERE subTaskId = ? ORDER BY createdAt ASC').all(subTaskId) as Reflection[];
}

// Artifacts
export function createArtifact(artifact: Omit<Artifact, 'id' | 'createdAt'>): Artifact {
  const newArtifact: Artifact = {
    ...artifact,
    content: typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.content),
    id: uuid(),
    createdAt: Date.now(),
  };
  db.prepare(`
    INSERT INTO artifacts (id, taskId, name, type, content, producerSubTaskId, createdAt)
    VALUES (@id, @taskId, @name, @type, @content, @producerSubTaskId, @createdAt)
  `).run(newArtifact);
  
  if (ioInstance) {
    ioInstance.emit('artifact:create', newArtifact);
  }
  return newArtifact;
}

export function getArtifactsForTask(taskId: string): Artifact[] {
  return db.prepare('SELECT * FROM artifacts WHERE taskId = ? ORDER BY createdAt ASC').all(taskId) as Artifact[];
}

// Memory
export function saveMemory(
  taskId: string, 
  type: MemoryEntry['type'], 
  content: any, 
  subTaskId?: string | null,
  layer: MemoryLayer = 'working',
  metadata?: any
): MemoryEntry {
  const entry: MemoryEntry = {
    id: uuid(),
    taskId,
    subTaskId: subTaskId || null,
    type,
    layer,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    metadata: metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : undefined,
    createdAt: Date.now(),
  };
  db.prepare(`
    INSERT INTO memory (id, taskId, subTaskId, type, layer, content, metadata, createdAt)
    VALUES (@id, @taskId, @subTaskId, @type, @layer, @content, @metadata, @createdAt)
  `).run(entry);
  
  appendToVault(entry);

  if (ioInstance) {
    ioInstance.emit('task:memory', entry);
    if (type === 'thought') ioInstance.emit('agent:thought', entry);
    if (type === 'code' || type === 'command') ioInstance.emit('agent:command', entry);
    if (type === 'output') ioInstance.emit('agent:output', entry);
  }
  
  return entry;
}

export function getMemoryForTask(taskId: string): MemoryEntry[] {
  return db.prepare('SELECT * FROM memory WHERE taskId = ? ORDER BY createdAt ASC').all(taskId) as MemoryEntry[];
}

export function getMemoryForSubTask(subTaskId: string): MemoryEntry[] {
  const subTask = getSubTask(subTaskId);
  if (!subTask) return [];
  // Include memory for THIS subtask AND global task memory (subTaskId IS NULL)
  return db.prepare('SELECT * FROM memory WHERE subTaskId = ? OR (taskId = ? AND subTaskId IS NULL) ORDER BY createdAt ASC')
    .all(subTaskId, subTask.taskId) as MemoryEntry[];
}

export function getAllMemory(): MemoryEntry[] {
  return db.prepare('SELECT * FROM memory ORDER BY createdAt DESC LIMIT 100').all() as MemoryEntry[];
}

function appendToVault(entry: MemoryEntry) {
  const taskDir = path.join(VAULT_DIR, entry.taskId);
  if (!fs.existsSync(taskDir)) {
    fs.mkdirSync(taskDir, { recursive: true });
  }

  const fileName = entry.subTaskId ? `subtask_${entry.subTaskId}.md` : `global.md`;
  const filePath = path.join(taskDir, fileName);

  const timestamp = new Date(entry.createdAt).toISOString();
  const mdContent = `\n### [${timestamp}] ${entry.type.toUpperCase()} (${entry.layer})\n${entry.content}\n${entry.metadata ? `\n**Metadata:**\n\`\`\`json\n${entry.metadata}\n\`\`\`\n` : ''}\n---\n`;

  fs.appendFileSync(filePath, mdContent);
}

export function compressContext(content: string): string {
  return content
    .replace(/\s+/g, ' ')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
}