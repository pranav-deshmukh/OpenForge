# Fix 1: Surgical File Editing via `str_replace` — Stop Rewriting Entire Files

## Problem

The worker agent currently rewrites entire files when it needs to make a change. This causes:

- Massive token waste (sending the whole file back through the LLM every iteration)
- New bugs introduced in unchanged code sections
- Agent loops where fixing one bug breaks something else, causing another full rewrite
- Slow iteration cycles on large files

## Solution Overview

Add a `str_replace` command system that lets the agent surgically edit specific lines/blocks in any file inside the Docker container, exactly like Claude Code, Aider, and Codex do. The agent will read a file, identify the exact block to change, and replace only that block.

---

## Step 1 — Add `strReplaceInContainer` to `server/src/shell.ts`

Find this exact block at the bottom of `server/src/shell.ts`:

```typescript
export async function copyFromContainer(
  containerPath: string,
  localPath: string,
): Promise<void> {
  await execDockerCommand([
    "cp",
    `${CONTAINER_NAME}:${containerPath}`,
    localPath,
  ]);
}
```

Add the following new exported functions **directly after** that block (append to end of file):

```typescript
/**
 * Surgically replace a unique string in a file inside the container.
 * oldStr must appear EXACTLY ONCE in the file.
 * Uses Python to avoid shell escaping hell with sed.
 */
export async function strReplaceInContainer(
  filePath: string,
  oldStr: string,
  newStr: string,
): Promise<ShellResult> {
  // Write a tiny Python script to a temp file in the container to avoid
  // any quoting/escaping issues with heredoc or echo
  const script = [
    "import sys",
    `path = ${JSON.stringify(filePath)}`,
    `old = ${JSON.stringify(oldStr)}`,
    `new = ${JSON.stringify(newStr)}`,
    'with open(path, "r", encoding="utf-8") as f:',
    "    content = f.read()",
    "count = content.count(old)",
    "if count == 0:",
    '    print("STR_REPLACE_ERROR: old_str not found in file", file=sys.stderr)',
    "    sys.exit(1)",
    "if count > 1:",
    '    print(f"STR_REPLACE_ERROR: old_str found {count} times — must be unique", file=sys.stderr)',
    "    sys.exit(1)",
    "new_content = content.replace(old, new, 1)",
    'with open(path, "w", encoding="utf-8") as f:',
    "    f.write(new_content)",
    'print(f"STR_REPLACE_OK: replaced 1 occurrence in {path}")',
  ].join("\n");

  // Write the script into the container as a temp file, then execute it
  const tmpPath = `/tmp/_str_replace_${Date.now()}.py`;
  const writeResult = await execInContainer(
    `cat > ${tmpPath} << 'PYEOF'\n${script}\nPYEOF`,
  );
  if (writeResult.exitCode !== 0) {
    return writeResult;
  }
  const result = await execInContainer(
    `python3 ${tmpPath} && rm -f ${tmpPath}`,
  );
  return result;
}

/**
 * Read a file from the container and return its contents as a string.
 * Use this before str_replace to verify the old_str exists.
 */
export async function readFileFromContainer(
  filePath: string,
): Promise<ShellResult> {
  return execInContainer(`cat ${filePath}`);
}

/**
 * Insert text at a specific line number in a file inside the container.
 * lineNumber is 1-based. Inserts BEFORE the given line.
 */
export async function insertAtLineInContainer(
  filePath: string,
  lineNumber: number,
  textToInsert: string,
): Promise<ShellResult> {
  const script = [
    "import sys",
    `path = ${JSON.stringify(filePath)}`,
    `line_no = ${lineNumber}`,
    `insert_text = ${JSON.stringify(textToInsert)}`,
    'with open(path, "r", encoding="utf-8") as f:',
    "    lines = f.readlines()",
    "if line_no < 1 or line_no > len(lines) + 1:",
    '    print(f"INSERT_ERROR: line {line_no} out of range (file has {len(lines)} lines)", file=sys.stderr)',
    "    sys.exit(1)",
    "# Ensure insert text ends with newline",
    'if not insert_text.endswith("\\n"):',
    '    insert_text += "\\n"',
    "lines.insert(line_no - 1, insert_text)",
    'with open(path, "w", encoding="utf-8") as f:',
    "    f.writelines(lines)",
    'print(f"INSERT_OK: inserted at line {line_no} in {path}")',
  ].join("\n");

  const tmpPath = `/tmp/_insert_line_${Date.now()}.py`;
  await execInContainer(`cat > ${tmpPath} << 'PYEOF'\n${script}\nPYEOF`);
  return execInContainer(`python3 ${tmpPath} && rm -f ${tmpPath}`);
}
```

---

## Step 2 — Handle `str_replace`, `read_file`, `insert_at_line` commands in `server/src/loop.ts`

In `server/src/loop.ts`, find the section inside `runWorkerAgent` that handles shell commands. It looks like this:

```typescript
if (command) {
  // Security Check
  const isSafe = await runSecurityAudit(task, command, subTask);
  if (!isSafe) {
    saveMemory(
      task.id,
      "security_alert",
      `Blocked potentially dangerous command: ${command}`,
      subTask.id,
      "working",
    );
    conversationHistory.push({ role: "assistant", content: raw });
    conversationHistory.push({
      role: "user",
      content:
        "Security Audit FAILED: The proposed command was blocked for safety reasons. Please suggest an alternative approach.",
    });
    continue;
  }

  saveMemory(task.id, "command", `$ ${command}`, subTask.id, "working");
  const result = await execInContainer(command, 600000); // 10 minute timeout
  const output = result.stdout + result.stderr || "(no output)";
  saveMemory(
    task.id,
    "output",
    `Exit ${result.exitCode}\n${output}`,
    subTask.id,
    "working",
  );

  conversationHistory.push({ role: "assistant", content: raw });
  conversationHistory.push({
    role: "user",
    content: `Command output (exit ${result.exitCode}):\n${output}`,
  });
}
```

**Replace that entire block** with the following:

```typescript
if (command) {
  // ── Special structured commands (bypass shell security audit) ──────────

  // str_replace: surgically edit a specific block in an existing file
  if (decision.str_replace) {
    const { file, old_str, new_str } = decision.str_replace;
    saveMemory(
      task.id,
      "command",
      `[str_replace] ${file}`,
      subTask.id,
      "working",
    );
    const result = await strReplaceInContainer(file, old_str, new_str);
    const output = result.stdout + result.stderr || "(no output)";
    saveMemory(
      task.id,
      "output",
      `Exit ${result.exitCode}\n${output}`,
      subTask.id,
      "working",
    );
    conversationHistory.push({ role: "assistant", content: raw });
    conversationHistory.push({
      role: "user",
      content: `str_replace result (exit ${result.exitCode}):\n${output}`,
    });
    continue;
  }

  // read_file: read a file before editing, to confirm old_str exists
  if (decision.read_file) {
    const result = await readFileFromContainer(decision.read_file);
    const output = result.stdout || "(empty file)";
    saveMemory(
      task.id,
      "command",
      `[read_file] ${decision.read_file}`,
      subTask.id,
      "working",
    );
    saveMemory(task.id, "output", output, subTask.id, "working");
    conversationHistory.push({ role: "assistant", content: raw });
    conversationHistory.push({
      role: "user",
      content: `File contents of ${decision.read_file}:\n${output}`,
    });
    continue;
  }

  // insert_at_line: insert code at a specific line number
  if (decision.insert_at_line) {
    const { file, line, text } = decision.insert_at_line;
    saveMemory(
      task.id,
      "command",
      `[insert_at_line] ${file}:${line}`,
      subTask.id,
      "working",
    );
    const result = await insertAtLineInContainer(file, line, text);
    const output = result.stdout + result.stderr || "(no output)";
    saveMemory(
      task.id,
      "output",
      `Exit ${result.exitCode}\n${output}`,
      subTask.id,
      "working",
    );
    conversationHistory.push({ role: "assistant", content: raw });
    conversationHistory.push({
      role: "user",
      content: `insert_at_line result (exit ${result.exitCode}):\n${output}`,
    });
    continue;
  }

  // ── Regular shell command ───────────────────────────────────────────────
  // Security Check
  const isSafe = await runSecurityAudit(task, command, subTask);
  if (!isSafe) {
    saveMemory(
      task.id,
      "security_alert",
      `Blocked potentially dangerous command: ${command}`,
      subTask.id,
      "working",
    );
    conversationHistory.push({ role: "assistant", content: raw });
    conversationHistory.push({
      role: "user",
      content:
        "Security Audit FAILED: The proposed command was blocked for safety reasons. Please suggest an alternative approach.",
    });
    continue;
  }

  saveMemory(task.id, "command", `$ ${command}`, subTask.id, "working");
  const result = await execInContainer(command, 600000); // 10 minute timeout
  const output = result.stdout + result.stderr || "(no output)";
  saveMemory(
    task.id,
    "output",
    `Exit ${result.exitCode}\n${output}`,
    subTask.id,
    "working",
  );

  conversationHistory.push({ role: "assistant", content: raw });
  conversationHistory.push({
    role: "user",
    content: `Command output (exit ${result.exitCode}):\n${output}`,
  });
}
```

---

## Step 3 — Update the import line in `server/src/loop.ts`

Find this import line at the top of `loop.ts`:

```typescript
import { ensureWorkspaceReady, execInContainer } from "./shell.js";
```

Replace it with:

```typescript
import {
  ensureWorkspaceReady,
  execInContainer,
  strReplaceInContainer,
  readFileFromContainer,
  insertAtLineInContainer,
} from "./shell.js";
```

---

## Step 4 — Update the Worker Agent system prompt in `server/src/prompts.ts`

Find the `case 'worker':` block in `getSystemPrompt`. It ends just before `case 'verifier':`. Find this specific line inside the worker prompt:

```typescript
Respond ONLY in this exact JSON format:
{
  "thought": "Explain what you are doing and why.",
  "command": "The shell command to run, or 'ask_user' to pause for input.",
  "done": false
}
```

Replace that section (from `Respond ONLY` down to the closing backtick of the worker case's return statement) with:

```typescript
You have access to a shell and various skills. Your goal is to complete this specific subtask and produce the expected output artifacts.
You MUST NOT drift into other tasks. Focus ONLY on this milestone.

## CRITICAL FILE EDITING RULES

**NEVER rewrite an entire file.** This wastes tokens and introduces new bugs.

For editing existing files, use str_replace or insert_at_line.
For new files, use a shell command like: cat > /workspace/file.ts << 'EOF' ... EOF

## Response Format

For a regular shell command:
\`\`\`json
{
  "thought": "What I am doing and why.",
  "command": "shell command here",
  "done": false
}
\`\`\`

To READ a file before editing (always do this first):
\`\`\`json
{
  "thought": "I need to read the file to find the exact text to replace.",
  "read_file": "/workspace/path/to/file.ts",
  "command": "",
  "done": false
}
\`\`\`

To SURGICALLY EDIT an existing file (preferred for all changes to existing files):
\`\`\`json
{
  "thought": "I need to change only the function foo. I read the file and found the exact text.",
  "str_replace": {
    "file": "/workspace/path/to/file.ts",
    "old_str": "the EXACT lines currently in the file that you want to replace — must be unique in the file",
    "new_str": "the replacement lines"
  },
  "command": "",
  "done": false
}
\`\`\`

To INSERT new code at a specific line number (for adding imports, appending to a class, etc.):
\`\`\`json
{
  "thought": "I need to insert a new import at line 3.",
  "insert_at_line": {
    "file": "/workspace/path/to/file.ts",
    "line": 3,
    "text": "import { something } from './somewhere';"
  },
  "command": "",
  "done": false
}
\`\`\`

To ask the user a question:
\`\`\`json
{
  "thought": "I need clarification.",
  "command": "ask_user",
  "done": false
}
\`\`\`

When finished:
\`\`\`json
{
  "thought": "Final reflection on work completed.",
  "command": "",
  "done": true,
  "summary": "Detailed summary of work done for the verifier.",
  "artifacts": [{"name": "artifact_name", "type": "file|code|schema", "content": "..."}]
}
\`\`\`

## str_replace Rules (important — read carefully)
1. Always call read_file FIRST to get the exact current contents before making a str_replace.
2. old_str must match the file EXACTLY — same whitespace, indentation, and line endings.
3. old_str must be unique in the file. Include enough surrounding context (2–3 lines above and below) to make it unique.
4. Make one str_replace call per logical change. Do not bundle 5 unrelated edits into one giant replacement.
5. After each str_replace, verify with read_file or run the code to confirm it worked before the next edit.
6. If you need to add a function to the end of a file, use: echo '...' >> /path/to/file or a heredoc via shell command — that is fine for appending.

Use the tools provided to interact with the environment. Ground every action in empirical evidence.`;
```

---

## Step 5 — Update `server/skills/file-manager/SKILL.md`

Replace the entire contents of `server/skills/file-manager/SKILL.md` with:

```markdown
---
name: file-manager
description: Use when you need to create, read, edit, organize files and directories, or manage the workspace.
---

# File Manager Skill

## Creating new files

\`\`\`bash
mkdir -p /workspace/my-project
cat > /workspace/file.ts << 'EOF'
// file contents here
EOF
\`\`\`

## Reading files (do this before editing)

\`\`\`bash
cat /workspace/file.ts
cat -n /workspace/file.ts # with line numbers
wc -l /workspace/file.ts # count lines
grep -n "function foo" /workspace/file.ts # find line numbers
\`\`\`

## Editing existing files — use str_replace (preferred)

Use the structured str_replace command in your JSON response instead of shell commands for edits.
It is safer, token-efficient, and cannot accidentally corrupt the file.

Example response to edit an existing file:
\`\`\`json
{
"thought": "I need to fix the return type of the getUser function.",
"str_replace": {
"file": "/workspace/src/users.ts",
"old_str": "export function getUser(id: string) {\n return db.find(id);\n}",
"new_str": "export function getUser(id: string): User | null {\n return db.find(id) ?? null;\n}"
},
"command": "",
"done": false
}
\`\`\`

## When to use shell commands for files

Only use shell commands for file operations when:

- Appending to a file: `echo "new line" >> /workspace/file.txt`
- Deleting files: `rm /workspace/unwanted.ts`
- Moving/copying: `cp /workspace/a.ts /workspace/b.ts`
- Creating directories: `mkdir -p /workspace/new-dir`
- Searching: `grep -rn "pattern" /workspace/src/`
- Checking existence: `ls -la /workspace/`

## Never do this

- `cat > /workspace/existing-file.ts << 'EOF' ... EOF` — this overwrites the whole file
- Large `sed -i` replacements on existing files — use str_replace instead
```

---

## Verification

After applying all changes, test with a task like:

> "In the file /workspace/test.ts, change the console.log message from 'hello' to 'hello world'"

The agent should:

1. Use `read_file` to fetch the file
2. Use `str_replace` with the exact old text and new text
3. Verify the change with another `read_file`

You should see `[str_replace]` log entries in the agent stream, not full file rewrites.

---

## Files changed

| File                                  | Change                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `server/src/shell.ts`                 | Add `strReplaceInContainer`, `readFileFromContainer`, `insertAtLineInContainer`                |
| `server/src/loop.ts`                  | Handle `str_replace`, `read_file`, `insert_at_line` in worker command dispatch + update import |
| `server/src/prompts.ts`               | Rewrite worker prompt to enforce str_replace rules                                             |
| `server/skills/file-manager/SKILL.md` | Document new editing patterns                                                                  |
