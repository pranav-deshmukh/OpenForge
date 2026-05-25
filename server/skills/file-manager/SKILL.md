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

- Appending to a file: \`echo "new line" >> /workspace/file.txt\`
- Deleting files: \`rm /workspace/unwanted.ts\`
- Moving/copying: \`cp /workspace/a.ts /workspace/b.ts\`
- Creating directories: \`mkdir -p /workspace/new-dir\`
- Searching: \`grep -rn "pattern" /workspace/src/\`
- Checking existence: \`ls -la /workspace/\`

## Never do this

- \`cat > /workspace/existing-file.ts << 'EOF' ... EOF\` — this overwrites the whole file
- Large \`sed -i\` replacements on existing files — use str_replace instead
