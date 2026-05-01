import { MemoryEntry, Task } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export function getTasks(): Promise<Task[]> {
  return request<Task[]>("/tasks");
}

export function getTask(id: string): Promise<Task> {
  return request<Task>(`/tasks/${id}`);
}

export function getTaskMemory(taskId: string): Promise<MemoryEntry[]> {
  return request<MemoryEntry[]>(`/tasks/${taskId}/memory`);
}

export function getAllMemory(): Promise<MemoryEntry[]> {
  return request<MemoryEntry[]>("/memory");
}

export function getSkills(): Promise<any[]> {
  return request<any[]>("/skills");
}

export function getWorkspaceFiles(): Promise<any[]> {
  return request<any[]>("/workspace/files");
}

export function getWorkspaceFileContent(filePath: string): Promise<{ content: string }> {
  return request<{ content: string }>(`/workspace/file?path=${encodeURIComponent(filePath)}`);
}

export function createSkill(name: string, description: string, instructions: string): Promise<any> {
  return request<any>("/skills", {
    method: "POST",
    body: JSON.stringify({ name, description, instructions }),
  });
}

export function createResearchTask(goal: string): Promise<Task> {
  return request<Task>("/tasks", {
    method: "POST",
    body: JSON.stringify({ goal }),
  });
}

export function createBuilderTask(goal: string): Promise<Task> {
  return request<Task>("/build", {
    method: "POST",
    body: JSON.stringify({ goal }),
  });
}
