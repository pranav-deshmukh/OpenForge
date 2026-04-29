---
name: system-monitor
description: Use to check system resources like CPU, memory, disk space, and running processes.
---

# System Monitor Skill

## Check CPU Usage

bash
top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\([0-9.]*\)%* id.*/\1/' | awk '{print 100 - $1}'


## Check Memory Usage

bash
free -h


## Check Disk Space

bash
df -h


## List Running Processes

bash
ps aux


## List Top CPU Processes

bash
ps aux --sort=-%cpu | head -n 10


## List Top Memory Processes

bash
ps aux --sort=-%mem | head -n 10

