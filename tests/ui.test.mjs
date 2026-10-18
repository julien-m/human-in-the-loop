import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mount, decodeToolResult } from '../src/ui.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const task = (kind = 'do') => ({ id: 'task-1', number: 1, title: 'Synthetic task', why: 'Demo', kind, options: ['A', 'B'], state: 'open', revision: 1 });
function fixture(t, config = {}) {
  const { document, window } = parseHTML('<html><body><main id="app"></main></body></html>');
  let snapshot = { revision: 1, working: false, ended: false, tasks: [task(config.kind)], pending: [], previous: [] };
  const calls = [], sends = [];
  const backend = {
    canSend: () => config.bridge ?? true,
    async send(text) { sends.push(text); if (config.sendFail) throw config.sendFail instanceof Error ? config.sendFail : new Error('ambiguous'); },
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'human_respond') {
        if (config.respondFail) throw Object.assign(new Error('synthetic error'), { code: config.respondFail });
        const response = { id: 'response-1', task_id: 'task-1', number: 1, title: 'Synthetic task', text: args.text || 'Fait', state: args.action === 'reject' ? 'rejected' : 'done', delivery: 'pending' };
        snapshot = { ...snapshot, tasks: [], pending: [response] }; return { response, snapshot };
      }
      if (name === 'human_delivery') snapshot = { ...snapshot, pending: snapshot.pending.map(r => ({ ...r, delivery: args.status })) };
      return structuredClone(snapshot);
    },
  };
  const root = document.getElementById('app');
  const ui = mount(root, backend, config.unbound ? undefined : { scope: 'scope-demo', uiToken: 'token-demo' });
  t.after(() => ui.destroy());
  return { root, document, window, ui, calls, sends, set: patch => { snapshot = { ...snapshot, ...patch }; }, button: label => [...root.querySelectorAll('button')].find(n => n.textContent === label) };
}

test('unbound panel never selects or reads a conversation', { timeout: 2000 }, async t => {
  const f = fixture(t, { unbound: true }); await tick(); assert.equal(f.calls.length, 0); assert.match(f.root.textContent, /Aucune conversation/);
});
test('done sends once while idle and retains pending until acknowledgement', { timeout: 2000 }, async t => {
  const f = fixture(t); await tick(); f.button('Fait').click(); await tick();
  assert.equal(f.sends.length, 1); assert.match(f.sends[0], /#1 — Synthetic task/); assert.match(f.sends[0], /Response ID: response-1/);
  assert.match(f.root.textContent, /Message accepté — attente de l’agent/); await f.ui.refresh(); assert.equal(f.sends.length, 1);
  f.set({ pending: [] }); await f.ui.refresh(); assert.doesNotMatch(f.root.textContent, /Réponses enregistrées/);
});
test('busy queues choices and sends when idle only after all tasks close', { timeout: 2000 }, async t => {
  const f = fixture(t, { kind: 'choose' }); f.set({ working: true }); await tick(); await f.ui.refresh(); f.button('B').click(); await tick();
  assert.equal(f.sends.length, 0); assert.equal(f.calls.find(c => c.name === 'human_respond').args.text, 'B');
  f.set({ working: false, tasks: [task()] }); await f.ui.refresh(); assert.equal(f.sends.length, 0);
  f.set({ working: true, tasks: [] }); await f.ui.refresh(); f.set({ working: false }); await f.ui.refresh(); assert.equal(f.sends.length, 1);
});
test('ambiguous delivery becomes unknown without automatic retry', { timeout: 2000 }, async t => {
  const f = fixture(t, { sendFail: true }); await tick(); f.button('Fait').click(); await tick();
  assert.equal(f.sends.length, 1); assert.match(f.root.textContent, /Envoi incertain/); assert.equal(f.button('Envoyer maintenant').disabled, true);
  f.set({ working: true }); await f.ui.refresh(); f.set({ working: false }); await f.ui.refresh(); assert.equal(f.sends.length, 1);
});
test('no bridge keeps saved responses pending with explicit copy fallback', { timeout: 2000 }, async t => {
  const f = fixture(t, { bridge: false }); await tick(); f.button('Fait').click(); await tick();
  assert.equal(f.sends.length, 0); assert.match(f.root.textContent, /elles restent en attente/); assert.ok(f.button('Copier les réponses'));
});
test('revision conflict preserves draft; retry retains action ID; text is escaped', { timeout: 2000 }, async t => {
  const f = fixture(t, { kind: 'answer', respondFail: 'revision_conflict' }); f.set({ tasks: [{ ...task('answer'), title: '<img src=x onerror=alert(1)>' }] }); await tick(); await f.ui.refresh();
  const area = f.root.querySelector('textarea'); area.value = 'Un brouillon'; area.dispatchEvent(new f.window.Event('input')); f.button('Répondre').click(); await tick();
  assert.equal(f.root.querySelector('textarea').value, 'Un brouillon'); assert.equal(f.root.querySelectorAll('img').length, 0);
  f.button('Répondre').click(); await tick(); const requests = f.calls.filter(c => c.name === 'human_respond'); assert.equal(requests[0].args.actionId, requests[1].args.actionId);
});
test('secret confirmation requires explicit action and a new payload ID', { timeout: 2000 }, async t => {
  const f = fixture(t, { respondFail: 'secret_held' }); await tick(); f.button('Fait').click(); await tick();
  assert.equal(f.calls.filter(c => c.name === 'human_respond').length, 1);
  f.button('J’ai vérifié : autoriser cette réponse').click(); await tick(); const r = f.calls.filter(c => c.name === 'human_respond'); assert.equal(r[1].args.allowSecret, true); assert.notEqual(r[0].args.actionId, r[1].args.actionId);
});
test('reject captures reason and hide preserves a response draft', { timeout: 2000 }, async t => {
  const f = fixture(t, { kind: 'answer', bridge: false }); await tick(); let area = f.root.querySelector('textarea'); area.value = 'Draft'; area.dispatchEvent(new f.window.Event('input'));
  f.button('Masquer').click(); f.button('Afficher').click(); assert.equal(f.root.querySelector('textarea').value, 'Draft');
  f.button('Refuser').click(); area = f.root.querySelector('textarea'); area.value = 'Unavailable'; area.dispatchEvent(new f.window.Event('input')); f.button('Confirmer le refus').click(); await tick();
  const r = f.calls.find(c => c.name === 'human_respond'); assert.equal(r.args.action, 'reject'); assert.equal(r.args.text, 'Unavailable');
});
test('same-session binding preserves drafts and previous sessions require explicit adoption', { timeout: 2000 }, async t => {
  const f = fixture(t, { kind: 'answer', bridge: false }); f.set({ previous: [{ threadId: 'ended-demo', count: 2 }] }); await tick(); await f.ui.refresh();
  const area = f.root.querySelector('textarea'); area.value = 'Keep this draft'; area.dispatchEvent(new f.window.Event('input'));
  f.ui.bind({ scope: 'scope-demo', uiToken: 'token-demo' }); await tick(); assert.equal(f.root.querySelector('textarea').value, 'Keep this draft');
  assert.equal(f.calls.filter(c => c.name === 'human_adopt').length, 0);
  f.button('Récupérer 2 demande(s) d’une session terminée').click(); await tick();
  assert.equal(f.calls.find(c => c.name === 'human_adopt').args.fromThreadId, 'ended-demo');
});
test('send now permits explicit delivery while agent is busy without duplicate clicks', { timeout: 2000 }, async t => {
  const f = fixture(t); await tick(); f.set({ working: true }); await f.ui.refresh(); f.button('Fait').click(); await tick();
  const send = f.button('Envoyer maintenant'); send.click(); send.click(); await tick(); assert.equal(f.sends.length, 1);
});

test('structured backend error strings preserve secret confirmation code', { timeout: 2000 }, () => {
  assert.throws(() => decodeToolResult({ isError: true, structuredContent: { error: 'secret_held' } }), e => e.code === 'secret_held');
  assert.throws(() => decodeToolResult({ isError: true, structuredContent: { error: { code: 'revision_conflict', message: 'changed' } } }), e => e.code === 'revision_conflict' && e.message === 'changed');
});
test('actions and choices can both receive free responses', { timeout: 2000 }, async t => {
  for (const kind of ['do', 'choose']) {
    const f = fixture(t, { kind, bridge: false }); await tick();
    f.button(kind === 'do' ? 'Répondre' : 'Autre réponse').click();
    const area = f.root.querySelector('textarea'); area.value = 'A different answer'; area.dispatchEvent(new f.window.Event('input'));
    f.button('Répondre').click(); await tick();
    const call = f.calls.find(c => c.name === 'human_respond'); assert.equal(call.args.action, 'answer'); assert.equal(call.args.text, 'A different answer');
  }
});
test('send timeout is treated as unknown without automatic retry', { timeout: 2000 }, async t => {
  const f = fixture(t, { sendFail: Object.assign(new Error('Request timed out'), { code: 'RequestTimeout' }) }); await tick();
  f.button('Fait').click(); await tick();
  assert.equal(f.sends.length, 1); assert.match(f.root.textContent, /Envoi incertain/);
  assert.equal(f.calls.find(c => c.name === 'human_delivery').args.status, 'unknown');
  await f.ui.refresh(); assert.equal(f.sends.length, 1);
});
test('scope switch ignores old reads and immediately reads the new binding after release', { timeout: 2000 }, async t => {
  const { document } = parseHTML('<html><body><main id="app"></main></body></html>');
  const root = document.getElementById('app'); const calls = []; let release;
  const empty = title => ({ revision: 1, working: false, ended: false, tasks: [{ ...task(), title }], pending: [], previous: [] });
  const backend = { canSend: () => false, async call(name, args) { calls.push(args.scope); if (args.scope === 'old') return new Promise(resolve => { release = resolve; }); return empty('New scope only'); } };
  const ui = mount(root, backend, { scope: 'old', uiToken: 'token-old' }); t.after(() => ui.destroy());
  ui.bind({ scope: 'new', uiToken: 'token-new' }); release(empty('Old scope secret')); await tick();
  assert.deepEqual(calls, ['old', 'new']); assert.match(root.textContent, /New scope only/); assert.doesNotMatch(root.textContent, /Old scope secret/);
});
test('scope switch ignores old mutation results and refreshes after mutation release', { timeout: 2000 }, async t => {
  const { document } = parseHTML('<html><body><main id="app"></main></body></html>');
  const root = document.getElementById('app'); const calls = []; let release;
  const empty = title => ({ revision: 1, working: false, ended: false, tasks: [{ ...task(), title }], pending: [], previous: [] });
  const backend = { canSend: () => false, async call(name, args) { calls.push({ name, scope: args.scope }); if (name === 'human_respond') return new Promise(resolve => { release = resolve; }); return empty(args.scope === 'old' ? 'Old scope' : 'New scope only'); } };
  const ui = mount(root, backend, { scope: 'old', uiToken: 'token-old' }); t.after(() => ui.destroy()); await tick();
  [...root.querySelectorAll('button')].find(b => b.textContent === 'Fait').click();
  ui.bind({ scope: 'new', uiToken: 'token-new' }); release({ snapshot: empty('Old mutation result') }); await tick();
  assert.ok(calls.some(c => c.name === 'human_read' && c.scope === 'new')); assert.match(root.textContent, /New scope only/); assert.doesNotMatch(root.textContent, /Old mutation result/);
});
test('late pre-send read cannot restore pending delivery or send a duplicate', { timeout: 2000 }, async t => {
  const { document } = parseHTML('<html><body><main id="app"></main></body></html>');
  const root = document.getElementById('app');
  const response = { id: 'response-demo', task_id: 'task-demo', number: 1, title: 'Synthetic request', text: 'Ready', state: 'done', delivery: 'pending' };
  const snapshot = { revision: 1, working: true, ended: false, tasks: [], pending: [response], previous: [] };
  let reads = 0, sends = 0, release;
  const backend = {
    canSend: () => true,
    async send() { sends++; },
    async call(name) {
      if (name === 'human_delivery') return { ...snapshot, pending: [{ ...response, delivery: 'accepted' }] };
      if (++reads === 1) return structuredClone(snapshot);
      return new Promise(resolve => { release = resolve; });
    },
  };
  const ui = mount(root, backend, { scope: 'demo', uiToken: 'demo-token' }); t.after(() => ui.destroy()); await tick();
  const reading = ui.refresh();
  [...root.querySelectorAll('button')].find(b => b.textContent === 'Envoyer maintenant').click(); await tick();
  assert.equal(sends, 1); assert.match(root.textContent, /Message accepté — attente de l’agent/);
  release({ ...snapshot, working: false }); await reading; await tick();
  assert.equal(sends, 1); assert.match(root.textContent, /Message accepté — attente de l’agent/);
});
test('a read resolving after editing begins does not redraw the active draft', { timeout: 2000 }, async t => {
  const { document, window } = parseHTML('<html><body><main id="app"></main></body></html>');
  const root = document.getElementById('app'); let reads = 0, release;
  const snapshot = { revision: 1, working: false, ended: false, tasks: [task('answer')], pending: [], previous: [] };
  const backend = { canSend: () => false, async call() { if (++reads === 1) return snapshot; return new Promise(resolve => { release = resolve; }); } };
  const ui = mount(root, backend, { scope: 'demo', uiToken: 'demo-token' }); t.after(() => ui.destroy()); await tick();
  const reading = ui.refresh(); const area = root.querySelector('textarea');
  Object.defineProperty(document, 'activeElement', { configurable: true, value: area });
  area.value = 'Typing now'; area.dispatchEvent(new window.Event('input'));
  release({ ...snapshot, working: true }); await reading;
  assert.equal(root.querySelector('textarea'), area); assert.equal(area.value, 'Typing now');
});
