// Shared helpers used by every page: API calls, auth state, header with live notifications,
// and the Socket.io connection.

const Auth = {
  get token() { return localStorage.getItem('token'); },
  get user() { return JSON.parse(localStorage.getItem('user') || 'null'); },
  save({ token, user }) {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  },
  logout() {
    Auth.clear();
    location.href = '/login.html';
  },
  requireLogin() {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
  },
};

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (Auth.token) headers.Authorization = `Bearer ${Auth.token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && headers.Authorization) {
    // Token expired or invalid
    Auth.clear();
    Auth.requireLogin();
  }
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// SQLite stores UTC as "YYYY-MM-DD HH:MM:SS"
const parseDate = (s) => new Date(s.replace(' ', 'T') + 'Z');

function timeAgo(s) {
  const secs = Math.floor((Date.now() - parseDate(s)) / 1000);
  if (secs < 60) return 'just now';
  const units = [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]];
  for (const [label, size] of units) if (secs >= size) return `${Math.floor(secs / size)}${label} ago`;
}

function initials(name) {
  return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

function avatar(user, size = 28, extraClass = '') {
  return `<span class="avatar ${extraClass}" title="${escapeHtml(user.name)}"
    style="background:${user.avatar_color};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px">${escapeHtml(initials(user.name))}</span>`;
}

function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ---- Socket.io ----
let socket = null;
function connectSocket() {
  if (!Auth.token || typeof io === 'undefined') return null;
  socket = io({ auth: { token: Auth.token } });
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') Auth.logout();
  });
  socket.on('notification', (n) => {
    Notifications.items.unshift(n);
    Notifications.unread += 1;
    Notifications.render();
    toast(`🔔 ${n.message}`);
  });
  return socket;
}

// ---- Notifications dropdown ----
const Notifications = {
  items: [],
  unread: 0,
  async load() {
    const data = await api('/notifications');
    this.items = data.items;
    this.unread = data.unread;
    this.render();
  },
  link(n) {
    if (n.project_id && n.task_id) return `/project.html?id=${n.project_id}&task=${n.task_id}`;
    if (n.project_id) return `/project.html?id=${n.project_id}`;
    return '/';
  },
  render() {
    const badge = document.getElementById('notif-count');
    const list = document.getElementById('notif-list');
    if (!badge) return;
    badge.textContent = this.unread > 9 ? '9+' : this.unread;
    badge.hidden = this.unread === 0;
    list.innerHTML = this.items.length
      ? this.items.map((n) => `
          <a href="${this.link(n)}" class="notif ${n.is_read ? '' : 'unread'}" data-notif="${n.id}">
            <div>${escapeHtml(n.message)}</div>
            <div class="muted small">${timeAgo(n.created_at)}</div>
          </a>`).join('')
      : '<div class="notif-empty">No notifications yet</div>';
  },
  async markAllRead() {
    await api('/notifications/read-all', { method: 'POST' });
    this.items.forEach((n) => (n.is_read = 1));
    this.unread = 0;
    this.render();
  },
};

function renderHeader() {
  const header = document.getElementById('site-header');
  if (!header) return;
  const user = Auth.user;
  header.innerHTML = `
    <div class="nav">
      <a href="/" class="logo"><span class="logo-mark">▦</span> TaskFlow</a>
      <nav class="nav-links">
        ${user ? `
          <a href="/">Projects</a>
          <div class="notif-wrap">
            <button class="icon-btn bell" id="bell" aria-label="Notifications">🔔<span id="notif-count" class="badge" hidden>0</span></button>
            <div class="dropdown" id="notif-dropdown" hidden>
              <div class="dropdown-head"><strong>Notifications</strong><button class="link-btn small" id="mark-read">Mark all read</button></div>
              <div id="notif-list"></div>
            </div>
          </div>
          <span class="nav-user">${avatar(user, 30)}<span>${escapeHtml(user.name)}</span></span>
          <button class="link-btn" id="logout-btn">Logout</button>`
        : `<a href="/login.html">Login</a><a href="/register.html" class="btn btn-sm">Sign up</a>`}
      </nav>
    </div>`;
  if (!user) return;

  document.getElementById('logout-btn').addEventListener('click', Auth.logout);
  const dropdown = document.getElementById('notif-dropdown');
  document.getElementById('bell').addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });
  document.getElementById('mark-read').addEventListener('click', (e) => {
    e.stopPropagation();
    Notifications.markAllRead();
  });
  dropdown.addEventListener('click', (e) => {
    const a = e.target.closest('[data-notif]');
    if (a) api(`/notifications/${a.dataset.notif}/read`, { method: 'POST' }).catch(() => {});
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.notif-wrap')) dropdown.hidden = true;
  });
  Notifications.load().catch(() => {});
}

// Pages that need a logged-in user call this first.
function requireUser() {
  if (!Auth.token) {
    Auth.requireLogin();
    return false;
  }
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  const toasts = document.createElement('div');
  toasts.id = 'toasts';
  document.body.appendChild(toasts);
  renderHeader();
});
