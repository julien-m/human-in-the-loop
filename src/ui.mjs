const labels = { do: 'Action', answer: 'Question', choose: 'Choix' };
const errorLabel = {
  reason_required: 'Indiquez le motif du refus avant de confirmer.',
  secret_held: 'Cette réponse peut contenir un secret. Vérifiez-la avant de confirmer son envoi.',
  revision_conflict: 'Cette demande a changé. Votre brouillon est conservé ; actualisez avant de répondre.',
  not_open: 'Cette demande est déjà fermée. Votre brouillon est conservé.',
  invalid_choice: 'Choisissez une option proposée.',
};

export function decodeToolResult(result) {
  const data = result?.structuredContent;
  if (result?.isError) {
    const code = typeof data?.error === 'string' ? data.error : data?.code || data?.error?.code;
    const message = data?.message || data?.error?.message || result.content?.find(c => c.type === 'text')?.text || 'Action indisponible';
    throw Object.assign(new Error(message), { code });
  }
  if (!data) throw new Error('Réponse structurée absente');
  return data;
}

export function formatResponses(responses) {
  return ['Human in the loop — réponses humaines', ...responses.map(r =>
    `\n#${r.number} — ${r.title}\n${r.state === 'rejected' ? 'Refus : ' : ''}${r.text || 'Fait'}\nResponse ID: ${r.id}`)].join('\n');
}

export function mount(root, backend, initialBinding) {
  const doc = root.ownerDocument;
  let binding = initialBinding, snapshot, reading = false, mutating = false, sending = false;
  let dead = false, generation = 0, mutationEpoch = 0, error = '', notice = '', hidden = false;
  const drafts = new Map(), requests = new Map(), collapsed = new Set(), uncertain = new Set();
  let secretRetry;
  const el = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const button = (label, fn, disabled = false) => {
    const node = el('button', label); node.type = 'button'; node.disabled = disabled;
    node.addEventListener('click', fn); return node;
  };
  const hasBinding = () => Boolean(binding?.scope && binding?.uiToken);
  const isEditing = () => root.contains(doc.activeElement) && ['TEXTAREA', 'INPUT', 'SELECT'].includes(doc.activeElement?.tagName);
  const pending = () => (snapshot?.pending || []).filter(r => r.delivery === 'pending' && !uncertain.has(r.id));
  const uuid = () => globalThis.crypto.randomUUID();
  const fail = e => { error = errorLabel[e.code] || e.message || 'Action indisponible. Votre réponse reste enregistrée.'; };

  async function deliver() {
    if (sending || mutating || !hasBinding() || !backend.canSend() || !pending().length) return;
    sending = true; mutationEpoch++; const gen = generation, capturedBinding = { ...binding }, responses = [...pending()]; render();
    let bridgeAccepted = false;
    try {
      await backend.send(formatResponses(responses)); bridgeAccepted = true;
      const result = await backend.call('human_delivery', { ...capturedBinding, responseIds: responses.map(r => r.id), status: 'accepted' });
      if (gen === generation) { snapshot = result; notice = 'Message accepté par l’hôte. En attente de lecture par l’agent.'; }
    } catch (e) {
      responses.forEach(r => uncertain.add(r.id));
      if (gen === generation) {
        error = bridgeAccepted ? 'Message accepté, mais son suivi n’a pas pu être enregistré. Ne le renvoyez pas sans vérifier le chat.' : 'Résultat de l’envoi inconnu. Vérifiez le chat avant toute récupération manuelle.';
        try { const result = await backend.call('human_delivery', { ...capturedBinding, responseIds: responses.map(r => r.id), status: 'unknown' }); if (gen === generation) snapshot = result; } catch { /* Local guard prevents duplicate delivery even if persistence is unavailable. */ }
      }
    } finally { sending = false; if (!dead) { render(); if (gen !== generation) void refresh(); } }
  }

  async function refresh() {
    if (dead || reading || mutating || sending || isEditing() || doc.hidden || !hasBinding()) return;
    reading = true; const gen = generation, epoch = mutationEpoch;
    const wasWorking = snapshot?.working;
    try {
      const result = await backend.call('human_read', { ...binding });
      if (gen !== generation || epoch !== mutationEpoch || dead || isEditing()) return;
      snapshot = result; render();
      if (wasWorking && !snapshot.working && !snapshot.tasks.some(t => t.state === 'open')) await deliver();
    } catch (e) { if (gen === generation && epoch === mutationEpoch && !isEditing()) { fail(e); render(); } }
    finally { reading = false; if (gen !== generation) void refresh(); }
  }

  async function respond(task, action, text, retry) {
    if (mutating || sending) return;
    const payloadKey = JSON.stringify([task.revision, action, text]);
    const prior = requests.get(task.id);
    const request = retry || (prior?.key === payloadKey ? prior.request : { ...binding, taskId: task.id, expectedRevision: task.revision, actionId: uuid(), action, ...(text === undefined ? {} : { text }) });
    requests.set(task.id, { key: payloadKey, request });
    mutating = true; mutationEpoch++; error = ''; secretRetry = undefined; const gen = generation; render();
    try {
      const result = await backend.call('human_respond', request);
      if (gen !== generation) return;
      snapshot = result.snapshot; drafts.delete(task.id); requests.delete(task.id); notice = 'Réponse enregistrée.';
    } catch (e) {
      if (gen === generation) { fail(e); if (e.code === 'secret_held') secretRetry = { task, request }; }
    } finally { mutating = false; if (!dead) { render(); if (gen !== generation) void refresh(); } }
    if (gen === generation && !error && !snapshot.working) await deliver();
  }

  function taskCard(task) {
    const card = el('article', undefined, 'task');
    card.append(el('div', `${labels[task.kind] || task.kind} · #${task.number}`, 'eyebrow'), el('h3', task.title));
    if (task.why) card.append(el('p', task.why, 'why'));
    if (task.done_when) card.append(el('p', `Terminé quand : ${task.done_when}`, 'criteria'));
    if (collapsed.has(task.id)) { card.append(button('Afficher', () => { collapsed.delete(task.id); render(); })); return card; }
    const draft = drafts.get(task.id) || {};
    if (task.kind === 'answer' || draft.rejecting || draft.answering) {
      const label = el('label', draft.rejecting ? 'Motif du refus' : 'Votre réponse');
      const area = el('textarea'); area.rows = 3; area.value = draft.text || '';
      area.setAttribute('aria-label', `${draft.rejecting ? 'Motif du refus' : 'Votre réponse'} : ${task.title}`);
      area.addEventListener('input', () => { drafts.set(task.id, { ...draft, text: area.value }); secretRetry = undefined; });
      label.append(area); card.append(label, button(draft.rejecting ? 'Confirmer le refus' : 'Répondre', () => respond(task, draft.rejecting ? 'reject' : 'answer', area.value), mutating || sending));
    } else if (task.kind === 'do') card.append(button('Fait', () => respond(task, 'done'), mutating || sending), button('Répondre', () => { drafts.set(task.id, { ...draft, answering: true }); render(); }, mutating || sending));
    else if (task.kind === 'choose') {
      const choices = el('div', undefined, 'choices');
      for (const option of task.options || []) {
        const text = typeof option === 'string' ? option : option.label;
        choices.append(button(text, () => respond(task, 'choose', typeof option === 'string' ? option : option.value ?? option.label), mutating || sending));
      }
      choices.append(button('Autre réponse', () => { drafts.set(task.id, { ...draft, answering: true }); render(); }, mutating || sending));
      card.append(choices);
    }
    const actions = el('div', undefined, 'secondary-actions');
    if (draft.answering && !draft.rejecting) actions.append(button('Annuler la réponse', () => { drafts.set(task.id, { ...draft, answering: false }); render(); }, mutating || sending));
    actions.append(button(draft.rejecting ? 'Annuler le refus' : 'Refuser', () => { drafts.set(task.id, { ...draft, rejecting: !draft.rejecting }); render(); }, mutating || sending), button('Masquer', () => { collapsed.add(task.id); render(); }));
    card.append(actions); return card;
  }

  function render() {
    if (dead) return;
    root.replaceChildren(); root.classList.add('hitl');
    const header = el('header'); header.append(el('h1', 'Human in the loop'), button(hidden ? 'Afficher mes tâches' : 'Réduire', () => { hidden = !hidden; render(); })); root.append(header);
    if (!hasBinding()) { root.append(el('p', 'Ouvrez ce panneau depuis une demande de votre conversation. Aucune conversation n’est liée.', 'empty')); return; }
    if (error) { const n = el('p', error, 'error'); n.setAttribute('role', 'alert'); root.append(n); }
    if (notice) { const n = el('p', notice, 'notice'); n.setAttribute('role', 'status'); root.append(n); }
    if (secretRetry) root.append(button('J’ai vérifié : autoriser cette réponse', () => { const retry = secretRetry; if (!retry) return; respond(retry.task, retry.request.action, retry.request.text, { ...retry.request, actionId: uuid(), allowSecret: true }); }, mutating || sending));
    if (hidden) return;
    if (!snapshot) { root.append(el('p', 'Chargement…')); return; }
    const tasks = snapshot.tasks.filter(t => t.state === 'open');
    root.append(el('h2', `Mes tâches · ${tasks.length}`), el('p', snapshot.ended ? 'Session terminée' : snapshot.working ? 'L’agent travaille · réponses conservées' : 'L’agent est disponible', 'agent-state'));
    if (!tasks.length) root.append(el('p', 'Aucune action à faire.', 'empty'));
    tasks.forEach(t => root.append(taskCard(t)));
    if (snapshot.pending.length) {
      const section = el('section', undefined, 'pending'); section.append(el('h2', `Réponses enregistrées · ${snapshot.pending.length}`));
      for (const r of snapshot.pending) {
        const status = uncertain.has(r.id) || r.delivery === 'unknown' ? 'Envoi incertain — vérifier le chat' : r.delivery === 'accepted' ? 'Message accepté — attente de l’agent' : 'En attente d’envoi';
        section.append(el('p', `#${r.number} ${r.title} · ${status}`));
      }
      if (backend.canSend()) section.append(button(sending ? 'Envoi…' : 'Envoyer maintenant', deliver, sending || mutating || !pending().length));
      else section.append(el('p', 'L’hôte ne permet pas l’envoi depuis ce panneau. Copiez les réponses dans le chat ; elles restent en attente.'));
      section.append(button('Copier les réponses', async () => {
        const content = formatResponses(snapshot.pending);
        try { await globalThis.navigator.clipboard.writeText(content); notice = 'Réponses copiées. Collez-les dans cette conversation.'; render(); }
        catch { const area = el('textarea'); area.readOnly = true; area.value = content; area.setAttribute('aria-label', 'Réponses à copier manuellement'); section.append(area); area.focus(); area.select(); }
      })); root.append(section);
    }
    for (const previous of snapshot.previous || []) root.append(button(`Récupérer ${previous.count} demande(s) d’une session terminée`, async () => {
      if (mutating || sending) return; mutating = true; mutationEpoch++; error = ''; const gen = generation; render();
      try { const result = await backend.call('human_adopt', { ...binding, fromThreadId: previous.threadId, actionId: uuid() }); if (gen === generation) { snapshot = result; notice = 'Demandes récupérées dans cette conversation.'; } } catch (e) { if (gen === generation) fail(e); }
      finally { mutating = false; render(); if (gen !== generation) void refresh(); }
    }, mutating || sending));
    root.append(button('Actualiser', refresh, reading || mutating || sending));
  }
  render();
  const timer = setInterval(refresh, 2000); timer.unref?.();
  const visibility = () => { if (!doc.hidden) void refresh(); }; doc.addEventListener('visibilitychange', visibility);
  void refresh();
  return {
    refresh,
    bind(next) { if (JSON.stringify(binding?.scope) === JSON.stringify(next?.scope) && binding?.uiToken === next?.uiToken) { void refresh(); return; } generation++; binding = next; snapshot = undefined; error = ''; notice = ''; drafts.clear(); requests.clear(); collapsed.clear(); secretRetry = undefined; render(); void refresh(); },
    destroy() { dead = true; clearInterval(timer); doc.removeEventListener('visibilitychange', visibility); root.replaceChildren(); },
  };
}
