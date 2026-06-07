"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import * as api from "@/lib/api";
import { SystemStatus } from "@/lib/types";

type FileNode = {
  name: string;
  type: string;
  path: string;
  children?: FileNode[];
};

export default function WorkspacePage() {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [system, setSystem] = useState<SystemStatus | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  const refresh = async () => {
    try {
      const [files, status] = await Promise.all([
        api.getWorkspaceFiles(),
        api.getSystemStatus(),
      ]);
      setTree(files || []);
      setSystem(status);
    } catch {
      setTree([]);
      setSystem(null);
    }
  };

  const handleFileClick = async (path: string) => {
    setActiveFile(path);
    try {
      const res = await api.getWorkspaceFileContent(path);
      setFileContent(res.content);
    } catch {
      setFileContent("Failed to read file.");
    }
  };

  const renderTree = (nodes: FileNode[], depth = 0) =>
    nodes.map((node) => (
      <div key={`${node.path}:${node.name}`}>
        <button
          type="button"
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
            activeFile === node.path ? "bg-bg-base text-text-primary" : "text-text-secondary hover:bg-bg-base"
          }`}
          style={{ paddingLeft: `${depth * 14 + 12}px` }}
          onClick={() => {
            if (node.type === "file") {
              void handleFileClick(node.path);
            }
          }}
        >
          <span className="text-xs">{node.type === "directory" ? "Dir" : "File"}</span>
          <span className="truncate">{node.name}</span>
        </button>
        {node.children && renderTree(node.children, depth + 1)}
      </div>
    ));

  return (
    <AppShell>
      <div className="flex min-h-[calc(100vh-56px)] flex-col xl:flex-row">
        <aside className="w-full border-b border-bg-border xl:w-80 xl:shrink-0 xl:border-b-0 xl:border-r">
          <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
            <div>
              <div className="text-sm font-medium">Workspace files</div>
              <div className="text-xs text-text-secondary">
                {system?.workspace.status === "running" ? "Container is running" : "Container is not ready"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded border border-bg-border px-3 py-1.5 text-xs text-text-secondary"
            >
              Refresh
            </button>
          </div>
          <div className="max-h-[40vh] overflow-y-auto py-2 xl:max-h-[calc(100vh-180px)]">
            {tree.length > 0 ? renderTree(tree) : <div className="px-4 py-4 text-sm text-text-secondary">No workspace files found.</div>}
          </div>
          <div className="border-t border-bg-border px-4 py-3 text-sm text-text-secondary">
            Queue: {system?.queue.pendingCount ?? 0} pending
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <div className="border-b border-bg-border px-4 py-3">
            <div className="text-sm font-medium">{activeFile ? activeFile : "Select a file"}</div>
          </div>
          <div className="p-4">
            {activeFile ? (
              <pre className="overflow-x-auto whitespace-pre-wrap rounded border border-bg-border bg-bg-surface p-4 text-sm leading-6">
                {fileContent}
              </pre>
            ) : (
              <div className="rounded border border-dashed border-bg-border px-4 py-10 text-sm text-text-secondary">
                Choose a file from the left side to inspect the workspace.
              </div>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
