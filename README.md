# TaskFlow — Collaborative Project Management Tool

CodeAlpha Full Stack Development Internship, **Task 3**.

A Trello-style tool where teams create group projects, manage tasks on a Kanban board, assign work and discuss tasks in comments. Changes show up **live** for everyone on the board, and users get **real-time notifications** (WebSockets via Socket.io).

## Tech stack

- **Frontend:** HTML, CSS, vanilla JavaScript
- **Backend:** Node.js + Express.js (REST API)
- **Real-time:** Socket.io (WebSockets)
- **Database:** SQLite (via `better-sqlite3`)
- **Auth:** bcrypt password hashing + JWT (used for both the REST API and the socket connection)

## Features

- **Auth:** register, log in, log out
- **Group projects:** create projects, see progress on the dashboard, and edit or delete them (owner only)
- **Team members:** the owner adds members by email and can remove them; members can leave. Removed members' tasks become unassigned.
- **Kanban board:** To Do / In Progress / Done columns, with **drag and drop** between and within columns
- **Task cards:** title, description, priority (low/medium/high), assignee, due date (overdue dates turn red) and a comment count
- **Assign tasks** to any project member
- **Comments** on every task, so the team can discuss it there
- **Filters:** search, "assigned to me", unassigned, by member, and by priority
- **Real-time updates (bonus):**
  - New, moved, edited and deleted tasks appear instantly for everyone viewing the board
  - New comments appear live in an open task popup
  - Online members are shown with a green dot
  - The board catches up automatically after a reconnect
- **Notifications (bonus):** a bell with an unread count, pushed live when someone:
  - assigns you a task
  - adds you to a project or removes you from it
  - comments on a task you created or are assigned to
  - completes a task you created
  - moves a task assigned to you
- **Permissions:**
  - Only members can see a project
  - Only the owner can manage members and settings
  - Only a task's creator or the project owner can delete it

## Getting started

```bash
npm install
npm start
```

Open http://localhost:3000. The database (`taskflow.db`) is created on first run with a demo project, "Website Redesign".

**Demo accounts** (password `password123` for all): `anil@demo.com` (owner), `meera@demo.com`, `kiran@demo.com`.

**To see the real-time features:** log in as Anil in one browser and as Meera in another (or in a private window). Open the same board in both. Move a task or add a comment in one window and watch the other update.

## Project structure

```
server.js             Express + HTTP server setup
realtime.js           Socket.io: auth, project rooms, presence, notifications
db.js                 SQLite schema + demo data
auth.js               JWT helpers and auth middleware
routes/
  auth.js             /api/auth           register, login, me
  projects.js         /api/projects       projects and members
  tasks.js            /api/.../tasks      tasks and comments
  notifications.js    /api/notifications  list, mark read
public/
  index.html          Projects dashboard
  project.html        Kanban board
  login.html, register.html
  js/common.js        API client, auth, header, notifications, socket
  js/board.js         Board, drag and drop, task popup, members, live updates
  css/style.css
```

## Database schema

| Table | Purpose |
|---|---|
| `users` | Accounts |
| `projects` | Projects (with an owner) |
| `project_members` | Which users belong to which project (role: owner/member) |
| `tasks` | Task cards: status, priority, assignee, due date, position |
| `task_comments` | Comments on tasks |
| `notifications` | Per-user notifications (read/unread) |

## REST API

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/register` · `/api/auth/login` | Create an account / log in |
| GET | `/api/projects` | My projects with progress counts |
| POST | `/api/projects` | Create a project |
| GET | `/api/projects/:id` | Board: project, members, tasks |
| PUT / DELETE | `/api/projects/:id` | Edit / delete a project (owner) |
| POST | `/api/projects/:id/members` | Add a member by email (owner) |
| DELETE | `/api/projects/:id/members/:userId` | Remove a member (owner), or leave the project |
| POST | `/api/projects/:id/tasks` | Create a task |
| GET / PUT / DELETE | `/api/tasks/:id` | Task details with comments / update / delete |
| POST | `/api/tasks/:id/comments` | Add a comment |
| GET | `/api/notifications` | Latest notifications + unread count |
| POST | `/api/notifications/read-all` · `/:id/read` | Mark notifications as read |

All endpoints except register and login need an `Authorization: Bearer <token>` header.

## Socket.io events

| Direction | Event | Description |
|---|---|---|
| client → server | `project:join` | Start receiving live updates for a board (members only) |
| server → client | `board:changed` | A task or the project changed, so reload the board |
| server → client | `task:comment` | New comment on a task |
| server → client | `presence` | Users currently viewing the board |
| server → client | `notification` | New notification for this user |
| server → client | `project:removed` · `project:deleted` | You lost access to the board |
