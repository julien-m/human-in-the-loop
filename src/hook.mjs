import { Store } from './store.mjs';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export function handleHook(store, payload) {
  const event = payload.hook_event_name;
  const thread = payload.session_id;
  if (typeof thread !== 'string' || !thread || thread.length > 300 || payload.agent_id || payload.is_subagent) return {};
  let scope;
  if (event === 'SessionStart') {
    if (typeof payload.cwd !== 'string') return {};
    scope = store.begin(thread, realpathSync(payload.cwd), payload.source === 'compact').scope;
  } else scope = store.lifecycle(thread, event);
  if (!scope || event === 'SessionEnd') return {};
  const snapshot = store.snapshot(scope);
  const instructions = `Human in the loop: scope=${scope}. Only the main agent assigns tasks. When you need something only the user can do, call assign_task (do/answer/choose) with this scope and a unique actionId; do not bury the request in prose. Open my_tasks on request or when restoring pending tasks. Continue independent work while waiting; never proceed on work that requires the answer. Never ask to paste secrets; ask to place them in their destination then mark Done. list_tasks reads saved responses; acknowledge_responses with exact response IDs only after consuming them. Acknowledgement does not prove downstream execution. Never invent another scope or adopt a live conversation. ${snapshot.tasks.filter(t => t.state === 'open').length} open task(s), ${snapshot.pending.length} unacknowledged response(s). ${snapshot.previous.length} ended session(s) have recoverable tasks; adoption requires the human's explicit panel action. Read list_tasks before finalizing if responses are pending.`;
  // User values stay out of the developer-context instructions. Fetch through the scoped tool.
  if (event === 'Stop') {
    if (!payload.stop_hook_active && snapshot.pending.length && !snapshot.tasks.some(t => t.state === 'open')) {
      return { decision: 'block', reason: `${instructions} Consume and acknowledge pending responses before finishing. Do not create an artificial waiting loop.` };
    }
    return {};
  }
  if (['SessionStart', 'UserPromptSubmit'].includes(event)) return { hookSpecificOutput: { hookEventName: event, additionalContext: instructions } };
  return {};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let input = '';
  try {
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 262144) throw new Error('input_too_large'); }
    const store = new Store();
    try { process.stdout.write(JSON.stringify(handleHook(store, JSON.parse(input)))); } finally { store.close(); }
  } catch {
    process.stdout.write(JSON.stringify({ systemMessage: 'Human in the loop could not read its persistent state. Saved tasks were not declared empty. Check the local installation.' }));
  }
}
