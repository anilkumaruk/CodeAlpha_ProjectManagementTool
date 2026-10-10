// Socket.io setup: each socket joins a personal room (user:<id>) for notifications, and the
// room of the project board it is viewing (project:<id>) for live board updates and presence.
const { Server } = require('socket.io');
const { db } = require('./db');
const { verifyToken } = require('./auth');

let io;

const isMember = (projectId, userId) =>
  Boolean(db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId));

async function broadcastPresence(projectId) {
  const sockets = await io.in(`project:${projectId}`).fetchSockets();
  const online = [...new Set(sockets.map((s) => s.data.user.id))];
  io.to(`project:${projectId}`).emit('presence', { projectId, online });
}

function init(server) {
  io = new Server(server);

  io.use((socket, next) => {
    const user = verifyToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const { user } = socket.data;
    socket.join(`user:${user.id}`);

    socket.on('project:join', (projectId, ack) => {
      projectId = Number(projectId);
      if (!isMember(projectId, user.id)) return ack?.({ ok: false });
      for (const room of socket.rooms) {
        if (room.startsWith('project:')) {
          socket.leave(room);
          broadcastPresence(room.slice(8));
        }
      }
      socket.join(`project:${projectId}`);
      broadcastPresence(projectId);
      ack?.({ ok: true });
    });

    socket.on('disconnecting', () => {
      const rooms = [...socket.rooms].filter((r) => r.startsWith('project:'));
      setImmediate(() => rooms.forEach((r) => broadcastPresence(r.slice(8))));
    });
  });
}

// Tell everyone viewing a board that it changed. `actor` is the user who made the change.
function boardChanged(projectId, actor, message, extra = {}) {
  io?.to(`project:${projectId}`).emit('board:changed', { projectId, actorId: actor.id, message, ...extra });
}

function emitToProject(projectId, event, data) {
  io?.to(`project:${projectId}`).emit(event, data);
}

function emitToUser(userId, event, data) {
  io?.to(`user:${userId}`).emit(event, data);
}

// Save a notification and push it live to the user.
function notify(userId, actorId, message, { projectId = null, taskId = null } = {}) {
  if (!userId || userId === actorId) return;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO notifications (user_id, message, project_id, task_id) VALUES (?, ?, ?, ?)')
    .run(userId, message, projectId, taskId);
  emitToUser(userId, 'notification', db.prepare('SELECT * FROM notifications WHERE id = ?').get(lastInsertRowid));
}

// Remove a user's sockets from a project room (e.g. after they are removed from the project).
async function kickFromProject(projectId, userId) {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  sockets.forEach((s) => s.leave(`project:${projectId}`));
  broadcastPresence(projectId);
}

module.exports = { init, boardChanged, emitToProject, emitToUser, notify, kickFromProject };
