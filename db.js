const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'taskflow.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar_color TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_members (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    due_date TEXT,
    position REAL NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status, position);
  CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
`);

const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];
const randomColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

// Demo team and project so the board isn't empty on first run. Password for all: "password123".
function seed() {
  const hash = bcrypt.hashSync('password123', 10);
  const addUser = db.prepare('INSERT INTO users (name, email, password_hash, avatar_color) VALUES (?, ?, ?, ?)');
  const [anil, meera, kiran] = [
    ['Anil Kumar', 'anil@demo.com', COLORS[0]],
    ['Meera Iyer', 'meera@demo.com', COLORS[1]],
    ['Kiran Rao', 'kiran@demo.com', COLORS[3]],
  ].map(([name, email, color]) => addUser.run(name, email, hash, color).lastInsertRowid);

  const projectId = db
    .prepare('INSERT INTO projects (name, description, owner_id) VALUES (?, ?, ?)')
    .run('Website Redesign', 'Redesign the company website with a fresh look and better performance.', anil).lastInsertRowid;
  const addMember = db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)');
  addMember.run(projectId, anil, 'owner');
  addMember.run(projectId, meera, 'member');
  addMember.run(projectId, kiran, 'member');

  const day = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  const addTask = db.prepare(`INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, due_date, position, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tasks = [
    ['Create wireframes for home page', 'Low-fidelity wireframes for desktop and mobile.', 'done', 'high', meera, day(-3), 1],
    ['Set up project repository', 'Initialise Git repo, linting and CI.', 'done', 'medium', kiran, day(-5), 2],
    ['Design new colour palette', 'Pick primary, secondary and neutral colours. Check contrast for accessibility.', 'in_progress', 'medium', meera, day(2), 1],
    ['Build responsive navbar', 'Navbar should collapse into a hamburger menu on mobile.', 'in_progress', 'high', kiran, day(1), 2],
    ['Write content for About page', '', 'todo', 'low', anil, day(7), 1],
    ['Optimise images', 'Convert images to WebP and add lazy loading.', 'todo', 'medium', null, day(10), 2],
    ['Set up contact form backend', 'Form should send an email and store submissions.', 'todo', 'high', kiran, day(5), 3],
  ].map(([t, d, s, p, a, due, pos]) => addTask.run(projectId, t, d, s, p, a, due, pos, anil).lastInsertRowid);

  const addComment = db.prepare('INSERT INTO task_comments (task_id, user_id, content) VALUES (?, ?, ?)');
  addComment.run(tasks[2], anil, 'Let us keep it close to our brand blue.');
  addComment.run(tasks[2], meera, 'Sure! I will share 3 options by tomorrow.');
  addComment.run(tasks[3], meera, 'Wireframes for the mobile menu are in the shared folder.');
}

if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) db.transaction(seed)();

module.exports = { db, randomColor };
