type WorkspaceLock = {
  subTaskId: string;
  paths: string[];
  acquiredAt: number;
};

const locksBySubTask = new Map<string, WorkspaceLock>();
const ownerByPath = new Map<string, string>();

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function pathsConflict(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function tryAcquireWorkspaceLocks(subTaskId: string, rawPaths: string[]): { ok: boolean; conflicts: string[] } {
  const paths = [...new Set(rawPaths.map(normalizePath).filter(Boolean))];
  if (paths.length === 0) {
    return { ok: true, conflicts: [] };
  }

  const conflicts = new Set<string>();
  for (const path of paths) {
    for (const [ownedPath, ownerSubTaskId] of ownerByPath.entries()) {
      if (ownerSubTaskId !== subTaskId && pathsConflict(path, ownedPath)) {
        conflicts.add(ownedPath);
      }
    }
  }

  if (conflicts.size > 0) {
    return { ok: false, conflicts: [...conflicts] };
  }

  locksBySubTask.set(subTaskId, {
    subTaskId,
    paths,
    acquiredAt: Date.now(),
  });
  for (const path of paths) {
    ownerByPath.set(path, subTaskId);
  }

  return { ok: true, conflicts: [] };
}

export function releaseWorkspaceLocks(subTaskId: string): void {
  const lock = locksBySubTask.get(subTaskId);
  if (!lock) return;

  locksBySubTask.delete(subTaskId);
  for (const path of lock.paths) {
    if (ownerByPath.get(path) === subTaskId) {
      ownerByPath.delete(path);
    }
  }
}

export function getWorkspaceLockSnapshot(): WorkspaceLock[] {
  return [...locksBySubTask.values()].sort((a, b) => a.acquiredAt - b.acquiredAt);
}
