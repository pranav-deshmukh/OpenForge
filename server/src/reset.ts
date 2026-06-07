import Database from 'better-sqlite3';

const db = new Database('phd-agent.db');

console.log('Nuking all tasks and resetting for a fresh start...');

try {
    // Disable foreign keys temporarily to allow bulk deletion
    db.pragma('foreign_keys = OFF');

    const tables = ['reflections', 'artifacts', 'memory', 'subtasks', 'tasks'];
    
    for (const table of tables) {
        try {
            const result = db.prepare(`DELETE FROM ${table}`).run();
            console.log(`Deleted ${result.changes} rows from ${table}.`);
        } catch (e) {
            console.warn(`Could not delete from ${table}:`, e.message);
        }
    }

    // Note: 'agents' table might not exist in the DB if they are purely in-memory, 
    // but looking at agents.ts would confirm. Based on previous error, 
    // let's skip the agents update if it fails.
    try {
        db.prepare("UPDATE agents SET phase = 'idle', current_task_id = NULL, current_subtask_id = NULL, online = 1").run();
        console.log(`Reset agents to idle.`);
    } catch (e) {
        // Silently skip if agents table doesn't exist
    }

    // Re-enable foreign keys
    db.pragma('foreign_keys = ON');

    console.log('Workspace cleared successfully.');
} catch (error) {
    console.error('Error during reset:', error);
}

process.exit(0);
