# OpenForge / PhD-Agent: Product Contract and Fix Log

## What this product should do

After reading the repo docs (`README.md`, `architecture.md`, `updates_arch.md`, `TODO.md`, `fix1.md`, `fix2.md`, `review.md`), the intended product is:

1. A conversational AI engineering and research assistant.
2. It should choose the minimum autonomy needed:
   - `chat` for questions and explanations
   - `tool` for focused code, shell, file, and test work
   - `autonomous_dag` for larger multi-step tasks
3. It should execute work inside a persistent Docker workspace.
4. It should keep task, memory, subtask, and artifact history.
5. It should expose clear status in the frontend for non-technical users.
6. It should edit existing files surgically instead of rewriting them wholesale.
7. It should keep working reliably across queue polling, restart, cancellation, and user follow-up.

## Problems that were present

### Backend execution

1. Gemini tool calling was wired incorrectly, so the model could drift back to plain text or shell-heavy behavior.
2. Existing files could still be overwritten through shell commands even when surgical edit tools existed.
3. Tool prompts and skill docs were not aligned with the actual edit tools.
4. The queue only relied on polling and was not nudged when new work arrived.
5. Cancelled tasks did not actually stop execution loops.
6. Running tasks could get stranded after server restart.
7. Iteration counters shown in the UI were mostly fake.
8. DAG execution depended on subtask title strings instead of stable subtask IDs.
9. DAG mode blocked on manual `"approve"` input, which made the product harder to use.
10. Verifier and critic outputs lacked structured metrics.

### Frontend and usability

1. The frontend used placeholder text and mocked status in places where real system state was needed.
2. The default experience was too trace-heavy for non-technical users.
3. Workspace status and queue state were not surfaced cleanly.
4. Some pages still pointed at stale API behavior or hardcoded URLs.

## Fixes applied

### Backend

1. Corrected Gemini native tool calling in `server/src/agent.ts`.
2. Enforced surgical edits for existing files with:
   - `str_replace_file`
   - `insert_at_line`
   - shell overwrite blocking for existing files
3. Updated prompts and `server/skills/file-manager/SKILL.md` to match the real edit model.
4. Added queue nudging and queue snapshots in `server/src/queue.ts`.
5. Added restart recovery for interrupted running tasks and subtasks in `server/src/memory.ts`.
6. Added real cancellation semantics so cancelled tasks stop progressing.
7. Added actual iteration tracking during tool mode and worker/orchestrator loops.
8. Converted execution-time subtask dependencies to stable subtask IDs.
9. Removed the manual approval gate from DAG mode so planned work starts automatically.
10. Added structured verifier and critic metrics and stored them in memory metadata.
11. Added readiness and system status endpoints:
   - `/ready`
   - `/system/status`
12. Added real workspace container status reporting.

### Frontend

1. Reworked the app shell to show real readiness, workspace, queue, and recent-task state.
2. Replaced the home page with a simpler task-first experience for non-technical users.
3. Connected the frontend to real queue and system status instead of placeholder values.
4. Simplified the live activity page and removed stale hardcoded API creation flow.
5. Replaced the mocked workspace service strip with real workspace/queue information.
6. Updated task UI copy so users can send guidance directly instead of being told to type `"approve"`.

## Result

The product now behaves much closer to the documented contract:

- it routes work more sensibly
- it exposes real system readiness
- it processes the queue more accurately
- it recovers better after interruption
- it cancels work correctly
- it edits existing files surgically
- it presents a simpler frontend for ordinary users

## Verification completed

1. Server typecheck: `npx tsc -p tsconfig.json --noEmit`
2. Frontend production build: `npm run build`
3. Docker runtime check for edit helpers:
   - read file
   - replace exact text
   - insert at line
   - verify final file contents
