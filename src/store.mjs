import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export class Fault extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireThat = (condition, code) => { if (!condition) throw new Fault(code); };
const normalized = text => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, max = 10000) => typeof value === 'string' && value.length <= max;
const visible = task => task.state === 'open' || task.response?.delivery !== 'acknowledged' && !!task.response;
export const looksSecret = value => /\b(sk-(?:ant-)?[\w-]{20,}|sk_(?:live|test)_[\w]{10,}|gh[pousr]_[\w]{30,}|github_pat_[\w]{30,}|xox[baprs]-[\w-]{10,}|AKIA[A-Z0-9]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) || (value.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []).some(t => /[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t));
export const dataPath = () => join(process.env.HUMAN_LOOP_DATA_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'human-in-the-loop'), 'state.sqlite');

export class Store {
  constructor(file = dataPath()) {
    const folder = dirname(file);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    requireThat(!lstatSync(folder).isSymbolicLink(), 'unsafe_data_directory');
    if (existsSync(file)) requireThat(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'unsafe_database');
    // SQLite sidecars inherit the restrictive database mode. Set umask only for creation.
    const mask = process.umask(0o077);
    try { this.db = new DatabaseSync(file); } finally { process.umask(mask); }
    chmodSync(file, 0o600);
    this.db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    requireThat(version === 0 || version === 1, 'unsupported_database_version');
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      thread TEXT PRIMARY KEY, scope TEXT UNIQUE NOT NULL, ui_token TEXT NOT NULL,
      project TEXT NOT NULL, working INTEGER NOT NULL DEFAULT 0, ended INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tasks (
        number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        owner TEXT NOT NULL REFERENCES sessions(thread), payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_owner ON tasks(owner);
      CREATE TABLE IF NOT EXISTS commands (
        scope TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(scope,key)); PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  session(scope) {
    requireThat(text(scope, 100), 'invalid_scope');
    const found = this.db.prepare('SELECT * FROM sessions WHERE scope=?').get(scope);
    requireThat(found, 'unknown_session');
    return found;
  }
  authorizeUi(scope, token) {
    const session = this.session(scope);
    const expected = Buffer.from(session.ui_token);
    const received = Buffer.from(typeof token === 'string' ? token : '');
    requireThat(received.length === expected.length && timingSafeEqual(received, expected), 'invalid_ui_token');
  }
  begin(thread, project, working = false) {
    requireThat(text(thread, 300) && thread.length > 0 && text(project, 4096) && project.length > 0, 'invalid_identity');
    return this.tx(() => {
      this.db.prepare('INSERT OR IGNORE INTO sessions(thread,scope,ui_token,project) VALUES(?,?,?,?)').run(thread, randomUUID(), randomUUID(), project);
      // One immutable project binding per thread; never silently route to a different project.
      const session = this.db.prepare('SELECT * FROM sessions WHERE thread=?').get(thread);
      requireThat(session.project === project, 'project_mismatch');
      this.db.prepare('UPDATE sessions SET working=?,ended=0 WHERE thread=?').run(Number(working), thread);
      return { scope: session.scope, threadId: thread };
    });
  }
  lifecycle(thread, event) {
    const session = this.db.prepare('SELECT * FROM sessions WHERE thread=?').get(thread);
    if (!session) return null;
    this.db.prepare('UPDATE sessions SET working=?,ended=?,revision=revision+1 WHERE thread=?').run(Number(event === 'UserPromptSubmit'), Number(event === 'SessionEnd'), thread);
    return session.scope;
  }
  binding(scope) { const s = this.session(scope); return { scope, uiToken: s.ui_token }; }
  rows(thread) {
    return this.db.prepare('SELECT number,payload FROM tasks WHERE owner=? ORDER BY number').all(thread).map(row => ({ ...JSON.parse(row.payload), number: row.number }));
  }
  save(thread, task) {
    this.db.prepare('UPDATE tasks SET payload=? WHERE id=? AND owner=?').run(JSON.stringify(task), task.id, thread);
    this.db.prepare('UPDATE sessions SET revision=revision+1 WHERE thread=?').run(thread);
  }
  snapshot(scope) {
    const s = this.session(scope), tasks = this.rows(s.thread).filter(visible);
    const previous = this.db.prepare('SELECT thread FROM sessions WHERE project=? AND ended=1 AND thread<>?').all(s.project, s.thread)
      .map(row => ({ threadId: row.thread, count: this.rows(row.thread).filter(visible).length })).filter(row => row.count);
    return { revision: s.revision, working: !!s.working, ended: !!s.ended, tasks,
      pending: tasks.filter(t => t.response && t.response.delivery !== 'acknowledged').map(t => ({ ...t.response, task_id: t.id, number: t.number, title: t.title, state: t.state })), previous };
  }
  command(scope, key, body, fn) {
    requireThat(text(key, 200) && key.length > 0, 'invalid_action_id');
    return this.tx(() => {
      const session = this.session(scope), hash = digest(body);
      const old = this.db.prepare('SELECT hash,result FROM commands WHERE scope=? AND key=?').get(scope, key);
      if (old) { requireThat(old.hash === hash, 'idempotency_conflict'); return JSON.parse(old.result); }
      const result = fn(session);
      this.db.prepare('INSERT INTO commands(scope,key,hash,result) VALUES(?,?,?,?)').run(scope, key, hash, JSON.stringify(result));
      return result;
    });
  }
  assign(scope, args) {
    const { title, why, kind = 'do', done_when = '', options = [], actionId } = args;
    requireThat(text(title, 80) && normalized(title) && text(why, 300) && why.trim() && text(done_when, 300), 'invalid_task');
    requireThat(['do', 'answer', 'choose'].includes(kind), 'invalid_kind');
    requireThat(Array.isArray(options) && (kind === 'choose' ? options.length >= 2 && options.length <= 4 && options.every(o => text(o, 60) && o.trim()) && new Set(options).size === options.length : options.length === 0), 'invalid_options');
    const body = { title, why, kind, done_when, options };
    return this.command(scope, actionId, body, s => {
      const active = this.rows(s.thread).filter(t => t.state === 'open');
      const same = active.find(t => normalized(t.title) === normalized(title));
      if (same) return { task: same, duplicate: true };
      requireThat(active.length < 5, 'too_many_open_tasks');
      const task = { ...body, id: randomUUID(), state: 'open', revision: 0, createdAt: Date.now(), updatedAt: Date.now() };
      const row = this.db.prepare('INSERT INTO tasks(id,owner,payload) VALUES(?,?,?)').run(task.id, s.thread, JSON.stringify(task));
      this.db.prepare('UPDATE sessions SET revision=revision+1 WHERE thread=?').run(s.thread);
      return { task: { ...task, number: Number(row.lastInsertRowid) }, duplicate: false };
    });
  }
  task(session, id) {
    const found = this.rows(session.thread).find(t => t.id === id);
    requireThat(found, 'task_not_found');
    return found;
  }
  respond(scope, args) {
    const { taskId, expectedRevision, action, text: answer = '', allowSecret = false, actionId } = args;
    requireThat(text(answer, 100000) && typeof allowSecret === 'boolean', 'invalid_response');
    requireThat(['done', 'answer', 'choose', 'reject'].includes(action), 'invalid_action');
    requireThat(!looksSecret(answer) || allowSecret, 'secret_held');
    return this.command(scope, actionId, { taskId, expectedRevision, action, answer, allowSecret }, s => {
      const task = this.task(s, taskId);
      requireThat(task.revision === expectedRevision, 'revision_conflict');
      requireThat(task.state === 'open', 'not_open');
      if (action === 'choose') requireThat(task.kind === 'choose' && task.options.includes(answer), 'invalid_choice');
      if (action === 'answer') requireThat(answer.trim(), 'empty_response');
      if (action === 'reject') requireThat(answer.trim(), 'reason_required');
      if (action === 'done') requireThat(task.kind === 'do', 'invalid_action');
      const response = { id: randomUUID(), text: action === 'done' ? 'Done.' : answer, delivery: 'pending', createdAt: Date.now() };
      this.save(s.thread, { ...task, state: action === 'reject' ? 'rejected' : 'done', response, revision: task.revision + 1, updatedAt: Date.now() });
      return { response };
    });
  }
  withdraw(scope, { taskId, reason, expectedRevision, actionId }) {
    requireThat(text(reason, 300) && reason.trim(), 'reason_required');
    return this.command(scope, actionId, { taskId, reason, expectedRevision }, s => {
      const task = this.task(s, taskId);
      requireThat(task.revision === expectedRevision, 'revision_conflict');
      requireThat(task.state === 'open', 'not_open');
      this.save(s.thread, { ...task, state: 'withdrawn', reason, revision: task.revision + 1, updatedAt: Date.now() });
      return { withdrawn: taskId };
    });
  }
  delivery(scope, ids, status) {
    requireThat(['accepted', 'unknown', 'acknowledged'].includes(status) && Array.isArray(ids) && ids.length > 0 && ids.length <= 100 && ids.every(id => text(id, 100)), 'invalid_delivery');
    return this.tx(() => {
      const s = this.session(scope), tasks = this.rows(s.thread);
      const found = ids.map(id => { const task = tasks.find(t => t.response?.id === id); requireThat(task, 'response_not_found'); return task; });
      for (const task of found) {
        if (task.response.delivery === 'acknowledged') continue;
        this.save(s.thread, { ...task, response: { ...task.response, delivery: status }, updatedAt: Date.now() });
      }
      return { updated: ids };
    });
  }
  adopt(scope, { fromThreadId, actionId }) {
    return this.command(scope, actionId, { fromThreadId }, s => {
      const from = this.db.prepare('SELECT * FROM sessions WHERE thread=?').get(fromThreadId);
      requireThat(from && from.project === s.project && from.thread !== s.thread && from.ended, 'source_session_not_ended');
      const incoming = this.rows(from.thread).filter(visible);
      requireThat(this.rows(s.thread).filter(t => t.state === 'open').length + incoming.filter(t => t.state === 'open').length <= 5, 'too_many_open_tasks');
      for (const task of incoming) {
        this.db.prepare('UPDATE tasks SET owner=?,payload=? WHERE id=? AND owner=?').run(s.thread, JSON.stringify({ ...task, originThread: task.originThread || from.thread }), task.id, from.thread);
      }
      this.db.prepare('UPDATE sessions SET revision=revision+1 WHERE thread IN (?,?)').run(s.thread, from.thread);
      return { adopted: incoming.map(t => t.id) };
    });
  }
}
