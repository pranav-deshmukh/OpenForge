---
name: code-executor
description: Use when you need to write and run Python, Node.js, or bash scripts to build something, process data, or automate tasks.
---

# Code Executor Skill

## Writing and running Python

```bash
cat > /workspace/script.py << 'EOF'
# your code here
EOF
python3 /workspace/script.py
```

## Writing and running Node.js

```bash
cat > /workspace/script.js << 'EOF'
// your code here
EOF
node /workspace/script.js
```

## Installing packages

```bash
pip3 install package-name
npm install package-name
apt-get install -y package-name
```

## Tips

- Always write files to /workspace/
- Test incrementally in small pieces
- Check exit code to confirm success
- If it fails, read stderr and fix
