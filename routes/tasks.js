const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const { getMembership } = require('./projects');
const rt = require('../realtime');

const router = express.Router();
router.use(requireAuth);

const STATUSES = ['todo', 'in_progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];
const STATUS_LABEL = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TASK_SQL = `
  SELECT t.*, u.name AS assignee_name, u.avatar_color AS assignee_color,
    c.name AS creator_name, p.name AS project_name,
    (SELECT COUNT(*) FROM task_comments WHERE task_id = t.id) AS comment_count
  FROM tasks t
  JOIN projects p ON p.id = t.project_id
  JOIN users c ON c.id = t.created_by
  LEFT JOIN users u ON u.id = t.assignee_id
  WHERE t.id = ?`;
const getTask = (id) => db.prepare(TASK_SQL).get(id);

// Loads req.task when the user is a member of the task's project.
function loadTask(req, res, next) {
  const task = getTask(req.params.id);
  if (!task || !getMembership(task.project_id, req.user.id)) return res.status(404).json({ error: 'Task not found' });
  req.task = task;
  next();
}

// Validates whichever task fields are present in body. Returns { error } or the cleaned fields.
function validateFields(body, projectId) {
  const out = {};
  if ('title' in body) {
    out.title = String(body.title || '').trim();
    if (!out.title || out.title.length > 120) return { error: 'Task title is required (max 120 characters)' };
  }
  if ('description' in body) {
    out.description = String(body.description || '').trim();
    if (out.description.length > 2000) return { error: 'Description must be 2000 characters or less' };
  }
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) return { error: 'Invalid status' };
    out.status = body.status;
  }
  if ('priority' in body) {
    if (!PRIORITIES.includes(body.priority)) return { error: 'Invalid priority' };
    out.priority = body.priority;
  }
  if ('assignee_id' in body) {
    out.assignee_id = body.assignee_id ? Number(body.assignee_id) : null;
    if (out.assignee_id && !getMembership(projectId, out.assignee_id)) {
      return { error: 'Tasks can only be assigned to project members' };
    }
  }
  if ('due_date' in body) {
    out.due_date = body.due_date || null;
    if (out.due_date && (!DATE_RE.test(out.due_date) || isNaN(Date.parse(out.due_date)))) {
      return { error: 'Invalid due date' };
    }
  }
  if ('position' in body) {
    out.position = Number(body.position);
    if (!Number.isFinite(out.position)) return { error: 'Invalid position' };
  }
  return out;
}

const nextPosition = (projectId, status) =>
  db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE project_id = ? AND status = ?').get(projectId, status).p;

router.post('/projects/:id/tasks', (req, res) => {
  const projectId = Number(req.params.id);
  if (!getMembership(projectId, req.user.id)) return res.status(404).json({ error: 'Project not found' });
  const v = validateFields({ status: 'todo', priority: 'medium', ...req.body, title: req.body.title ?? '' }, projectId);
  if (v.error) return res.status(400).json(v);

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, due_date, position, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    projectId, v.title, v.description || '', v.status, v.priority, v.assignee_id || null, v.due_date || null,
    nextPosition(projectId, v.status), req.user.id
  );
  const task = getTask(lastInsertRowid);
  rt.notify(task.assignee_id, req.user.id, `${req.user.name} assigned you "${task.title}" in ${task.project_name}`,
    { projectId, taskId: task.id });
  rt.boardChanged(projectId, req.user, `${req.user.name} created "${task.title}"`, { taskId: task.id });
  res.status(201).json(task);
});

router.get('/tasks/:id', loadTask, (req, res) => {
  const comments = db.prepare(`
    SELECT c.*, u.name, u.avatar_color FROM task_comments c JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ? ORDER BY c.created_at, c.id`).all(req.task.id);
  res.json({ ...req.task, comments });
});

router.put('/tasks/:id', loadTask, (req, res) => {
  const v = validateFields(req.body, req.task.project_id);
  if (v.error) return res.status(400).json(v);
  const fields = Object.keys(v);
  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  // Moving to another column without a position puts the card at the bottom
  if (v.status && v.status !== req.task.status && !('position' in v)) {
    v.position = nextPosition(req.task.project_id, v.status);
    fields.push('position');
  }

  db.prepare(`UPDATE tasks SET ${fields.map((f) => `${f} = @${f}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...v, id: req.task.id });
  const task = getTask(req.task.id);
  const before = req.task;
  const opts = { projectId: task.project_id, taskId: task.id };

  if (task.assignee_id && task.assignee_id !== before.assignee_id) {
    rt.notify(task.assignee_id, req.user.id, `${req.user.name} assigned you "${task.title}" in ${task.project_name}`, opts);
  }
  let message = `${req.user.name} updated "${task.title}"`;
  if (task.status !== before.status) {
    message = `${req.user.name} moved "${task.title}" to ${STATUS_LABEL[task.status]}`;
    if (task.status === 'done') {
      rt.notify(task.created_by, req.user.id, `${req.user.name} completed "${task.title}"`, opts);
    }
    if (task.assignee_id === before.assignee_id) {
      rt.notify(task.assignee_id, req.user.id, `${message} (${task.project_name})`, opts);
    }
  }
  // Pure reordering inside a column is not worth a toast for other viewers
  const quiet = fields.every((f) => f === 'position');
  rt.boardChanged(task.project_id, req.user, quiet ? null : message, { taskId: task.id });
  res.json(task);
});

// The task's creator or the project owner can delete a task.
router.delete('/tasks/:id', loadTask, (req, res) => {
  const role = getMembership(req.task.project_id, req.user.id).role;
  if (req.task.created_by !== req.user.id && role !== 'owner') {
    return res.status(403).json({ error: 'Only the task creator or project owner can delete this task' });
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.task.id);
  rt.boardChanged(req.task.project_id, req.user, `${req.user.name} deleted "${req.task.title}"`, { taskId: req.task.id, deleted: true });
  res.json({ deleted: true });
});

router.post('/tasks/:id/comments', loadTask, (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Comment cannot be empty' });
  if (content.length > 1000) return res.status(400).json({ error: 'Comments are limited to 1000 characters' });

  const { lastInsertRowid } = db
    .prepare('INSERT INTO task_comments (task_id, user_id, content) VALUES (?, ?, ?)')
    .run(req.task.id, req.user.id, content);
  const comment = db.prepare(`
    SELECT c.*, u.name, u.avatar_color FROM task_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`).get(lastInsertRowid);

  const t = req.task;
  new Set([t.assignee_id, t.created_by]).forEach((uid) =>
    rt.notify(uid, req.user.id, `${req.user.name} commented on "${t.title}": ${content.slice(0, 60)}`,
      { projectId: t.project_id, taskId: t.id }));
  rt.emitToProject(t.project_id, 'task:comment', { taskId: t.id, comment });
  rt.boardChanged(t.project_id, req.user, null, { taskId: t.id });
  res.status(201).json(comment);
});

module.exports = router;
