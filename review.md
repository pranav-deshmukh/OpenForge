You are refactoring the OpenForge autonomous agent architecture.

Current problem:
The system routes EVERY user message through the Planner + DAG orchestration flow.

This causes terrible UX.

Example:
User: "What is your name?"

Current behavior:

- Generates execution plan
- Creates subtasks
- Waits for approval
- Acts like a workflow engine

This is WRONG.

The system should behave like a natural intelligent assistant for simple interactions, and ONLY escalate into autonomous orchestration for genuinely complex long-running tasks.

Your task:
Refactor the architecture to support adaptive execution modes.

GOAL ARCHITECTURE

User Input
↓
Router / Intent Classifier
↓
┌─────────────────┬─────────────────┬─────────────────┐
│ │ │
Chat Mode Tool Mode Autonomous DAG Mode
│ │ │
Simple LLM Lightweight Planner + DAG
response execution loop Workers + Verifier + Reflection

IMPLEMENTATION REQUIREMENTS

1. ADD ROUTER LAYER

Create a Router system that classifies requests into ONE of these modes:

- "chat"
- "tool"
- "autonomous_dag"

Router should prefer MINIMUM autonomy necessary.

2. CHAT MODE

For:

- greetings
- questions
- explanations
- brainstorming
- conversational requests

Examples:

- "What is your name?"
- "Explain Redis"
- "How do DAGs work?"

Behavior:

- direct LLM response
- NO planner
- NO DAG
- NO workers
- NO orchestration

3. TOOL MODE

For:

- small coding tasks
- shell commands
- quick edits
- running tests
- file operations

Examples:

- "Create a React button"
- "Run npm test"

Behavior:

- lightweight execution loop
- may use tools
- NO DAG planning

4. AUTONOMOUS DAG MODE

ONLY for:

- large projects
- long-running workflows
- multi-step engineering
- dependency-heavy tasks
- autonomous research/build/test systems

Examples:

- "Build a SaaS app"
- "Research and implement OAuth"
- "Create a multi-agent research system"

Behavior:

- invoke planner
- generate DAG
- spawn workers
- verifier
- reflection
- dependency tracking

5. IMPORTANT ARCHITECTURAL RULES

- Planner should NEVER run for simple chat.
- Autonomous orchestration should be expensive and rare.
- System should feel conversational first.
- DAG mode should activate ONLY for genuinely complex tasks.
- Avoid over-agentification.

6. IMPLEMENTATION DETAILS

Refactor:

- loop.ts
- orchestrator.ts
- router.ts
- agent.ts
- prompts
- frontend streaming behavior if needed

Add:

- Router agent/prompt
- mode dispatching
- separate execution paths

7. OUTPUT FORMAT

Provide:

- architectural changes
- exact files to modify
- implementation plan
- code patches
- routing logic
- pseudocode
- improved prompts
- migration strategy

Focus on:

- production-grade UX
- adaptive autonomy
- minimizing unnecessary orchestration
- preserving DAG system for complex workflows
