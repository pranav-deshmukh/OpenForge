# PhD Agent

A self learning and improving autonomous AI research agent designed to assist with complex research tasks, code execution, debugging, and building new stuff. Built with a skill-based architecture.

## Overview

PhD Agent is an agentic framework that combines:

- **LLM-Driven Autonomy**: Uses Claude to reason about tasks and select appropriate skills
- **Skill Catalog**: Modular skills for web research, code execution, debugging, file management, and paper writing
- **Docker Integration**: Runs in isolated Docker containers with full shell access
- **Memory System**: Maintains context across multiple interactions
- **Task Queue**: Handles async task management

## Architecture

The agent operates in a simple loop:

1. Receive a goal/task
2. Access skill catalog (names + descriptions)
3. Execute shell commands in persistent Docker container
4. Read skill files as needed
5. Install packages, write files, run code
6. Debug and iterate until task completion

No hardcoded actions—just shell access and skills.

## Project Structure

```
phd-agent/
├── frontend/              # Next.js UI dashboard
├── server/               # Agent backend
│   ├── src/
│   │   ├── agent.ts      # LLM interaction
│   │   ├── loop.ts       # Agent loop
│   │   ├── shell.ts      # Docker container shell
│   │   ├── skills.ts     # Skill discovery
│   │   ├── memory.ts     # Context management
│   │   └── index.ts      # Entry point
│   └── skills/           # Skill modules
│       ├── web-research/
│       ├── code-executor/
│       ├── file-manager/
│       ├── debugger/
│       └── paper-writer/
```

## Available Skills

- **Web Research**: Search and analyze information from the web
- **Code Executor**: Execute and test code snippets
- **File Manager**: Create, modify, and manage files
- **Debugger**: Debug and diagnose code issues
- **Paper Writer**: Assist with academic writing and documentation

## Getting Started

### Prerequisites

- Node.js 18+
- Docker (for agent execution environment)
- Google GenAI API key

### Installation

```bash
# Install server dependencies
cd server
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### Configuration

Create `.env` file in the `server/` directory:

```env
GEMINI_API_KEY=your_api_key_here
```

### Running the Agent

```bash
# Start the backend agent
cd server
npm run dev

# In another terminal, start the frontend
cd frontend
npm run dev
```

The agent will be available at `http://localhost:3000` (frontend) with the backend running on `http://localhost:3000` (API).

## How It Works

1. **Goal Input**: Submit a research or coding goal
2. **Skill Selection**: Agent analyzes available skills and selects appropriate ones
3. **Execution**: Runs commands in Docker, reads skill documentation, installs dependencies
4. **Iteration**: Debugs issues, refines approach, loops until goal completion
5. **Results**: Returns structured results and maintains memory for context

## Development

### Adding a New Skill

Create a new skill directory with a `SKILL.md` file:

```
server/skills/your-skill/
└── SKILL.md
```

Document the skill's purpose, inputs, outputs, and examples in the SKILL.md file.

## Technologies

- **Frontend**: Next.js 16, React 19, Tailwind CSS
- **Backend**: Node.js, Express, TypeScript
- **Database**: SQLite (better-sqlite3)
- **Container**: Docker
- **AI**: Google GenAI (Gemini)
- **Research**: Tavily API

## License

MIT

## Author

Built with ❤️ for research automation
