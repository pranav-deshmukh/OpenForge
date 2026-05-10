# PhD-Agent Architecture

## Overview
PhD-Agent is an autonomous, PhD-level AI researcher and software engineer framework. It is designed to solve complex research and development tasks through a continuous loop of reasoning, tool use, and empirical verification. Unlike traditional "command-and-control" bots, PhD-Agent operates with a high degree of autonomy, managing its own memory, workspace, and skill acquisition.

## Core Rationale
The project is built on the belief that true AI utility comes from **autonomy** and **persistence**.
- **Reasoning First**: Instead of simple pattern matching, it uses a deep reasoning loop (Thought -> Action -> Observation).
- **Tool Grounding**: By providing a full Linux environment (Docker), the agent can actually *do* things—install packages, run benchmarks, and host servers—rather than just talking about them.
- **Empirical Rigor**: It is programmed to never trust its own code without testing it. Verification is a first-class citizen in the agent's logic.

---

## System Components

### 1. The Autonomous Loop (`server/src/loop.ts`)
The "heart" of the system. It orchestrates the agent's lifecycle:
- **Initialization**: Sets up the Docker workspace and builds the skill catalog.
- **Iteration**: A `for` loop that runs up to 200 times per task.
- **Decision Engine**: Feeds the system prompt, skill descriptions, and conversation history into the LLM.
- **Execution**: Parses the LLM's JSON response to extract a `thought` and a `command`.
- **Human-in-the-Loop**: Recently enhanced to support an `ask_user` command. The loop can pause and wait for user input from the dashboard, preventing infinite loops when the agent is stuck.

### 2. Workspace & Shell (`server/src/shell.ts`)
The "body" of the agent. It provides a safe, isolated environment for execution:
- **Docker Isolation**: All commands run inside a persistent Ubuntu container.
- **Pre-configured Environment**: Comes with Python, Node.js, Git, and common data science libraries pre-installed.
- **Persistent Storage**: The `/workspace` directory is mounted from the host, ensuring work isn't lost if the container restarts.
- **Network Access**: Ports 4000-4010 are exposed, allowing the agent to launch and test web servers.

### 3. Memory & State (`server/src/memory.ts`)
The "brain" of the agent. It uses SQLite to maintain a permanent record:
- **Tasks**: Stores goals, status (pending/running/done), and iteration counts.
- **Memory Entries**: Captures every `thought`, `command`, `output`, and `input`. This creates a complete "black box" recording of the agent's reasoning process.
- **Context Injection**: Recent task results are fed back into the agent's system prompt to give it a sense of continuity across different goals.

### 4. Skill System (`server/src/skills.ts`)
The "talent" of the agent. A modular way to extend capabilities:
- **Markdown-Based**: Skills are defined in simple `SKILL.md` files with frontmatter.
- **Discovery**: The agent automatically "discovers" new skills placed in the `server/skills` directory.
- **Instructional**: The agent doesn't just "know" how to use a tool; it reads the documentation (instructions) for the skill inside the container when it needs to use it.

### 5. LLM Integration (`server/src/agent.ts`)
The "intelligence" of the agent:
- **Vertex AI / Gemini**: Uses Google's Gemini models for high-context reasoning.
- **Strict JSON Protocol**: Forces the model to respond in a structured format for reliable parsing.
- **System Instructions**: A robust prompt that defines the agent's identity as a PhD-level researcher.

### 6. Frontend Dashboard (`frontend/`)
The "monitor" for the user:
- **Real-time Updates**: Uses Socket.io to stream thoughts and command outputs directly to the UI.
- **Interactive Tasks**: Allows users to see the agent's progress, read its internal monologue, and provide feedback/clarification via the chat interface.

---

## Operational Flow

1. **Submission**: User submits a goal (e.g., "Build a sorting benchmark").
2. **Queueing**: The task is added to SQLite and picked up by the `QueueWorker`.
3. **Planning**: The agent starts the loop, creates research notes and journals in `/workspace`.
4. **Execution**:
    - Agent searches the web using the `web-research` skill.
    - Agent writes code using `file-manager`.
    - Agent runs code using `code-executor`.
5. **Verification**: Agent writes tests and runs them. If they fail, it iterates.
6. **Completion**: Once satisfied, the agent provides a `summary` and marks the task as `done`.

---

## How to Extend

- **Add a Skill**: Create `server/skills/my-new-skill/SKILL.md`. Define the name, description, and usage instructions.
- **Modify the Brain**: Update `buildSystemPrompt` in `loop.ts` to change the agent's core personality or rules.
- **Enhance the UI**: Add new visualization components in `frontend/components` to show research findings or graphs.

## Newcomers Guide
If you are new to the project, start by reading `server/src/loop.ts`. It is the entry point for understanding how the agent thinks and acts. Next, look at `server/skills/` to see examples of how to give the agent new powers. Finally, run `npm run dev` in both `server` and `frontend` to see the agent in action!
