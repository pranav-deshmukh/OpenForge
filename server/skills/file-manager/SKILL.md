---
name: file-manager
description: Use when you need to create, read, edit, organize files and directories, or manage the workspace.
---

# File Manager Skill

## Common operations

```bash
mkdir -p /workspace/my-project
cat > /workspace/file.txt << 'EOF'
content here
EOF
cat /workspace/file.txt
ls -la /workspace/
sed -i 's/old-text/new-text/g' /workspace/file.txt
echo "new line" >> /workspace/file.txt
cp /workspace/source.py /workspace/backup.py
rm /workspace/unwanted-file.txt
```
