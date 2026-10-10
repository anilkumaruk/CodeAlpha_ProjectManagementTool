const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const rt = require('../realtime');

const router = express.Router();
router.use(requireAuth);

const getMembership = (projectId, userId) =>
  db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId);

// Loads req.project and req.role, or 404s when the user is not a member (so projects stay private).
function loadProject(req, res, next) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  const membership = project && getMembership(project.id, req.user.id);
  if (!membership) return res.status(404).json({ error: 'Project not found' });
  req.project = project;
  req.role = membership.role;
  next();
}

function ownerOnly(req, res, next) {
  if (req.role !== 'owner') return res.status(403).json({ error: 'Only the project owner can do that' });
  next();
}

function validateProject(body) {
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  if (!name || name.length > 60) return { error: 'Project name is required (max 60 characters)' };
  if (description.length > 300) return { error: 'Description must be 300 characters or less' };
  return { name, description };
}

router.get('/', (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, pm.role,
      (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) AS member_count,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) AS task_count,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status = 'done') AS done_count,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND assignee_id = @me AND status != 'done') AS my_open_count
    FROM projects p JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = @me
    ORDER BY p.created_at DESC, p.id DESC`).all({ me: req.user.id }));
});

router.post('/', (req, res) => {
  const v = validateProject(req.body);
  if (v.error) return res.status(400).json(v);
  const id = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO projects (name, description, owner_id) VALUES (?, ?, ?)')
      .run(v.name, v.description, req.user.id);
    db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')").run(lastInsertRowid, req.user.id);
    return lastInsertRowid;
  })();
  res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
});

// Full board: project info, members and all tasks.
router.get('/:id', loadProject, (req, res) => {
  const members = db.prepare(`
    SELECT u.id, u.name, u.email, u.avatar_color, pm.role FROM project_members pm
    JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY pm.role DESC, pm.joined_at`).all(req.project.id);
  const tasks = db.prepare(`
    SELECT t.*, u.name AS assignee_name, u.avatar_color AS assignee_color,
      (SELECT COUNT(*) FROM task_comments WHERE task_id = t.id) AS comment_count
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.project_id = ? ORDER BY t.position, t.id`).all(req.project.id);
  res.json({ ...req.project, role: req.role, members, tasks });
});

router.put('/:id', loadProject, ownerOnly, (req, res) => {
  const v = validateProject(req.body);
  if (v.error) return res.status(400).json(v);
  db.prepare('UPDATE projects SET name = ?, description = ? WHERE id = ?').run(v.name, v.description, req.project.id);
  rt.boardChanged(req.project.id, req.user, `${req.user.name} updated the project details`);
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.project.id));
});

router.delete('/:id', loadProject, ownerOnly, (req, res) => {
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.project.id);
  rt.emitToProject(req.project.id, 'project:deleted', { projectId: req.project.id, actorId: req.user.id });
  res.json({ deleted: true });
});

// Add a member by email.
router.post('/:id/members', loadProject, ownerOnly, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT id, name, email, avatar_color FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: 'No user found with that email. Ask them to sign up first.' });
  if (getMembership(req.project.id, user.id)) return res.status(409).json({ error: `${user.name} is already a member` });

  db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'member')").run(req.project.id, user.id);
  rt.notify(user.id, req.user.id, `${req.user.name} added you to the project "${req.project.name}"`, { projectId: req.project.id });
  rt.boardChanged(req.project.id, req.user, `${req.user.name} added ${user.name} to the project`);
  res.status(201).json({ ...user, role: 'member' });
});

// The owner can remove anyone except themselves; members can remove themselves (leave).
router.delete('/:id/members/:userId', loadProject, (req, res) => {
  const userId = Number(req.params.userId);
  const target = getMembership(req.project.id, userId);
  if (!target) return res.status(404).json({ error: 'Member not found' });
  if (target.role === 'owner') return res.status(400).json({ error: 'The owner cannot be removed from the project' });
  if (req.role !== 'owner' && userId !== req.user.id) {
    return res.status(403).json({ error: 'Only the project owner can remove members' });
  }

  db.transaction(() => {
    db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(req.project.id, userId);
    db.prepare('UPDATE tasks SET assignee_id = NULL WHERE project_id = ? AND assignee_id = ?').run(req.project.id, userId);
  })();

  const name = db.prepare('SELECT name FROM users WHERE id = ?').get(userId).name;
  if (userId !== req.user.id) {
    rt.notify(userId, req.user.id, `${req.user.name} removed you from the project "${req.project.name}"`);
  }
  rt.emitToUser(userId, 'project:removed', { projectId: req.project.id });
  rt.kickFromProject(req.project.id, userId);
  rt.boardChanged(req.project.id, req.user,
    userId === req.user.id ? `${name} left the project` : `${req.user.name} removed ${name} from the project`);
  res.json({ removed: true });
});

module.exports = { router, getMembership };
