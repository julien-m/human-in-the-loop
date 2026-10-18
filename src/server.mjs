import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store, Fault } from './store.mjs';

export const UI_URI = 'ui://human-in-the-loop/0.1.0/tasks.html';
const scope = z.string().uuid();
const actionId = z.string().min(1).max(200);
const bound = z.object({ scope, uiToken: z.string().uuid() });
const key = { scope, actionId };
const uiMeta = { ui: { resourceUri: UI_URI } };
const reply = (value, hidden) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(hidden ? { _meta: hidden } : {}) });
const guard = fn => async args => {
  try { return await fn(args); }
  catch (error) { return { ...reply({ error: error instanceof Fault ? error.code : 'internal_error' }), isError: true }; }
};

export function createServer(store, html) {
  const server = new McpServer({ name: 'human-in-the-loop', version: '0.1.0' });
  const ui = (name, description, inputSchema, fn) => registerAppTool(server, name, {
    title: description, description, inputSchema,
    annotations: { readOnlyHint: name === 'human_read', destructiveHint: false },
    _meta: { ui: { resourceUri: UI_URI, visibility: ['app'] } }
  }, guard(args => { store.authorizeUi(args.scope, args.uiToken); return reply(fn(args)); }));

  registerAppTool(server, 'my_tasks', {
    title: 'Human in the loop',
    description: 'Open the persistent My tasks panel. Use the exact scope from the Human in the loop lifecycle hook. Never invent a scope or choose another conversation. The menu without scope remains unbound.',
    inputSchema: z.object({ scope: scope.optional() }), annotations: { readOnlyHint: true },
    _meta: { ...uiMeta, 'openai/ui': { entrypoints: [{ type: 'thread' }] } }
  }, guard(args => args.scope ? reply({ scope: args.scope, openingRequested: true }, store.binding(args.scope)) : reply({ identityRequired: true })));

  registerAppTool(server, 'assign_task', {
    title: 'Assign a task to the user',
    description: 'Keep something only the human can do in My tasks: do, answer or choose. Continue independent work. Supply an imperative title, why and optionally done_when. Never request secret values: ask to put them in their destination then mark Done. Max five open tasks, normalized-title deduplication. Only the main agent assigns; subagents report needs to their parent. Use the runtime hook scope and a unique stable actionId. A UI result requests a panel; it does not prove visibility.',
    inputSchema: z.object({ ...key, title: z.string().min(1).max(80), why: z.string().min(1).max(300), kind: z.enum(['do', 'answer', 'choose']).default('do'), done_when: z.string().max(300).default(''), options: z.array(z.string().min(1).max(60)).max(4).default([]) }),
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: uiMeta
  }, guard(args => reply({ ...store.assign(args.scope, args), scope: args.scope }, store.binding(args.scope))));

  server.registerTool('list_tasks', {
    title: 'Read tasks and saved responses', description: 'Read this scope only. Answers carry stable response IDs. This read does not mark answers processed. After handling them, call acknowledge_responses; do not repeat a human action because a message appears twice.',
    inputSchema: z.object({ scope }), annotations: { readOnlyHint: true }
  }, guard(args => reply(store.snapshot(args.scope))));

  server.registerTool('withdraw_task', {
    title: 'Withdraw a task', description: 'Withdraw an open human task when no longer needed, explaining why. Does not discard a response already given.',
    inputSchema: z.object({ ...key, taskId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), reason: z.string().min(1).max(300) }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guard(args => reply(store.withdraw(args.scope, args))));

  server.registerTool('acknowledge_responses', {
    title: 'Acknowledge received responses', description: 'Acknowledge exact response IDs after the main agent has consumed them. Means received, not proof that downstream work succeeded. Idempotent; reject foreign-scope IDs.',
    inputSchema: z.object({ scope, responseIds: z.array(z.string().uuid()).min(1).max(100) }), annotations: { readOnlyHint: false, destructiveHint: false }
  }, guard(args => reply(store.delivery(args.scope, args.responseIds, 'acknowledged'))));

  ui('human_read', 'Read the bound human task panel', bound, a => store.snapshot(a.scope));
  ui('human_respond', 'Save a human response', bound.extend({ actionId, taskId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), action: z.enum(['done', 'answer', 'choose', 'reject']), text: z.string().max(100000).default(''), allowSecret: z.boolean().default(false) }), a => ({ ...store.respond(a.scope, a), snapshot: store.snapshot(a.scope) }));
  ui('human_delivery', 'Record host message acceptance or uncertainty', bound.extend({ responseIds: z.array(z.string().uuid()).min(1).max(100), status: z.enum(['accepted', 'unknown']) }), a => { store.delivery(a.scope, a.responseIds, a.status); return store.snapshot(a.scope); });
  ui('human_adopt', 'Recover tasks from an ended session in this project', bound.extend({ fromThreadId: z.string().min(1).max(300), actionId }), a => { store.adopt(a.scope, a); return store.snapshot(a.scope); });

  registerAppResource(server, 'Human in the loop', UI_URI, {
    description: 'Persistent human tasks and saved responses', _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } }
  }, async uri => ({ contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: html(), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] }));
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const store = new Store();
  serveStdio(() => createServer(store, () => readFileSync(new URL('./tasks.html', import.meta.url), 'utf8')));
}
