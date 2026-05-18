problem: 1. The Agent Has No Real Planning Layer

Right now the loop is:

LLM -> one command -> observe -> repeat

This works for:

simple coding
debugging
small automation

But fails for:

large software systems
multi-agent coordination
long research tasks
dependency graphs
milestone tracking

The agent currently has:

no planner
no task decomposition engine
no DAG execution
no objective hierarchy

This is your biggest limitation.

What You Need

Introduce:

Strategic Planner Agent

Responsible for:

decomposition
milestone generation
dependency ordering
success criteria
subtask allocation

Then:

Worker Agents

Responsible for:

coding
research
testing
debugging

Architecture becomes:

User Goal
↓
Planner Agent
↓
Task Graph
↓
Worker Agents
↓
Verifier Agent
↓
Reflection Agent

Without this, long tasks become chaotic.

plan:
✦ Here is the detailed implementation plan based on the Event-Driven DAG architecture we agreed upon:

Implementation Plan: Event-Driven DAG Multi-Agent Architecture

Background & Motivation
The current PhD-Agent architecture relies on a single continuous loop (loop.ts) where one LLM context handles all
reasoning, action, and observation. As the agent scales to larger software systems and long-horizon tasks, this
single-agent approach suffers from context bloat, lack of task decomposition, and an inability to track complex
dependencies. Modern frameworks (like OpenHands and SWE-agent) solve this using multi-agent architectures and Directed
Acyclic Graphs (DAGs) for execution.

Scope & Impact
This plan replaces the single monolithic loop with a multi-agent orchestrated system based on an Event-Driven DAG
(SWE-AF style).

- Impacts: server/src/loop.ts, server/src/types.ts, server/src/memory.ts, server/src/agent.ts, and frontend
  components that track task progress.
- Benefits: Massive improvement in handling complex tasks, context resetting per sub-task to save tokens and improve
  reasoning, clear milestone tracking, and a production-ready architecture suitable for a high-profile open-source
  release.

Proposed Solution
We will introduce distinct agent personas and a DAG-based execution engine:

1.  Planner Agent: Receives the user goal and outputs a structured DAG of SubTasks.
2.  DAG Executor: A new engine that evaluates the DAG, identifies unblocked subtasks, and pushes them to a local
    queue.
3.  Worker Agents: Specialized prompts (e.g., Coder, Researcher) that execute a single unblocked SubTask in an
    isolated loop, strictly focused on that specific milestone.
4.  Verifier Agent: Validates the outcome of a completed subtask.
5.  Reflection Agent: If a subtask fails repeatedly, this agent analyzes the failure and instructs the Planner to
    update/mutate the DAG.

Alternatives Considered

- LangGraph-style Sequential Hierarchical Loop: Considered for simplicity, but rejected in favor of the DAG approach.
  The DAG approach offers formal dependency tracking and true parallelization potential, which is better aligned with
  modern "openclaw"/OpenHands expectations for a high-tier open-source project.

Implementation Plan

Phase 1: Data Structures & Schema (Types & Memory)

- Update server/src/types.ts to include:
  - SubTask interface (id, parentTaskId, title, description, dependencies: string[], status:
    'pending'|'running'|'done'|'failed', result).
  - Agent Persona types ('planner' | 'worker' | 'verifier' | 'reflection').
- Update server/src/memory.ts to support CRUD operations for SubTasks linked to a parent Task.

Phase 2: Agent Personas & Prompts

- Modify server/src/agent.ts to support persona-based system prompts.
- Create distinct prompt builders for:
  - Planner: Instructions to output a JSON DAG of subtasks.
  - Worker: A leaner version of the current loop prompt, scoped strictly to solving a single SubTask.
  - Verifier: Instructions to write and run tests against the Worker's output.

Phase 3: The DAG Executor Engine

- Replace server/src/loop.ts with a new orchestration engine (orchestrator.ts or refactored loop.ts).
- Flow:
  1.  Initialize Task.
  2.  Invoke Planner Agent to generate SubTasks.
  3.  While Task is not done:
      - Find all SubTasks where status === 'pending' and all dependencies are done.
      - Dispatch Worker Agents for unblocked subtasks (initially sequential for safety, but architecture supports
        parallel).
      - Upon Worker completion, run Verifier Agent.
      - Update SubTask status.
      - If failure, run Reflection Agent to potentially insert new SubTasks to the DAG.

Phase 4: Frontend Adaptation (Optional but Recommended)

- Update the frontend to visualize the DAG and show progress on individual subtasks rather than a single monolithic
  thought stream.

Verification

- Create a complex test goal (e.g., "Build a full-stack CRUD app") that the current single loop fails at.
- Verify that the Planner breaks it down into at least 3-4 dependent steps (e.g., 1. Setup DB, 2. Build Backend, 3.
  Build Frontend).
- Verify Worker agents successfully resolve tasks independently and the task successfully concludes.

Migration & Rollback

- The old runAutonomousLoop logic can be preserved as legacyWorkerLoop during the transition to ensure core shell
  execution capabilities aren't broken.
- Rollback involves reverting the loop.ts entrypoint to call the single agent loop instead of the DAG executor.

Does this plan look good to you, or would you like to make any adjustments before we proceed to formal approval?

changes:

This is actually a very strong plan.

Architecturally, this is now moving from:

LLM agent project

into:

autonomous systems infrastructure

territory.

You’re thinking about the right primitives now:

DAG execution
specialized workers
verification
reflection
replanning
dependency tracking

That’s exactly where serious systems go.

But there are a few VERY important adjustments I would make BEFORE implementation.

These will save you from major architectural pain later.

Overall Assessment
Architecture Direction

Excellent.

Scalability Potential

Very strong.

Biggest Risk

Over-centralized orchestration + unstructured artifacts.

Biggest Missing Piece

Shared world-state / artifact coordination.

The Most Important Adjustments

1. DO NOT Let Planner Output Only a DAG

This is critical.

Right now your planner outputs:

{
"tasks": [...]
}

That is NOT enough long-term.

The planner should output:

{
"goal": "...",
"success_criteria": [...],
"global_context": {...},
"artifacts": [...],
"tasks": [...]
}

This matters enormously.

Why?

Because later:

workers need shared understanding
evaluators need success metrics
replanners need project state
frontend needs structured metadata

Without a shared world model:
parallel agents become inconsistent.

Recommended DAG Node Structure

Instead of:

dependencies: string[]

Add MUCH richer metadata.

Recommended SubTask Schema
interface SubTask {
id: string

title: string
description: string

type:
| 'research'
| 'backend'
| 'frontend'
| 'testing'
| 'verification'
| 'devops'

status:
| 'pending'
| 'running'
| 'blocked'
| 'done'
| 'failed'
| 'retrying'

dependencies: string[]

priority: number

assignedAgent?: string

inputArtifacts: string[]
outputArtifacts: string[]

successCriteria: string[]

retryCount: number

reflections: Reflection[]

createdAt: number
updatedAt: number
}

This will help MASSIVELY later.

2. Add Artifact-Based Coordination NOW

This is probably the most important architectural addition.

Right now workers coordinate implicitly.

BAD.

Workers should coordinate through explicit artifacts.

Example:

{
"artifact": "backend_api_schema_v2"
}

Frontend worker depends on that artifact.

NOT just:

backend task completed

This becomes essential later.

Why This Matters

Without artifact coordination:

workers overwrite each other
assumptions drift
APIs mismatch
schemas break
parallelism becomes chaos

Artifact-driven coordination is what makes DAG systems stable.

3. Add “Blocked” State

Very important.

Current states:

pending
running
done
failed

Need:

blocked
waiting_for_human
retrying
cancelled

Otherwise orchestration becomes messy.

4. Separate Planner Memory from Worker Memory

CRITICAL.

Do NOT give workers:

full trajectory
whole DAG
entire conversation

Worker context should stay SMALL.

Example:

Worker Receives
current task
dependencies
relevant artifacts
relevant reflections
acceptance criteria

ONLY.

This is one of the biggest token optimizations.

5. Reflection Agent Should NOT Mutate DAG Directly

This is VERY important.

Your current wording suggests:

Reflection Agent updates DAG

Bad idea.

Instead:

Reflection Agent → recommendations
Planner → DAG mutations

Why?

Because otherwise:

graph coherence breaks
dependency logic corrupts
workers mutate architecture unpredictably

Planner should remain:

sole owner of graph structure

Extremely important.

6. Add Evaluator Metrics EARLY

This is one of the biggest future unlocks.

Verifier should NOT just say:

pass/fail

It should output structured metrics.

Example:

{
"testsPassed": 24,
"testsFailed": 2,
"coverage": 81,
"lintErrors": 0,
"performanceScore": 0.78
}

This later enables:

benchmarking
optimization
RL-style improvement
quality scoring
automatic replanning 7. Parallelism Should Be “Controlled Parallelism”

This is VERY important.

Do NOT initially allow:

unlimited parallel workers

You WILL destroy context consistency.

Instead:

Parallelize ONLY:
independent research
docs
isolated modules

NOT:

shared codebases simultaneously

Initially set:

MAX_PARALLEL_WORKERS = 2

Seriously.

8. Add Workspace Locking

This becomes important VERY quickly.

Example:

frontend worker edits package.json
backend worker edits package.json
merge conflict

Need:

file locks
directory ownership
artifact ownership
edit scopes

Otherwise parallel agents corrupt workspaces.

9. Introduce “Task Contracts”

Very advanced but HIGHLY recommended.

Every task should define:

Inputs

What it expects.

Outputs

What it guarantees.

Acceptance Criteria

How verifier evaluates it.

Example:

{
"task": "Create auth API",

"inputs": [
"db_schema_v1"
],

"outputs": [
"auth_routes",
"jwt_middleware"
],

"acceptanceCriteria": [
"login endpoint works",
"JWT validation passes"
]
}

This dramatically improves agent reliability.

10. Biggest Future Bottleneck

Not prompts.

Not orchestration.

Not DAGs.

The HARDEST problem will become:

Shared Project Understanding

Eventually you will need:

dependency graphs
architecture maps
code ownership
semantic retrieval
project memory
file relationship tracking

That becomes the true intelligence layer.

Excellent Decision You Already Made

This is VERY smart:

initially sequential for safety

Correct.

Build:

DAG structure first
dependency tracking first
evaluators first

THEN:

parallel execution later

Excellent engineering choice.

One Additional Agent You Should Add Later
Architect Agent

Very important for large projects.

Responsibilities:

enforce architecture consistency
review module boundaries
maintain system design
reject bad abstractions

Without this:
worker agents gradually create spaghetti systems.

Final Architectural Recommendation

Honestly, your revised architecture is now very close to what modern autonomous engineering systems are converging toward.

The most important thing now is:

Treat DAGs as SYSTEM STATE

not merely:

task lists

The DAG should become:

the canonical execution model
source of truth
dependency graph
coordination backbone

That mindset changes everything.

Final Verdict

I would absolutely approve this direction with these adjustments:

MUST ADD
artifact-based coordination
richer task schemas
structured evaluator metrics
planner-owned DAG mutations
worker-scoped memory
SHOULD ADD
workspace locking
task contracts
blocked/retrying states
DELAY UNTIL LATER
aggressive parallelism
distributed execution
worker pools
remote schedulers

This is now becoming a genuinely serious autonomous systems architecture
