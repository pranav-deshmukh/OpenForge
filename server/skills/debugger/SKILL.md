---
name: debugger
description: Use when code fails, throws errors, or produces wrong output. Diagnose and fix issues systematically.
---

# Debugger Skill

## Debug process

1. Read the full error message carefully.
2. Identify exact line and error type.
3. Check if package is installed: `pip3 show package-name`.
4. Add print statements or logs.
5. Fix one issue at a time.
6. Re-run and confirm behavior.

## Common fixes

```bash
pip3 install missing-package
python3 -m py_compile /workspace/script.py
node --check /workspace/script.js
python3 /workspace/script.py 2>&1
cat /workspace/script.py
```

## Tips

- Never guess, start with the error.
- Fix root cause, not symptom.
- Test after every fix.
