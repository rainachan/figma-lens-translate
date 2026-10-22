/* global LensCore */
'use strict';
const C = LensCore, $ = id => document.getElementById(id);
const S = { settings: C.defaults(), selection: null, translations: new Map(), cache: new Map(), request: 0, controller: null, pinned: false, mirror: false, busy: false, previewURL: null, draft: null, connectionController: null, editor: 'figma', outcome: '', progressTimer: null, progressStarted: 0, connectionTimer: null, saveSerial: 0, pendingSave: null, saveTimer: null, restoreRequest: 0, initialized: false };
function send(message) { parent.postMessage({ pluginMessage: message }, '*'); }
function profile() { return S.settings.profiles[S.settings.provider]; }
function ready() { const p = profile(); return Boolean(p.endpoint && p.model && (p.auth === 'none' || p.key.trim())); }
function el(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
function notice(text, error = false) {
  $('notice-text').textContent = text; $('notice').hidden = !text; $('notice').className = error ? 'error' : '';
  $('notice').setAttribute('role', error ? 'alert' : 'status');
  $('notice-actions').hidden = !error;
  $('retry').hidden = !ready() || !S.selection?.items.length;
}
function status(text, kind = '', detail = '') { $('status').textContent = text; $('status').title = detail; $('status-dot').className = 'status-dot ' + kind; }
function updateProgress() {
  if (!S.busy) return;
  const elapsed = Math.floor((Date.now() - S.progressStarted) / 1000), total = S.selection?.items.length || 0;
  $('progress-label').textContent = 'Translating ' + S.translations.size + ' / ' + total;
  $('progress-detail').textContent = elapsed + 's · ' + (elapsed >= 20 ? 'Still waiting…' : 'Waiting for the model…');
}
function busy(value) {
  S.busy = value; $('cancel').hidden = !value; $('translate').hidden = value;
  $('translate').disabled = value || !S.selection || !S.selection.items.length;
  $('translation-progress').hidden = !value; $('reading-list').setAttribute('aria-busy', String(value));
  clearInterval(S.progressTimer); S.progressTimer = null;
  if (value) { S.progressStarted = Date.now(); updateProgress(); S.progressTimer = setInterval(updateProgress, 1000); }
}
function stop() { S.request++; if (S.controller) S.controller.abort(); S.controller = null; busy(false); }
function persist() { send({ type: 'save-settings', settings: S.settings, preferencesOnly: true, requestId: ++S.saveSerial }); }
function settingsChrome() {
  $('language').value = S.settings.target; $('auto').checked = S.settings.auto; $('original').checked = S.settings.original;
  $('reading-list').classList.toggle('no-source', !S.settings.original);
  $('provider-label').textContent = C.presets[S.settings.provider].label + ' · ' + (profile().model || 'Choose a model');
}
function applyLayout() {
  const settings = !$('settings').hidden, compact = S.settings.compact && !settings;
  if (compact) { S.mirror = false; clearPreview(); }
  document.body.classList.toggle('compact', compact);
  document.body.classList.toggle('mirror-open', S.mirror && !settings);
  $('mirror-panel').hidden = !S.mirror;
  $('mirror-toggle').setAttribute('aria-pressed', String(S.mirror));
  $('compact-toggle').hidden = settings;
  $('compact-toggle').textContent = S.settings.compact ? 'Expand' : 'Mini';
  $('follow-toggle').setAttribute('aria-pressed', String(S.settings.follow));
  send({ type: 'layout', mode: settings ? 'settings' : compact ? 'compact' : S.mirror ? 'mirror' : 'reader', follow: S.settings.follow });
}
function render() {
  const list = $('reading-list'); list.replaceChildren();
  const items = S.selection && S.selection.items || [];
  $('translate').disabled = S.busy || !items.length;
  $('copy-all').disabled = !items.length || items.some(item => !S.translations.has(item.id));
  $('selection-title').textContent = S.selection && S.selection.rootIds.length ? S.selection.title : 'Nothing selected';
  $('pin').disabled = !S.selection || !S.selection.rootIds.length;
  if (!items.length) {
    const hasSelection = S.selection && S.selection.rootIds.length;
    const empty = el('div', 'empty'); empty.append(el('h1', '', hasSelection ? 'No text layers found' : 'Select text to translate'), el('p', '', hasSelection ? 'Select a text layer, frame or component.' : 'You can also select a frame or component.'));
    if (!ready()) { const b = el('button', 'primary', 'Set up'); b.onclick = openSettings; empty.append(b); }
    list.append(empty); return;
  }
  items.forEach((item, index) => {
    const row = el('article', 'text-row' + (item.emphasis ? ' emphasis' : '')); row.dataset.id = item.id;
    const meta = el('div', 'row-meta'); meta.append(el('span', 'number', String(index + 1).padStart(2, '0')), el('span', '', item.group || item.name));
    const translated = S.translations.get(item.id);
    const pending = S.outcome === 'error' ? 'Not translated' : S.outcome === 'stopped' ? 'Stopped' : 'Not translated yet';
    const translation = el('p', 'translation' + (translated ? '' : S.busy ? ' pending loading' : ' pending'), translated || (S.busy ? '' : pending));
    if (!translated && S.busy) translation.setAttribute('aria-label', 'Translation pending');
    row.append(meta, el('p', 'source', item.text), translation);
    if (translated) { const b = el('button', 'quiet copy', 'Copy'); b.onclick = () => copy(translated, b); row.append(b); }
    row.addEventListener('mouseenter', () => highlight(item.id)); list.append(row);
  });
  list.classList.toggle('no-source', !S.settings.original);
}
async function copy(text, button) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else throw new Error('fallback');
  } catch (_) {
    const t = el('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.append(t); t.select(); const ok = document.execCommand('copy'); t.remove();
    if (!ok) { button.textContent = 'Select to copy'; return; }
  }
  button.textContent = 'Copied'; setTimeout(() => button.textContent = 'Copy', 1600);
}
async function translateSelection(force = false) {
  stop(); const current = S.selection;
  if (!current || !current.items.length) { status('Select a region'); return; }
  if (!ready()) { notice('Add your API key in Settings.', true); status('API key needed', 'error'); return; }
  S.outcome = '';
  notice(current.limited ? 'Selection too large. Select a smaller region for all text.' : '');
  const id = S.request, p = { ...profile() }, target = S.settings.target, glossary = S.settings.glossary;
  const keyOf = text => C.cacheKey(p, target, glossary, text);
  S.translations.clear();
  // Identical labels are requested once and filled into every matching layer.
  const missing = new Map();
  for (const item of current.items) {
    const key = keyOf(item.text);
    if (C.keepOriginal(item.text) || C.inTarget(item.text, target)) S.translations.set(item.id, item.text);
    else if (!force && S.cache.has(key)) S.translations.set(item.id, S.cache.get(key));
    else if (!missing.has(item.text)) missing.set(item.text, item);
  }
  if (!missing.size) { render(); status(current.items.length + ' texts · ready', 'good'); return; }
  const fill = (text, translated) => { for (const item of current.items) if (item.text === text) S.translations.set(item.id, translated); };
  const controller = new AbortController(); S.controller = controller; busy(true); render();
  const started = Date.now(), groups = C.batches([...missing.values()], 2400, 6);
  let next = 0, failure = null, firstResult = null;
  const active = () => id === S.request && current === S.selection && !controller.signal.aborted;
  // Two bounded workers return complete text layers as soon as each small
  // batch finishes. Out-of-order responses still render in source order.
  const worker = async () => {
    while (active() && !failure && next < groups.length) {
      const batch = groups[next++];
      // The batch already carries its own text; nearby adds only the other layers.
      const own = new Set(batch.map(x => x.text));
      const context = { ...current.context, nearby: current.items.filter(x => !own.has(x.text)).slice(0, 20).map(x => x.text).join('\n').slice(0, 2500) };
      try {
        const rows = await C.translate(p, batch, target, context, glossary, controller.signal);
        if (!active() || failure) return;
        if (firstResult === null) firstResult = Date.now() - started;
        rows.forEach((r, i) => { fill(batch[i].text, r.text); S.cache.set(keyOf(batch[i].text), r.text); });
        while (S.cache.size > 1600) S.cache.delete(S.cache.keys().next().value);
        render(); updateProgress();
        status('Translating ' + S.translations.size + ' / ' + current.items.length, 'busy');
      } catch (error) {
        if (active() && !failure) { failure = error; controller.abort(); }
      }
    }
  };
  try {
    status('Translating ' + S.translations.size + ' / ' + current.items.length, 'busy');
    await Promise.all(Array.from({ length: Math.min(2, groups.length) }, worker));
    if (id !== S.request || current !== S.selection) return;
    if (failure) throw failure;
    const total = ((Date.now() - started) / 1000).toFixed(1);
    status(current.items.length + ' texts · ' + total + 's', 'good', 'First translation: ' + (firstResult / 1000).toFixed(1) + 's · Total: ' + total + 's');
  } catch (error) {
    if (id !== S.request) return;
    S.outcome = 'error'; notice(error.name === 'AbortError' ? 'The connection was interrupted. Retry this selection.' : error.message, true); status(S.translations.size ? S.translations.size + ' translated · failed' : 'Translation failed', 'error');
  } finally { if (id === S.request) { S.controller = null; busy(false); render(); const active = $('hotspots').querySelector('.active'); if (active) highlight(active.dataset.id); } }
}
function sameContent(a, b) {
  if (!a || !b || JSON.stringify([a.rootIds, a.context, a.limited]) !== JSON.stringify([b.rootIds, b.context, b.limited])) return false;
  const texts = s => s.items.map(x => x.id + '\u0000' + x.text).sort().join('\u0001');
  return texts(a) === texts(b);
}
function clearPreview() {
  if (S.previewURL) URL.revokeObjectURL(S.previewURL);
  S.previewURL = null; $('preview-image').removeAttribute('src'); $('image-wrap').hidden = true; $('hotspots').replaceChildren();
  $('mirror-detail').replaceChildren(el('p', '', 'Hover over text to see its translation.'));
}
function requestPreview() {
  clearPreview();
  if (!S.selection || !S.selection.canPreview) { $('mirror-hint').textContent = 'Select a frame to preview.'; $('mirror-hint').hidden = false; return; }
  $('mirror-hint').textContent = 'Loading preview…'; $('mirror-hint').hidden = false;
  send({ type: 'preview', version: S.selection.version });
}
function preview(message) {
  if (!S.mirror || !S.selection || message.version !== S.selection.version) return;
  clearPreview(); S.previewURL = URL.createObjectURL(new Blob([new Uint8Array(message.bytes)], { type: 'image/png' }));
  $('image-wrap').style.backgroundColor = message.background || 'var(--soft)';
  $('preview-image').src = S.previewURL; $('image-wrap').hidden = false; $('mirror-hint').hidden = true;
  const frame = message.bounds;
  for (const [index, item] of S.selection.items.entries()) {
    const b = item.bounds; if (!b) continue;
    const left = Math.max(b.x, frame.x), top = Math.max(b.y, frame.y), right = Math.min(b.x + b.width, frame.x + frame.width), bottom = Math.min(b.y + b.height, frame.y + frame.height);
    if (right <= left || bottom <= top) continue;
    const hotspot = el('button', 'hotspot'); hotspot.dataset.id = item.id; hotspot.setAttribute('aria-label', 'Text ' + (index + 1) + ': ' + item.text.slice(0, 90));
    Object.assign(hotspot.style, { left: (left - frame.x) / frame.width * 100 + '%', top: (top - frame.y) / frame.height * 100 + '%', width: (right - left) / frame.width * 100 + '%', height: (bottom - top) / frame.height * 100 + '%' });
    hotspot.onmouseenter = hotspot.onfocus = hotspot.onclick = () => highlight(item.id); $('hotspots').append(hotspot);
  }
}
function highlight(id) {
  if (!S.mirror) return;
  document.querySelectorAll('[data-id]').forEach(x => x.classList.toggle('active', x.dataset.id === id));
  const item = S.selection && S.selection.items.find(x => x.id === id); if (!item) return;
  $('mirror-detail').replaceChildren(el('span', 'eyebrow', S.settings.target.toUpperCase()), el('p', '', S.translations.get(id) || 'Translate this selection to read it here.'), el('small', '', item.text));
}
function saveDraftProfile() {
  if (!S.draft) return;
  const previous = S.draft.profiles[S.draft.provider];
  const next = { ...previous, endpoint: $('endpoint').value.trim(), protocol: $('protocol').value, auth: $('auth').value, header: $('auth-header').value.trim(), key: $('api-key').value.trim(), remember: true, model: selectedModelId() };
  if (JSON.stringify(previous) !== JSON.stringify(next)) S.editedProfiles.add(S.draft.provider);
  S.draft.profiles[S.draft.provider] = next;
  S.draft.glossary = $('glossary').value;
}
function populateProfile() {
  const p = S.draft.profiles[S.draft.provider];
  for (const [id, key] of [['endpoint', 'endpoint'], ['protocol', 'protocol'], ['auth', 'auth'], ['auth-header', 'header'], ['api-key', 'key']]) $(id).value = p[key] || '';
  $('provider').value = S.draft.provider; $('api-key').type = 'password'; $('key-toggle').textContent = 'Show';
  populateModels(p); $('connection-result').hidden = true;
  authUI();
}
function authUI() { $('header-row').hidden = $('auth').value !== 'custom'; $('key-row').hidden = $('auth').value === 'none'; }
function openSettings() {
  stop(); status('Settings'); S.editedProfiles = new Set(); S.draft = JSON.parse(JSON.stringify(S.settings)); $('glossary').value = S.draft.glossary; populateProfile(); $('reader').hidden = true; $('settings').hidden = false; $('settings-open').hidden = true;
  applyLayout();
}
function closeSettings() {
  if (S.pendingSave) return;
  cancelConnection();
  $('reader').hidden = false; $('settings').hidden = true; $('settings-open').hidden = false; S.draft = null; settingsChrome();
  applyLayout();
  if (S.settings.auto) translateSelection(); else { render(); status('Ready to translate'); }
}
function connectionResult(text, error = false, pending = false) { $('connection-result').textContent = text; $('connection-result').hidden = false; $('connection-result').className = error ? 'error' : pending ? 'pending' : ''; $('connection-result').setAttribute('role', error ? 'alert' : 'status'); $('connection-result').setAttribute('aria-busy', String(pending)); }
function saving(value) {
  for (const control of $('settings-form').querySelectorAll('input, select, textarea, button')) control.disabled = value;
  $('settings-close').disabled = value; $('save-settings').textContent = value ? 'Saving…' : 'Save';
}
function saveFailed(message) {
  clearTimeout(S.saveTimer); S.saveTimer = null; S.pendingSave = null; saving(false);
  connectionResult(message, true);
}
function selectedModelId() { return $('model').value === '__custom' ? $('custom-model').value.trim() : $('model').value; }
function populateModels(p) {
  const choices = C.modelChoices[S.draft.provider] || [];
  const options = choices.map(choice => { const option = el('option', '', choice.label); option.value = choice.id; return option; });
  const custom = el('option', '', 'Custom model…'); custom.value = '__custom'; options.push(custom);
  $('model').replaceChildren(...options);
  $('custom-model').value = p.model || '';
  $('model').value = choices.some(choice => choice.id === p.model) ? p.model : '__custom';
  modelChoiceUI(false);
}
function modelChoiceUI(applyProtocol) {
  const custom = $('model').value === '__custom';
  $('custom-model-row').hidden = !custom; $('custom-model').required = custom;
  $('advanced-settings').open = custom || S.draft.provider === 'custom';
  const choice = (C.modelChoices[S.draft.provider] || []).find(choice => choice.id === $('model').value);
  if (choice && applyProtocol) {
    const profile = C.chooseModel(S.draft.provider, { endpoint: $('endpoint').value }, choice.id);
    $('protocol').value = profile.protocol; $('endpoint').value = profile.endpoint;
    if (profile.auth) { $('auth').value = profile.auth; authUI(); }
  }
}
function cancelConnection() {
  if (S.connectionController) S.connectionController.abort();
  S.connectionController = null; clearInterval(S.connectionTimer); S.connectionTimer = null; $('test').disabled = false; $('connection-result').hidden = true;
}
async function connectionAction() {
  saveDraftProfile(); const p = { ...S.draft.profiles[S.draft.provider] };
  cancelConnection();
  const controller = new AbortController(); S.connectionController = controller;
  $('test').disabled = true;
  const started = Date.now();
  const tick = () => connectionResult('Translating sample… ' + Math.floor((Date.now() - started) / 1000) + 's', false, true);
  tick(); S.connectionTimer = setInterval(tick, 1000);
  try {
    const rows = await C.translate(p, [{ id: 'sample', text: '设备离线时，无法查看实时画面。' }], 'English', { purpose: 'Connection test. No design content.' }, '', controller.signal);
    if (controller !== S.connectionController) return;
    connectionResult('Connected · ' + ((Date.now() - started) / 1000).toFixed(1) + 's · ' + rows[0].text);
  } catch (error) { if (controller === S.connectionController && error.name !== 'AbortError') connectionResult(error.message, true); }
  finally { if (controller === S.connectionController) { S.connectionController = null; clearInterval(S.connectionTimer); S.connectionTimer = null; $('test').disabled = false; } }
}
$('notice-settings').onclick = openSettings;
$('retry').onclick = () => translateSelection(false);
$('settings-open').onclick = $('empty-settings').onclick = openSettings;
$('settings-close').onclick = closeSettings;
$('compact-toggle').onclick = () => { S.settings.compact = !S.settings.compact; persist(); applyLayout(); };
$('follow-toggle').onclick = () => { S.settings.follow = !S.settings.follow; persist(); applyLayout(); };
$('provider').onchange = () => { saveDraftProfile(); cancelConnection(); S.draft.provider = $('provider').value; populateProfile(); };
$('auth').onchange = () => { cancelConnection(); authUI(); };
$('protocol').onchange = $('api-key').oninput = $('auth-header').oninput = cancelConnection;
$('model').onchange = () => { cancelConnection(); modelChoiceUI(true); };
$('custom-model').oninput = $('endpoint').oninput = cancelConnection;
$('endpoint').onchange = () => {
  const old = S.draft.profiles[S.draft.provider].endpoint;
  // Only a switch between two services clears the key; filling in a first URL keeps it.
  let changed = Boolean(old); try { changed = changed && new URL(old).origin !== new URL($('endpoint').value).origin; } catch (_) {}
  if (changed) { $('api-key').value = ''; connectionResult('Endpoint changed. Enter a key for this service.'); }
};
$('key-toggle').onclick = () => { const show = $('api-key').type === 'password'; $('api-key').type = show ? 'text' : 'password'; $('key-toggle').textContent = show ? 'Hide' : 'Show'; };
$('test').onclick = connectionAction;
$('settings-form').onsubmit = event => {
  event.preventDefault(); if (S.pendingSave) return; saveDraftProfile();
  try { C.endpointURL(S.draft.profiles[S.draft.provider]); } catch (error) { connectionResult(error.message, true); return; }
  cancelConnection();
  const requestId = ++S.saveSerial;
  S.pendingSave = { requestId, settings: JSON.parse(JSON.stringify(S.draft)) }; saving(true);
  connectionResult('Saving settings…', false, true);
  S.saveTimer = setTimeout(() => saveFailed('Figma did not confirm the save. Keep this window open and retry before switching files.'), 8000);
  send({ type: 'save-settings', settings: S.pendingSave.settings, profilesToSave: [...new Set([...S.editedProfiles, S.draft.provider])], requestId });
};
$('language').onchange = () => { S.settings.target = $('language').value; persist(); stop(); S.translations.clear(); if (S.settings.auto) translateSelection(); else { render(); status('Ready to translate'); } };
$('original').onchange = () => { S.settings.original = $('original').checked; settingsChrome(); persist(); };
$('auto').onchange = () => { S.settings.auto = $('auto').checked; persist(); if (S.settings.auto) translateSelection(); else { stop(); render(); status('Manual translation'); } };
// Translate reuses the cache; once everything is shown, it re-translates on request.
$('translate').onclick = () => { if (!ready()) openSettings(); else translateSelection(Boolean(S.selection?.items.length) && S.selection.items.every(item => S.translations.has(item.id))); };
$('copy-all').onclick = () => copy(S.selection.items.map(item => S.translations.get(item.id)).join('\n'), $('copy-all'));
$('cancel').onclick = () => { stop(); S.outcome = 'stopped'; render(); status('Stopped · results kept'); };
$('pin').onclick = () => send({ type: 'pin', pinned: !S.pinned });
$('mirror-toggle').onclick = () => { S.mirror = !S.mirror; applyLayout(); if (S.mirror) requestPreview(); else clearPreview(); };
$('preview-refresh').onclick = () => send({ type: 'refresh' });
window.addEventListener('message', event => {
  if (!C.isHostMessage(event, window)) return;
  const m = event.data.pluginMessage;
  if (m.type === 'settings') { S.settings = C.mergeSettings(m.settings); S.initialized = true; S.editor = m.editor; settingsChrome(); applyLayout(); if (!ready()) notice('Add your key in Settings to start reading.'); }
  else if (m.type === 'settings-saved' && S.pendingSave && m.requestId === S.pendingSave.requestId) {
    clearTimeout(S.saveTimer); S.saveTimer = null; S.settings = S.pendingSave.settings; S.pendingSave = null; saving(false); closeSettings();
  } else if (m.type === 'stored-settings' && m.requestId === S.restoreRequest && !S.draft && !ready()) {
    S.settings = C.restoreCredentials(S.settings, m.settings);
    if (ready()) { settingsChrome(); notice(''); if (S.settings.auto) translateSelection(); else { render(); status('Ready to translate'); } }
  }
  else if (m.type === 'selection' && sameContent(S.selection, m)) {
    // Only positions changed (auto layout, a collaborator moving layers): keep
    // translations and any request in flight; refresh order and preview only.
    Object.assign(S.selection, m); render(); if (S.mirror) requestPreview();
  } else if (m.type === 'selection') {
    stop(); S.outcome = ''; S.selection = m; S.translations.clear(); render();
    notice(m.limited ? 'Large selection: showing a limited set of visible text. Select a smaller region to read everything.' : !ready() ? 'Connect your translation service in Settings to start reading.' : '');
    if (S.mirror) requestPreview();
    if (S.settings.auto && $('settings').hidden) translateSelection(); else status(m.items.length ? m.items.length + ' texts selected' : 'Select a region');
  } else if (m.type === 'pin') { S.pinned = m.pinned; $('pin').setAttribute('aria-pressed', String(m.pinned)); $('pin').textContent = m.pinned ? 'Unpin' : 'Pin'; }
  else if (m.type === 'preview') preview(m);
  else if (m.type === 'host-error') {
    if (m.action === 'preview') { if (S.selection && m.version === S.selection.version) { $('mirror-hint').textContent = m.message; $('mirror-hint').hidden = false; } }
    else if (m.action === 'save-settings' && S.pendingSave && m.requestId === S.pendingSave.requestId) saveFailed(m.message);
    else if (S.draft) connectionResult(m.message, true);
    else { notice(m.message, true); status('Action failed', 'error'); }
  }
});
function restoreOnFocus() { if (S.initialized && !S.draft && !ready()) send({ type: 'restore-credentials', requestId: ++S.restoreRequest }); }
window.addEventListener('focus', restoreOnFocus);
document.addEventListener('visibilitychange', () => { if (!document.hidden) restoreOnFocus(); });
window.addEventListener('pagehide', () => { stop(); clearPreview(); cancelConnection(); clearTimeout(S.saveTimer); });
send({ type: 'ready' });
