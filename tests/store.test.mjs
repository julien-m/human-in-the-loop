import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Store, looksSecret } from '../src/store.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'human-loop-test-'));
  const file = join(dir, 'state.sqlite');
  const store = new Store(file), scope = store.begin('thread-a', 'project-fixture').scope;
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, scope, file };
}
const assign = (store, scope, title = 'Choose a name', kind = 'do', options = []) => store.assign(scope, { title, why: 'Unblock the next step.', kind, options, actionId: randomUUID() }).task;
const respond = (store, scope, task, action, text = '') => store.respond(scope, { taskId: task.id, expectedRevision: task.revision, action, text, actionId: randomUUID() });

test('three task kinds validate and normalized duplicates do not consume the five open slots', { timeout: 2000 }, t => {
  const { store, scope } = fixture(t);
  const first = assign(store, scope, 'Pick a name!', 'answer');
  assert.equal(assign(store, scope, 'pick  a name', 'answer').id, first.id);
  assign(store, scope, 'Choose', 'choose', ['A', 'B']);
  assert.throws(() => assign(store, scope, 'Invalid', 'choose', ['only one']), /invalid_options/);
  for (let i = 0; i < 3; i++) assign(store, scope, `Action ${i}`);
  assert.throws(() => assign(store, scope, 'Sixth'), /too_many_open_tasks/);
});

test('responses persist before delivery and only exact agent acknowledgement hides them', { timeout: 2000 }, t => {
  const { store, scope, file } = fixture(t);
  const task = assign(store, scope, 'Give a name', 'answer');
  const { response } = respond(store, scope, task, 'answer', 'A multiline\nanswer');
  const reopened = new Store(file);
  try { assert.equal(reopened.snapshot(scope).pending[0].text, 'A multiline\nanswer'); } finally { reopened.close(); }
  store.delivery(scope, [response.id], 'accepted');
  assert.equal(store.snapshot(scope).pending.length, 1);
  store.delivery(scope, [response.id], 'unknown');
  assert.equal(store.snapshot(scope).pending[0].delivery, 'unknown');
  store.delivery(scope, [response.id], 'acknowledged');
  store.delivery(scope, [response.id], 'accepted');
  assert.equal(store.snapshot(scope).tasks.length, 0);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('scope isolation, UI token and ended-only adoption are enforced', { timeout: 2000 }, t => {
  const { store, scope } = fixture(t);
  const second = store.begin('thread-b', 'project-fixture').scope;
  const other = store.begin('thread-c', 'another-project').scope;
  const task = assign(store, scope);
  assert.throws(() => respond(store, second, task, 'done'), /task_not_found/);
  assert.throws(() => store.authorizeUi(second, store.binding(scope).uiToken), /invalid_ui_token/);
  assert.throws(() => store.adopt(second, { fromThreadId: 'thread-a', actionId: 'adopt-live' }), /source_session_not_ended/);
  store.lifecycle('thread-a', 'SessionEnd');
  assert.throws(() => store.adopt(other, { fromThreadId: 'thread-a', actionId: 'adopt-foreign' }), /source_session_not_ended/);
  assert.equal(store.snapshot(second).previous[0].count, 1);
  store.adopt(second, { fromThreadId: 'thread-a', actionId: 'adopt-ended' });
  assert.equal(store.snapshot(second).tasks[0].id, task.id);
  assert.equal(store.snapshot(scope).tasks.length, 0);
});

test('CAS and action idempotence reject stale and altered retries without duplicating responses', { timeout: 2000 }, t => {
  const { store, scope } = fixture(t), task = assign(store, scope);
  const args = { taskId: task.id, expectedRevision: 0, action: 'done', actionId: 'one-click' };
  const one = store.respond(scope, args);
  assert.deepEqual(store.respond(scope, args), one);
  assert.throws(() => store.respond(scope, { ...args, action: 'reject' }), /idempotency_conflict/);
  assert.throws(() => store.respond(scope, { ...args, actionId: 'another-click' }), /revision_conflict/);
  assert.equal(store.snapshot(scope).pending.length, 1);
});

test('secret-shaped answers are held, free answers to choices work, rejected and withdrawn remain distinct', { timeout: 2000 }, t => {
  const { store, scope } = fixture(t);
  const task = assign(store, scope, 'Choose a name', 'choose', ['A', 'B']);
  assert.throws(() => respond(store, scope, task, 'choose', 'C'), /invalid_choice/);
  const secret = 'sk-' + 'x'.repeat(30);
  assert(looksSecret(secret));
  assert.throws(() => respond(store, scope, task, 'answer', secret), /secret_held/);
  respond(store, scope, task, 'answer', 'Another name');
  const declined = assign(store, scope, 'Decline me');
  assert.throws(() => respond(store, scope, declined, 'reject', ''), /reason_required/);
  respond(store, scope, declined, 'reject', 'No account access');
  assert.equal(store.snapshot(scope).pending.at(-1).state, 'rejected');
  const withdrawn = assign(store, scope, 'No longer required');
  store.withdraw(scope, { taskId: withdrawn.id, expectedRevision: 0, reason: 'Found another way', actionId: 'withdraw' });
  assert(!store.snapshot(scope).tasks.some(t => t.id === withdrawn.id));
});

test('concurrent processes serialize at the five-task limit', { timeout: 10000 }, async t => {
  const { store, scope, file } = fixture(t);
  const module = new URL('../src/store.mjs', import.meta.url).href;
  const workers = Array.from({ length: 7 }, (_, i) => new Promise((resolve, reject) => {
    const code = `import {Store} from ${JSON.stringify(module)}; const s=new Store(process.argv[1]); try{s.assign(process.argv[2],{title:process.argv[3],why:'Concurrency fixture',actionId:process.argv[3]});}catch(e){if(e.code!=='too_many_open_tasks')process.exitCode=1;}finally{s.close()}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, file, scope, `Task ${i}`], { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('worker timeout')); }, 5000);
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`worker ${code}`)); });
  }));
  await Promise.all(workers);
  assert.equal(store.snapshot(scope).tasks.length, 5);
  assert.equal(new Set(store.snapshot(scope).tasks.map(t => t.number)).size, 5);
});
