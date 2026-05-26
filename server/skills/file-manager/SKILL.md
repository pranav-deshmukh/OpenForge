---
name: file-manager
description: Use when you need to create, read, edit, organize files and directories, or manage the workspace.
---

# File Manager Skill

## Creating new files

```bash
mkdir -p /workspace/my-project
cat > /workspace/file.ts << 'EOF'
// file contents here
EOF
```

## Reading files (do this before editing)

```bash
cat /workspace/file.ts
cat -n /workspace/file.ts # with line numbers
wc -l /workspace/file.ts # count lines
grep -n "function foo" /workspace/file.ts # find line numbers
```

## Editing existing files - use native edit tools

Use the native edit tools instead of shell overwrite commands for edits.
They are safer, token-efficient, and preserve unchanged parts of the file.

Preferred tools:

- `read_file`: read the file before editing.
- `str_replace_file`: replace one unique block in an existing file.
- `insert_at_line`: insert focused text at a specific line.

Rules:

1. Read the file first.
2. Use `str_replace_file` when changing an existing block.
3. Use `insert_at_line` for targeted additions like imports.
4. Do not overwrite an existing file from the shell.

## When to use shell commands for files

Only use shell commands for file operations when:

- Appending to a file: `echo "new line" >> /workspace/file.txt`
- Deleting files: `rm /workspace/unwanted.ts`
- Moving/copying: `cp /workspace/a.ts /workspace/b.ts`
- Creating directories: `mkdir -p /workspace/new-dir`
- Searching: `grep -rn "pattern" /workspace/src/`
- Checking existence: `ls -la /workspace/`

## Never do this

- `cat > /workspace/existing-file.ts << 'EOF' ... EOF` - this overwrites the whole file
- Large `sed -i` replacements on existing files - use `str_replace_file` instead
