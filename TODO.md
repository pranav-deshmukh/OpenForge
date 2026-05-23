# OpenForge V2: Strategic Refactor TODO

Based on the review and research into OpenClaw/OpenHuman architectures, we are evolving OpenForge from a sequential autonomous loop into a multi-agent, parallel, and self-improving orchestration framework.

## 1. Orchestration & Planning (The "Brain")
- [x] **Parallel DAG Execution:** Refactor `runOrchestrator` to execute independent subtasks concurrently using a worker pool or `Promise.all`.
- [x] **Hierarchical Planning:** Enhance the `planner` persona to decompose goals into more granular milestones with explicit success metrics.
- [x] **Dynamic Replanning:** Implement more robust DAG mutation logic when a subtask fails or a block is encountered.
- [x] **Coordinator Pattern:** Formally separate the `Coordinator` (managing the DAG and state) from `Specialist Workers` (doing the work).

## 2. Layered Memory System (The "Neocortex")
- [ ] **Semantic Memory (Vector DB):** Integrate a local vector store (e.g., ChromaDB or a simple HNSW implementation) to enable RAG across the entire project history.
- [x] **Episodic Memory:** Automatically generate and store summaries of completed subtasks and reflections.
- [x] **Markdown Vault:** Store all agent thoughts, commands, and outputs in an Obsidian-compatible Markdown structure (e.g., `/workspace/vault/{task_id}/`).
- [x] **Token Optimization:** Implement a "TokenJuice" layer to compress context (whitespace stripping, deduplication).

## 3. Evaluation & Critics (The "Immune System")
- [x] **Multi-Stage Verification:**
    - [x] **Functional Verifier:** Checks if success criteria are met (existing).
    - [x] **Code Quality Critic:** Runs linters, checks for technical debt and architecture alignment.
    - [x] **Security Critic:** Analyzes proposed shell commands for dangerous patterns before execution.
- [ ] **Reward Functions:** Introduce measurable objectives (e.g., "Must increase test coverage", "Must pass all lint rules") as hard constraints for task completion.

## 4. Skills & Execution (The "Hands")
- [x] **Markdown-Based Skill Evolution:** Allow agents to "discover" and "learn" skills by reading Markdown files.
- [ ] **MCP Integration:** Add support for the Model Context Protocol to connect to external data sources and tools.
- [x] **Enhanced Sandboxing:** Apply resource limits (CPU/Mem) to the Docker containers.

## 5. UI & Observability (The "Face")
- [x] **DAG Visualization:** Show the task graph in the frontend (as cards and status badges).
- [x] **Streamed Reasoning:** Improved Socket.io integration to stream LLM "thoughts" and "security alerts".

## 6. Implementation Plan (All in one go)
1. [x] **Refactor `types.ts`:** Update schemas for multi-agent support and enhanced memory.
2. [x] **Update `memory.ts`:** Add vault logic and layered memory support.
3. [x] **Refactor `loop.ts`:** Implement parallel orchestration and critic loops.
4. [x] **Update `prompts.ts`:** Refine personas (Coordinator, Specialist, Critic).
5. [x] **Update `shell.ts`:** Review sandboxing.
6. [x] **Frontend Updates:** Updated Tasks and Feed pages.
