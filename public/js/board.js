// Kanban board page: columns, drag & drop, task details modal with comments, members,
// project settings, and live updates over Socket.io.

const COLUMNS = [
  { status: 'todo', title: 'To Do' },
  { status: 'in_progress', title: 'In Progress' },
  { status: 'done', title: 'Done' },
];
const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

const params = new URLSearchParams(location.search);
const projectId = Number(params.get('id'));
const me = Auth.user;

let project = null; // { ...project, role, members, tasks }
let online = [];
let openTaskId = null; // task shown in the modal
let dragId = null;

const $ = (id) => document.getElementById(id);
const boardEl = $('board');
const modalEl = $('modal');

const member = (id) => project.members.find((m) => m.id === id);
const isOwner = () => project.role === 'owner';

// ---------- Loading ----------

async function loadProject() {
  try {
    project = await api(`/projects/${projectId}`);
  } catch (err) {
    boardEl.innerHTML = `<div class="panel empty" style="grid-column:1/-1"><div class="big">🔒</div>${escapeHtml(err.message)}<br><br><a class="btn" href="/">Back to projects</a></div>`;
    return false;
  }
  document.title = `${project.name} — TaskFlow`;
  $('board-head').hidden = false;
  $('toolbar').hidden = false;
  $('project-name').textContent = project.name;
  $('project-desc').textContent = project.description;
  $('settings-btn').hidden = !isOwner();
  renderMembers();
  renderAssigneeFilter();
  renderCards();
  return true;
}

// ---------- Header ----------

function renderMembers() {
  const sorted = [...project.members].sort((a, b) => online.includes(b.id) - online.includes(a.id));
  $('member-avatars').innerHTML = sorted.slice(0, 6)
    .map((m) => avatar(m, 32, online.includes(m.id) ? 'online' : '')).join('');
  $('live-text').textContent = online.length > 1 ? `${online.length} online` : 'Live';
}

function renderAssigneeFilter() {
  const select = $('filter-assignee');
  const current = select.value;
  select.innerHTML = `
    <option value="">Everyone</option>
    <option value="me">Assigned to me</option>
    <option value="none">Unassigned</option>
    ${project.members.filter((m) => m.id !== me.id).map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')}`;
  select.value = [...select.options].some((o) => o.value === current) ? current : '';
}

// ---------- Board ----------

function buildColumns() {
  boardEl.innerHTML = COLUMNS.map((c) => `
    <section class="column" data-status="${c.status}">
      <div class="column-head">
        <h2><span class="dot dot-${c.status}"></span>${c.title} <span class="count" data-count="${c.status}">0</span></h2>
      </div>
      <div class="cards" data-cards="${c.status}"></div>
      <div class="add-task" data-add="${c.status}">
        <button class="add-task-btn">+ Add a task</button>
      </div>
    </section>`).join('');
}

function visibleTasks(status) {
  const text = $('filter-text').value.trim().toLowerCase();
  const assignee = $('filter-assignee').value;
  const priority = $('filter-priority').value;
  return project.tasks
    .filter((t) => t.status === status)
    .filter((t) => !text || t.title.toLowerCase().includes(text) || t.description.toLowerCase().includes(text))
    .filter((t) => !priority || t.priority === priority)
    .filter((t) => {
      if (!assignee) return true;
      if (assignee === 'me') return t.assignee_id === me.id;
      if (assignee === 'none') return !t.assignee_id;
      return t.assignee_id === Number(assignee);
    })
    .sort((a, b) => a.position - b.position || a.id - b.id);
}

function dueLabel(t) {
  if (!t.due_date) return '';
  const due = new Date(t.due_date + 'T23:59:59');
  const overdue = t.status !== 'done' && due < new Date();
  const label = new Date(t.due_date + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `<span class="due ${overdue ? 'overdue' : ''}" title="${overdue ? 'Overdue' : 'Due date'}">📅 ${label}</span>`;
}

function renderCard(t) {
  const a = t.assignee_id && { name: t.assignee_name, avatar_color: t.assignee_color };
  return `
    <div class="task-card ${t.status}" draggable="true" data-task="${t.id}">
      <div class="task-title">${escapeHtml(t.title)}</div>
      <div class="task-meta">
        <span class="prio prio-${t.priority}">${PRIORITY_LABEL[t.priority]}</span>
        ${dueLabel(t)}
        ${t.comment_count ? `<span title="Comments">💬 ${t.comment_count}</span>` : ''}
        ${t.description ? '<span title="Has description">≡</span>' : ''}
        <span class="spacer"></span>
        ${a ? avatar(a, 24) : '<span class="unassigned" title="Unassigned"></span>'}
      </div>
    </div>`;
}

function renderCards() {
  for (const { status } of COLUMNS) {
    const tasks = visibleTasks(status);
    document.querySelector(`[data-cards="${status}"]`).innerHTML = tasks.map(renderCard).join('');
    document.querySelector(`[data-count="${status}"]`).textContent = project.tasks.filter((t) => t.status === status).length;
  }
}

function flashCard(taskId) {
  const el = document.querySelector(`[data-task="${taskId}"]`);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
}

// ---------- Add task (inline form at the bottom of each column) ----------

boardEl.addEventListener('click', (e) => {
  const addBtn = e.target.closest('.add-task-btn');
  if (addBtn) {
    const wrap = addBtn.parentElement;
    wrap.innerHTML = `
      <form>
        <textarea placeholder="Task title..." maxlength="120" required></textarea>
        <div class="row">
          <button class="btn btn-sm" type="submit">Add task</button>
          <button class="btn btn-sm btn-outline" type="button" data-cancel>Cancel</button>
        </div>
      </form>`;
    wrap.querySelector('textarea').focus();
    return;
  }
  if (e.target.closest('[data-cancel]')) {
    e.target.closest('.add-task').innerHTML = '<button class="add-task-btn">+ Add a task</button>';
    return;
  }
  const card = e.target.closest('[data-task]');
  if (card) openTask(Number(card.dataset.task));
});

boardEl.addEventListener('keydown', (e) => {
  // Enter submits the add-task form, Shift+Enter makes a new line, Escape cancels
  if (!e.target.matches('.add-task textarea')) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.target.form.requestSubmit();
  } else if (e.key === 'Escape') {
    e.target.closest('.add-task').querySelector('[data-cancel]').click();
  }
});

boardEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const status = form.closest('[data-add]').dataset.add;
  const textarea = form.querySelector('textarea');
  const title = textarea.value.trim();
  if (!title) return;
  form.querySelector('button[type=submit]').disabled = true;
  try {
    const task = await api(`/projects/${projectId}/tasks`, { method: 'POST', body: { title, status } });
    project.tasks.push(task);
    renderCards();
    flashCard(task.id);
    textarea.value = '';
    textarea.focus();
  } catch (err) {
    toast(err.message, 'error');
  }
  form.querySelector('button[type=submit]').disabled = false;
});

// ---------- Drag & drop ----------

boardEl.addEventListener('dragstart', (e) => {
  const card = e.target.closest('[data-task]');
  if (!card) return;
  dragId = Number(card.dataset.task);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragId));
  requestAnimationFrame(() => card.classList.add('dragging'));
});

boardEl.addEventListener('dragend', (e) => {
  e.target.closest('[data-task]')?.classList.remove('dragging');
  document.querySelectorAll('.column.drag-over').forEach((c) => c.classList.remove('drag-over'));
  dragId = null;
});

// The card the dragged card should be placed before, based on the mouse position.
function cardAfter(container, y) {
  const cards = [...container.querySelectorAll('[data-task]:not(.dragging)')];
  return cards.find((c) => {
    const box = c.getBoundingClientRect();
    return y < box.top + box.height / 2;
  }) || null;
}

boardEl.addEventListener('dragover', (e) => {
  const column = e.target.closest('.column');
  if (!column || dragId === null) return;
  e.preventDefault();
  document.querySelectorAll('.column.drag-over').forEach((c) => c !== column && c.classList.remove('drag-over'));
  column.classList.add('drag-over');
  const cards = column.querySelector('.cards');
  const dragging = document.querySelector('.task-card.dragging');
  if (!dragging) return;
  const after = cardAfter(cards, e.clientY);
  if (after) cards.insertBefore(dragging, after);
  else cards.appendChild(dragging);
});

boardEl.addEventListener('drop', async (e) => {
  const column = e.target.closest('.column');
  if (!column || dragId === null) return;
  e.preventDefault();
  column.classList.remove('drag-over');

  const card = document.querySelector(`[data-task="${dragId}"]`);
  const task = project.tasks.find((t) => t.id === dragId);
  const status = column.dataset.status;
  const posOf = (el) => el && project.tasks.find((t) => t.id === Number(el.dataset.task))?.position;
  const prev = posOf(card.previousElementSibling);
  const next = posOf(card.nextElementSibling);
  const position = prev !== undefined && next !== undefined ? (prev + next) / 2
    : prev !== undefined ? prev + 1
    : next !== undefined ? next - 1
    : 1;

  if (task.status === status && task.position === position) return;
  const before = { status: task.status, position: task.position };
  Object.assign(task, { status, position }); // optimistic update
  renderCards();
  try {
    Object.assign(task, await api(`/tasks/${task.id}`, { method: 'PUT', body: { status, position } }));
    renderCards();
  } catch (err) {
    Object.assign(task, before);
    renderCards();
    toast(err.message, 'error');
  }
});

// ---------- Modals ----------

function showModal(html, wide = false) {
  modalEl.innerHTML = `<div class="modal ${wide ? 'modal-wide' : ''}"><button class="modal-close" data-close aria-label="Close">&times;</button>${html}</div>`;
  modalEl.hidden = false;
}

function closeModal() {
  modalEl.hidden = true;
  modalEl.innerHTML = '';
  if (openTaskId) {
    openTaskId = null;
    history.replaceState(null, '', `?id=${projectId}`);
  }
}

modalEl.addEventListener('mousedown', (e) => {
  if (e.target === modalEl) closeModal();
});
modalEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalEl.hidden) closeModal();
});

// ---------- Task details modal ----------

function renderComment(c, isNew = false) {
  return `
    <div class="comment ${isNew ? 'new' : ''}" data-comment="${c.id}">
      ${avatar(c, 30)}
      <div class="comment-body">
        <div class="who">${escapeHtml(c.name)} <span class="muted small" title="${parseDate(c.created_at).toLocaleString()}">· ${timeAgo(c.created_at)}</span></div>
        <div class="text">${escapeHtml(c.content)}</div>
      </div>
    </div>`;
}

async function openTask(taskId) {
  let task;
  try {
    task = await api(`/tasks/${taskId}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  openTaskId = taskId;
  history.replaceState(null, '', `?id=${projectId}&task=${taskId}`);
  const canDelete = task.created_by === me.id || isOwner();

  showModal(`
    <div class="task-layout">
      <div>
        <input class="title-input" id="t-title" maxlength="120" value="${escapeHtml(task.title)}" aria-label="Task title">
        <label for="t-desc">Description</label>
        <textarea id="t-desc" rows="5" maxlength="2000" placeholder="Add more details...">${escapeHtml(task.description)}</textarea>

        <h3 class="section-title">💬 Comments</h3>
        <div class="comments" id="t-comments">
          ${task.comments.length ? task.comments.map((c) => renderComment(c)).join('') : '<p class="muted small" id="no-comments">No comments yet. Start the discussion!</p>'}
        </div>
        <form class="comment-form" id="t-comment-form">
          ${avatar(me, 30)}
          <textarea id="t-comment" rows="1" maxlength="1000" placeholder="Write a comment... (Enter to send)"></textarea>
          <button class="btn btn-sm" type="submit">Send</button>
        </form>
      </div>
      <aside class="task-side">
        <label for="t-status">Status</label>
        <select id="t-status">${COLUMNS.map((c) => `<option value="${c.status}">${c.title}</option>`).join('')}</select>
        <label for="t-assignee">Assignee</label>
        <select id="t-assignee">
          <option value="">Unassigned</option>
          ${project.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}${m.id === me.id ? ' (me)' : ''}</option>`).join('')}
        </select>
        <label for="t-priority">Priority</label>
        <select id="t-priority">${Object.entries(PRIORITY_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <label for="t-due">Due date</label>
        <input type="date" id="t-due">
        <div class="meta-line">Created by ${escapeHtml(task.creator_name)}</div>
        <div class="meta-line" id="t-updated"></div>
        ${canDelete ? '<button class="btn btn-danger btn-sm btn-block" id="t-delete" style="margin-top:14px">🗑 Delete task</button>' : ''}
      </aside>
    </div>`, true);

  fillTaskFields(task);
  const comments = $('t-comments');
  comments.scrollTop = comments.scrollHeight;

  const save = async (fields) => {
    try {
      const updated = await api(`/tasks/${taskId}`, { method: 'PUT', body: fields });
      replaceTask(updated);
      fillTaskFields(updated);
    } catch (err) {
      toast(err.message, 'error');
      openTask(taskId);
    }
  };

  const title = $('t-title');
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); });
  title.addEventListener('blur', () => {
    const value = title.value.trim();
    if (!value) title.value = currentTask().title;
    else if (value !== currentTask().title) save({ title: value });
  });
  $('t-desc').addEventListener('blur', (e) => {
    if (e.target.value.trim() !== currentTask().description) save({ description: e.target.value });
  });
  $('t-status').addEventListener('change', (e) => save({ status: e.target.value }));
  $('t-assignee').addEventListener('change', (e) => save({ assignee_id: e.target.value ? Number(e.target.value) : null }));
  $('t-priority').addEventListener('change', (e) => save({ priority: e.target.value }));
  $('t-due').addEventListener('change', (e) => save({ due_date: e.target.value || null }));

  const commentInput = $('t-comment');
  commentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('t-comment-form').requestSubmit();
    }
  });
  $('t-comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = commentInput.value.trim();
    if (!content) return;
    commentInput.value = '';
    try {
      const comment = await api(`/tasks/${taskId}/comments`, { method: 'POST', body: { content } });
      appendComment(comment);
    } catch (err) {
      commentInput.value = content;
      toast(err.message, 'error');
    }
  });

  $('t-delete')?.addEventListener('click', async () => {
    if (!confirm(`Delete "${currentTask().title}"? This cannot be undone.`)) return;
    try {
      await api(`/tasks/${taskId}`, { method: 'DELETE' });
      project.tasks = project.tasks.filter((t) => t.id !== taskId);
      renderCards();
      closeModal();
      toast('Task deleted');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

const currentTask = () => project.tasks.find((t) => t.id === openTaskId) || {};

// Fill the modal's fields, skipping whichever one the user is typing in.
function fillTaskFields(task) {
  const set = (id, value) => {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = value ?? '';
  };
  set('t-title', task.title);
  set('t-desc', task.description);
  set('t-status', task.status);
  set('t-assignee', task.assignee_id || '');
  set('t-priority', task.priority);
  set('t-due', task.due_date);
  const updated = $('t-updated');
  if (updated) updated.textContent = `Updated ${timeAgo(task.updated_at)}`;
}

function replaceTask(task) {
  const i = project.tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) project.tasks[i] = { ...project.tasks[i], ...task };
  else project.tasks.push(task);
  renderCards();
}

function appendComment(comment) {
  const list = $('t-comments');
  if (!list || list.querySelector(`[data-comment="${comment.id}"]`)) return;
  $('no-comments')?.remove();
  list.insertAdjacentHTML('beforeend', renderComment(comment, true));
  list.scrollTop = list.scrollHeight;
}

// ---------- Members modal ----------

function openMembers() {
  showModal(`
    <h2>Project members</h2>
    ${isOwner() ? `
      <form class="invite-form" id="invite-form">
        <input type="email" id="invite-email" placeholder="Add member by email" required>
        <button class="btn" type="submit">Add</button>
      </form>
      <div class="form-error" id="invite-error"></div>` : ''}
    <div id="member-list">
      ${project.members.map((m) => `
        <div class="member-row">
          ${avatar(m, 36, online.includes(m.id) ? 'online' : '')}
          <div class="info">
            <div><strong>${escapeHtml(m.name)}</strong>${m.id === me.id ? ' <span class="muted">(you)</span>' : ''}</div>
            <div class="email">${escapeHtml(m.email)}</div>
          </div>
          <span class="role-tag">${m.role}</span>
          ${m.role !== 'owner' && isOwner() ? `<button class="btn btn-sm btn-danger" data-remove="${m.id}">Remove</button>` : ''}
          ${m.role !== 'owner' && !isOwner() && m.id === me.id ? `<button class="btn btn-sm btn-danger" data-remove="${m.id}">Leave</button>` : ''}
        </div>`).join('')}
    </div>`);

  $('invite-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const added = await api(`/projects/${projectId}/members`, { method: 'POST', body: { email: $('invite-email').value } });
      toast(`${added.name} added to the project`);
      await loadProject();
      openMembers();
    } catch (err) {
      $('invite-error').textContent = err.message;
    }
  });

  $('member-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    const userId = Number(btn.dataset.remove);
    const leaving = userId === me.id;
    if (!confirm(leaving ? 'Leave this project?' : `Remove ${member(userId).name} from the project? Their tasks will become unassigned.`)) return;
    try {
      await api(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' });
      if (leaving) return (location.href = '/');
      await loadProject();
      openMembers();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------- Settings modal (owner only) ----------

function openSettings() {
  showModal(`
    <h2>Project settings</h2>
    <form id="settings-form">
      <label for="s-name">Project name</label>
      <input id="s-name" maxlength="60" required value="${escapeHtml(project.name)}">
      <label for="s-desc">Description</label>
      <textarea id="s-desc" rows="3" maxlength="300">${escapeHtml(project.description)}</textarea>
      <div class="form-error" id="s-error"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-danger" id="s-delete" style="margin-right:auto">Delete project</button>
        <button type="button" class="btn btn-outline" data-close>Cancel</button>
        <button class="btn" type="submit">Save</button>
      </div>
    </form>`);

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/projects/${projectId}`, { method: 'PUT', body: { name: $('s-name').value, description: $('s-desc').value } });
      closeModal();
      await loadProject();
      toast('Project updated');
    } catch (err) {
      $('s-error').textContent = err.message;
    }
  });
  $('s-delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${project.name}" and all its tasks? This cannot be undone.`)) return;
    await api(`/projects/${projectId}`, { method: 'DELETE' });
    location.href = '/';
  });
}

// ---------- Real-time ----------

function setupSocket() {
  const s = connectSocket();
  if (!s) return;
  const live = $('live');

  const join = () => s.emit('project:join', projectId, (res) => {
    if (!res?.ok) return;
    live.classList.add('on');
    loadProject(); // catch up on anything missed while disconnected
  });
  s.on('connect', join);
  s.on('disconnect', () => {
    live.classList.remove('on');
    $('live-text').textContent = 'Reconnecting...';
  });

  s.on('presence', (data) => {
    if (data.projectId !== projectId || !project) return;
    online = data.online;
    renderMembers();
  });

  s.on('board:changed', async (data) => {
    if (data.projectId !== projectId || data.actorId === me.id) return;
    if (data.message) toast(data.message, 'info');
    await loadProject();
    if (data.taskId) flashCard(data.taskId);
    if (openTaskId && data.taskId === openTaskId) {
      const task = project.tasks.find((t) => t.id === openTaskId);
      if (!task) {
        closeModal();
        toast('This task was deleted by another member', 'error');
      } else {
        fillTaskFields(task);
      }
    }
  });

  s.on('task:comment', ({ taskId, comment }) => {
    if (taskId === openTaskId) appendComment(comment);
  });

  s.on('project:deleted', (data) => {
    if (data.projectId !== projectId || data.actorId === me.id) return;
    alert('This project was deleted by its owner.');
    location.href = '/';
  });

  s.on('project:removed', (data) => {
    if (data.projectId !== projectId) return;
    alert('You are no longer a member of this project.');
    location.href = '/';
  });
}

// ---------- Init ----------

if (requireUser()) {
  if (!projectId) location.href = '/';
  buildColumns();
  $('members-btn').addEventListener('click', openMembers);
  $('settings-btn').addEventListener('click', openSettings);
  ['filter-text', 'filter-assignee', 'filter-priority'].forEach((id) =>
    $(id).addEventListener(id === 'filter-text' ? 'input' : 'change', () => project && renderCards()));

  loadProject().then((ok) => {
    if (!ok) return;
    setupSocket();
    const taskParam = Number(params.get('task'));
    if (taskParam) openTask(taskParam);
  });
}
