Fix: Native Tool Calling — Replace Free JSON with Gemini Function Calling
What this fixes
Right now the worker agent returns free-form JSON that you manually parse. The agent has no structured awareness of what tools exist so it defaults to shell commands (sed, echo >) for everything — even when better tools like str_replace exist.
This fix replaces the free JSON loop with Gemini's native function calling API. The model receives a typed list of tools with descriptions, picks the right one automatically, and you dispatch based on what it called. Adding a new skill in the future means adding one entry to the tools array — no prompt engineering ever again.

File 1 — server/src/agent.ts
Change: Add a second export callLLMWithTools
Find the very end of the file, after the closing brace of callLLM. Append this entire block:
typescriptexport interface ToolDefinition {
name: string;
description: string;
parameters: Record<string, any>; // JSON Schema object
}

export interface ToolCall {
name: string;
args: Record<string, any>;
}

export interface LLMToolResponse {
thought: string;
toolCall: ToolCall | null;
rawText: string;
}

export async function callLLMWithTools(
systemPrompt: string,
messages: Message[],
tools: ToolDefinition[]
): Promise<LLMToolResponse> {
const provider = process.env.AI_PROVIDER || 'vertex';
const model = process.env.GEMINI_MODEL ?? process.env.VERTEXAI_MODEL ?? 'gemini-1.5-pro';

let ai: GoogleGenAI;

if (provider === 'vertex') {
const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!project) throw new Error('Missing GOOGLE_CLOUD_PROJECT for Vertex AI');
const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
ai = new GoogleGenAI({ vertexai: true, project, location });
} else {
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
ai = new GoogleGenAI({ apiKey });
}

const geminiTools = [{
functionDeclarations: tools.map(t => ({
name: t.name,
description: t.description,
parameters: t.parameters,
}))
}];

console.log(`[LLM] Calling ${model} with ${tools.length} tools...`);

const result = await (ai.models as any).generateContent({
model,
contents: messages.map((m) => ({
role: m.role === 'assistant' ? 'model' : 'user',
parts: [{ text: m.content }],
})),
tools: geminiTools,
config: {
systemInstruction: systemPrompt,
temperature: 0.2,
},
});

// Extract thought text and function call from response
const candidates = result?.candidates ?? result?.response?.candidates ?? [];
const parts = candidates?.[0]?.content?.parts ?? [];

let thought = '';
let toolCall: ToolCall | null = null;

for (const part of parts) {
if (part.text) {
thought += part.text;
}
if (part.functionCall) {
toolCall = {
name: part.functionCall.name,
args: part.functionCall.args ?? {},
};
}
}

// Fallback: if model returned plain text JSON (some Gemini versions do this)
if (!toolCall && thought) {
try {
const cleaned = thought
.replace(/`json\n?/g, '')
        .replace(/`\n?/g, '')
.replace(/<think>[\s\S]\*?<\/think>/g, '')
.trim();
const parsed = JSON.parse(cleaned);
// If it looks like a tool call in old format, convert it
if (parsed.command && parsed.command !== '' && parsed.command !== 'ask_user') {
toolCall = { name: 'run_shell', args: { command: parsed.command } };
thought = parsed.thought ?? thought;
} else if (parsed.str_replace) {
toolCall = { name: 'str_replace_file', args: parsed.str_replace };
thought = parsed.thought ?? thought;
} else if (parsed.read_file) {
toolCall = { name: 'read_file', args: { path: parsed.read_file } };
thought = parsed.thought ?? thought;
} else if (parsed.done) {
toolCall = { name: 'task_done', args: { summary: parsed.summary ?? '', artifacts: parsed.artifacts ?? [] } };
thought = parsed.thought ?? thought;
} else if (parsed.command === 'ask_user') {
toolCall = { name: 'ask_user', args: { question: parsed.thought ?? '' } };
thought = parsed.thought ?? thought;
}
} catch {
// Not JSON, that's fine — thought text only
}
}

return { thought, toolCall, rawText: thought };
}

File 2 — server/src/loop.ts
Change A: Update the import line at the top
Find:
typescriptimport { callLLM } from './agent.js';
Replace with:
typescriptimport { callLLM, callLLMWithTools } from './agent.js';
import type { ToolDefinition } from './agent.js';
Change B: Update the shell.ts import line
Find:
typescriptimport { ensureWorkspaceReady, execInContainer } from './shell.js';
Replace with:
typescriptimport { ensureWorkspaceReady, execInContainer, strReplaceInContainer, readFileFromContainer } from './shell.js';
Change C: Replace the entire runWorkerAgent function
Find the entire function from:
typescriptasync function runWorkerAgent(task: Task, subTask: SubTask) {
All the way to its closing } (it ends just before async function runSecurityAudit). Replace the whole thing with:
typescript// ── Tool definitions — the agent sees these and picks automatically ──────────
const WORKER_TOOLS: ToolDefinition[] = [
{
name: 'run_shell',
description: 'Run a bash command in the Docker workspace container. Use for: creating new files, installing packages, running tests, starting servers, listing directories, checking git status. Do NOT use for editing existing files — use str_replace_file instead.',
parameters: {
type: 'object',
properties: {
command: {
type: 'string',
description: 'The bash command to execute inside the container'
}
},
required: ['command']
}
},
{
name: 'read_file',
description: 'Read the full contents of a file inside the container. Always call this before editing an existing file so you have the exact current text.',
parameters: {
type: 'object',
properties: {
path: {
type: 'string',
description: 'Absolute path to the file inside the container, e.g. /workspace/src/index.ts'
}
},
required: ['path']
}
},
{
name: 'str_replace_file',
description: 'Surgically edit an existing file by replacing a unique block of text. Never rewrites the whole file. Use this for ALL edits to existing files. old_str must appear exactly once in the file — include enough surrounding lines to make it unique.',
parameters: {
type: 'object',
properties: {
file: {
type: 'string',
description: 'Absolute path to the file inside the container'
},
old_str: {
type: 'string',
description: 'The exact text currently in the file to be replaced. Must be unique — include 2-3 lines of context above and below the change if needed.'
},
new_str: {
type: 'string',
description: 'The text to replace old_str with'
}
},
required: ['file', 'old_str', 'new_str']
}
},
{
name: 'ask_user',
description: 'Pause execution and ask the user a clarifying question. Only use when genuinely blocked and cannot proceed without human input.',
parameters: {
type: 'object',
properties: {
question: {
type: 'string',
description: 'The question to ask the user'
}
},
required: ['question']
}
},
{
name: 'task_done',
description: 'Call this when the subtask is fully complete and all success criteria are met. Do not call this until the work is verified.',
parameters: {
type: 'object',
properties: {
summary: {
type: 'string',
description: 'Detailed summary of everything done, for the verifier agent'
},
artifacts: {
type: 'array',
description: 'List of produced artifacts',
items: {
type: 'object',
properties: {
name: { type: 'string' },
type: { type: 'string' },
content: { type: 'string' }
}
}
}
},
required: ['summary']
}
}
];

async function runWorkerAgent(task: Task, subTask: SubTask) {
updateSubTask(subTask.id, { status: 'running', startedAt: Date.now() });
saveMemory(task.id, 'thought', `Worker starting subtask: ${subTask.title}`, subTask.id, 'working');

const artifacts = getArtifactsForTask(task.id);
const systemPrompt = getSystemPrompt('worker', { task, subTask, artifacts });

const conversationHistory: Message[] = [
{ role: 'user', content: `Start working on SubTask: ${subTask.title}\nDescription: ${subTask.description}` }
];

let lastProcessedInputTime = Date.now();

for (let i = 1; i <= MAX_ITERATIONS_PER_SUBTASK; i++) {
// Check for user input
const newInputs = getMemoryForSubTask(subTask.id).filter(
m => m.type === 'input' && m.createdAt > lastProcessedInputTime
);
for (const input of newInputs) {
conversationHistory.push({ role: 'user', content: `USER INPUT: ${input.content}` });
lastProcessedInputTime = Math.max(lastProcessedInputTime, input.createdAt);
}

    let response;
    try {
      const compressedHistory = conversationHistory.map(m => ({
        ...m,
        content: compressContext(m.content)
      }));
      response = await callLLMWithTools(systemPrompt, compressedHistory, WORKER_TOOLS);
    } catch (err: any) {
      saveMemory(task.id, 'error', `LLM error in worker: ${err.message}`, subTask.id, 'working');
      continue;
    }

    const { thought, toolCall } = response;

    if (thought) {
      saveMemory(task.id, 'thought', `[${subTask.title}] ${thought}`, subTask.id, 'working');
      console.log(`[Worker] ${subTask.title} thought: ${thought.slice(0, 120)}...`);
    }

    // Push assistant turn into history
    conversationHistory.push({ role: 'assistant', content: thought || `[tool: ${toolCall?.name}]` });

    if (!toolCall) {
      // Model returned text only — nudge it to use a tool
      conversationHistory.push({ role: 'user', content: 'Please call one of your available tools to proceed. If the task is complete, call task_done.' });
      continue;
    }

    console.log(`[Worker] Tool call: ${toolCall.name}`, JSON.stringify(toolCall.args).slice(0, 100));

    // ── Dispatch tool calls ──────────────────────────────────────────────────

    if (toolCall.name === 'task_done') {
      const { summary, artifacts: arts = [] } = toolCall.args;
      for (const art of arts) {
        createArtifact({
          taskId: task.id,
          name: art.name,
          type: art.type || 'unknown',
          content: art.content || '',
          producerSubTaskId: subTask.id
        });
      }
      updateSubTask(subTask.id, { status: 'done', completedAt: Date.now(), result: summary });
      return;
    }

    if (toolCall.name === 'ask_user') {
      saveMemory(task.id, 'thought', `[${subTask.title}] WAITING FOR USER: ${toolCall.args.question}`, subTask.id, 'working');
      let waiting = true;
      while (waiting) {
        await new Promise(r => setTimeout(r, 5000));
        const checkInputs = getMemoryForSubTask(subTask.id).filter(
          m => m.type === 'input' && m.createdAt > lastProcessedInputTime
        );
        if (checkInputs.length > 0) {
          waiting = false;
          i--;
        }
      }
      continue;
    }

    if (toolCall.name === 'read_file') {
      const { path } = toolCall.args;
      saveMemory(task.id, 'command', `[read_file] ${path}`, subTask.id, 'working');
      const result = await readFileFromContainer(path);
      const output = result.stdout || '(empty file)';
      saveMemory(task.id, 'output', output.slice(0, 2000), subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `Contents of ${path}:\n${output}` });
      continue;
    }

    if (toolCall.name === 'str_replace_file') {
      const { file, old_str, new_str } = toolCall.args;
      saveMemory(task.id, 'command', `[str_replace] ${file}`, subTask.id, 'working');
      const result = await strReplaceInContainer(file, old_str, new_str);
      const output = (result.stdout + result.stderr) || '(no output)';
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `str_replace result (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    if (toolCall.name === 'run_shell') {
      const { command } = toolCall.args;

      // Static blocklist — runs before LLM security audit
      const ALWAYS_BLOCK = [
        /rm\s+-rf\s+\/(?!workspace)/,
        /chmod\s+777\s+\//,
        /curl[^|]+\|\s*(bash|sh)/,
        /wget[^|]+\|\s*(bash|sh)/,
        />\s*\/etc\//,
        /mkfs/,
        /dd\s+if=/,
      ];
      const hardBlocked = ALWAYS_BLOCK.some(pattern => pattern.test(command));
      if (hardBlocked) {
        saveMemory(task.id, 'security_alert', `Hard-blocked command: ${command}`, subTask.id, 'working');
        conversationHistory.push({ role: 'user', content: 'That command is blocked by the security policy. Please use a safer alternative.' });
        continue;
      }

      // LLM security audit as second layer
      const isSafe = await runSecurityAudit(task, command, subTask);
      if (!isSafe) {
        saveMemory(task.id, 'security_alert', `Security audit blocked: ${command}`, subTask.id, 'working');
        conversationHistory.push({ role: 'user', content: 'Security Audit FAILED: command blocked. Please suggest an alternative approach.' });
        continue;
      }

      saveMemory(task.id, 'command', `$ ${command}`, subTask.id, 'working');
      const result = await execInContainer(command, 600000);
      const output = (result.stdout + result.stderr) || '(no output)';
      saveMemory(task.id, 'output', `Exit ${result.exitCode}\n${output}`, subTask.id, 'working');
      conversationHistory.push({ role: 'user', content: `Command output (exit ${result.exitCode}):\n${output}` });
      continue;
    }

    // Unknown tool — tell the model
    conversationHistory.push({ role: 'user', content: `Unknown tool: ${toolCall.name}. Available tools: run_shell, read_file, str_replace_file, ask_user, task_done.` });

}

updateSubTask(subTask.id, { status: 'failed', completedAt: Date.now(), error: 'Max iterations reached' });
}

File 3 — server/src/prompts.ts
Change: Simplify the worker system prompt
The worker no longer needs a JSON format specification — the model receives tool schemas directly. Find the entire case 'worker': return block and replace only the bottom half starting from Respond ONLY in this exact JSON format: down to the end of the template string. Replace it with:
typescriptYou have access to the following tools — use whichever fits the current need:

- run_shell: run bash commands. For new files, installing packages, running tests.
- read_file: read a file's contents. Always do this before editing an existing file.
- str_replace_file: surgically edit an existing file. Never rewrites the whole file. Use this for ALL edits to existing files.
- ask_user: ask the user a question if genuinely blocked.
- task_done: call when all success criteria are met.

Ground every action in empirical evidence. Read before you edit. Verify after you edit.`;

File 4 — server/src/skills.ts
Change: Remove buildSkillCatalog injection from worker (no longer needed)
In server/src/loop.ts, inside the new runWorkerAgent, you'll notice buildSkillCatalog and discoverSkills are no longer called. Remove the import of those two from the top of loop.ts:
Find:
typescriptimport { buildSkillCatalog, discoverSkills } from './skills.js';
Replace with:
typescript// Skills are loaded dynamically in future — not injected statically

Note: skills.ts itself does not need to change. The skill retrieval upgrade (dynamic RAG injection) will use it in the next fix.

Restart after applying
bashcd server && npm run dev
No container rebuild needed.

How to verify it worked
Give the agent this task:

"Edit the file /workspace/Soul.md and change the word 'extremely efficient' to 'blazingly efficient'"

You should now see in the stream:
[Worker] Tool call: read_file
[Worker] Tool call: str_replace_file
STR_REPLACE_OK: replaced 1 occurrence
No sed. No full file rewrite. The model picked the right tool on its own because the tool description said exactly when to use it.

What this unlocks going forward
Adding any new capability in future is now just:
typescript{
name: 'my_new_tool',
description: 'Clear description of when to use this vs other tools',
parameters: { ... }
}
The model discovers and uses it automatically. No prompt changes ever needed.
