import Database from 'better-sqlite3';

const db = new Database('phd-agent.db');

console.log('Resetting stuck tasks...');

const result = db.prepare("UPDATE tasks SET status = 'failed', error = 'Manually terminated' WHERE status = 'running' OR status = 'pending'").run();

console.log(`Updated ${result.changes} tasks to 'failed'.`);

const subtaskResult = db.prepare("UPDATE subtasks SET status = 'failed', error = 'Manually terminated' WHERE status = 'running' OR status = 'pending'").run();

console.log(`Updated ${subtaskResult.changes} subtasks to 'failed'.`);

process.exit(0);
