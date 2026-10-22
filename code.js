// Document access is read-only: no node setters, create/clone/remove, pluginData or relaunchData.
const MINI_SIZE = { width: 320, height: 420 };
figma.showUI(__html__, { ...MINI_SIZE, title: 'Lens', themeColors: true });
const SETTINGS_KEY = 'lens-reader.settings.v1';
const PROVIDERS = ['team', 'custom'];
let pinned = false, pinnedNodes = [], snapshot = null, serial = 0, fingerprint = '', timer;
let pageSubscription = null;
let layoutMode = 'compact', followSelection = true, lastPlacement = '';
let storageWrites = Promise.resolve();
function send(message) { figma.ui.postMessage(message); }
function placeFloatingReader(force) {
  if (figma.editorType === 'dev' || layoutMode !== 'compact' || !followSelection || !snapshot) return;
  const boxes = snapshot.items.map(item => item.bounds).filter(Boolean);
  if (!boxes.length || !figma.viewport || typeof figma.ui.reposition !== 'function') return;
  const view = figma.viewport.bounds, zoom = figma.viewport.zoom;
  const left = Math.min(...boxes.map(b => b.x)), top = Math.min(...boxes.map(b => b.y));
  const right = Math.max(...boxes.map(b => b.x + b.width));
  const gap = 12 / zoom, width = MINI_SIZE.width / zoom, height = (MINI_SIZE.height + 40) / zoom;
  let x = right + gap;
  if (x + width > view.x + view.width - gap) x = left - width - gap;
  x = Math.max(view.x + gap, Math.min(x, view.x + view.width - width - gap));
  const y = Math.max(view.y + gap, Math.min(top, view.y + view.height - height - gap));
  const placement = JSON.stringify([x, y, zoom, view]);
  if (!force && placement === lastPlacement) return;
  lastPlacement = placement;
  figma.ui.reposition(x, y);
}
function visible(node) {
  for (let n = node; n && n.type !== 'DOCUMENT'; n = n.parent) if (n.visible === false) return false;
  return true;
}
function box(node) {
  const b = node.absoluteBoundingBox;
  return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
}
function previewBackground(node) {
  // A transparent export loses its canvas backdrop (e.g. white annotation text).
  // Reconstruct solid ancestor fills locally without changing document nodes.
  const ancestors = []; let rgb = [1, 1, 1];
  for (let n = node.parent; n && n.type !== 'DOCUMENT'; n = n.parent) ancestors.push(n);
  for (const n of ancestors.reverse()) {
    const paints = n.type === 'PAGE' ? n.backgrounds : n.fills;
    if (!Array.isArray(paints)) continue;
    for (const p of paints.slice().reverse()) {
      if (p.type !== 'SOLID' || p.visible === false) continue;
      const a = (p.opacity === undefined ? 1 : p.opacity) * (n.opacity === undefined ? 1 : n.opacity);
      rgb = [p.color.r, p.color.g, p.color.b].map((c, i) => c * a + rgb[i] * (1 - a));
    }
  }
  return 'rgb(' + rgb.map(c => Math.round(c * 255)).join(', ') + ')';
}
function readableText(node) {
  const text = node.characters;
  // Figma stores native bullets/numbering as paragraph styles, not characters.
  // Materialize them only in the read-only copy sent to the reader/translator.
  if (typeof node.getStyledTextSegments !== 'function') return text;
  let segments;
  try { segments = node.getStyledTextSegments(['listOptions', 'indentation']); } catch (_) { return text; }
  if (!segments.some(s => s.listOptions && s.listOptions.type !== 'NONE')) return text;
  let offset = 0;
  const counters = [];
  return text.split('\n').map(line => {
    const segment = segments.find(s => s.start <= offset && s.end > offset);
    offset += line.length + 1;
    const type = segment && segment.listOptions && segment.listOptions.type;
    if (!line.trim() || !['ORDERED', 'UNORDERED'].includes(type)) { counters.length = 0; return line; }
    const depth = Math.max(0, Math.min(10, (segment.indentation || 1) - 1));
    counters.length = depth + 1;
    counters[depth] = type === 'ORDERED' ? (counters[depth] || 0) + 1 : 0;
    return '  '.repeat(depth) + (type === 'ORDERED' ? counters[depth] + '.' : '•') + ' ' + line;
  }).join('\n');
}
function readingOrder(items) {
  // Rows first, then left to right. Layers whose tops differ by less than half
  // a line height read as one row, so a label and its value keep their order.
  const top = item => item.bounds ? item.bounds.y : 0, left = item => item.bounds ? item.bounds.x : 0;
  const rows = [];
  for (const item of items.slice().sort((a, b) => top(a) - top(b) || left(a) - left(b))) {
    const row = rows[rows.length - 1], height = item.bounds ? item.bounds.height : 0;
    if (row && top(item) - row.top < Math.min(row.height, height) / 2) { row.items.push(item); row.height = Math.min(row.height, height); }
    else rows.push({ top: top(item), height, items: [item] });
  }
  return rows.flatMap(row => row.items.sort((a, b) => left(a) - left(b)));
}
function collect(roots) {
  const seen = new Set(), items = [], stack = roots.slice().reverse(), rootIds = new Set(roots.map(n => n.id));
  let visited = 0, chars = 0, omitted = 0;
  while (stack.length && visited++ < 20000) {
    const node = stack.pop();
    // Hidden parents never push their children, so only roots need the ancestor walk.
    if (!node || node.removed || seen.has(node.id) || (rootIds.has(node.id) ? !visible(node) : node.visible === false)) continue;
    seen.add(node.id);
    if (node.type === 'TEXT' && node.characters.trim()) {
      if (items.length >= 160 || chars + node.characters.length > 60000 || node.characters.length > 12000) { omitted++; continue; }
      const text = readableText(node);
      if (chars + text.length > 60000 || text.length > 12000) { omitted++; continue; }
      chars += text.length;
      const emphasis = typeof node.fontWeight === 'number' ? node.fontWeight >= 600 : Boolean(node.fontName && /bold|semibold|demibold/i.test(node.fontName.style || ''));
      items.push({ id: node.id, text, emphasis, name: node.name, group: node.parent && node.parent.name || '', bounds: box(node) });
    } else if ('children' in node) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return { items: readingOrder(items), limited: omitted > 0 || stack.length > 0, omitted };
}
function readSelection(force) {
  const roots = (pinned ? pinnedNodes : figma.currentPage.selection).filter(n => !n.removed);
  const data = collect(roots);
  const context = { page: figma.currentPage.name, regions: roots.map(n => n.name) };
  const next = JSON.stringify([data, context, roots.map(n => n.id)]);
  if (!force && fingerprint === next) return;
  fingerprint = next;
  snapshot = { type: 'selection', version: ++serial, title: roots.length === 1 ? roots[0].name : roots.length + ' selected regions', context, items: data.items, limited: data.limited, omitted: data.omitted, rootIds: roots.map(n => n.id), canPreview: roots.length === 1 && typeof roots[0].exportAsync === 'function' };
  send(snapshot);
  placeFloatingReader(false);
}
function schedule(delay = 200) { clearTimeout(timer); timer = setTimeout(() => readSelection(false), delay); }
// Edits wait for a longer pause so typing in a selected layer does not request
// a translation for every intermediate word.
const scheduleAfterEdit = () => schedule(900);
function listenPage() {
  if (pageSubscription) pageSubscription.off('nodechange', scheduleAfterEdit);
  pageSubscription = figma.currentPage;
  pageSubscription.on('nodechange', scheduleAfterEdit);
}
figma.on('selectionchange', () => { if (!pinned) schedule(); });
figma.on('currentpagechange', () => { pinned = false; pinnedNodes = []; send({ type: 'pin', pinned }); listenPage(); schedule(); });
listenPage();
// Figma Design exposes no viewport-change event. Only move the UI when bounds
// change; this poll does not read document text or send translation requests.
setInterval(() => { try { placeFloatingReader(false); } catch (_) {} }, 400);
figma.ui.onmessage = async message => {
  try {
    if (message.type === 'ready') {
      const settings = await figma.clientStorage.getAsync(SETTINGS_KEY);
      send({ type: 'settings', settings, editor: figma.editorType });
      readSelection(true);
    } else if (message.type === 'restore-credentials') {
      const settings = await figma.clientStorage.getAsync(SETTINGS_KEY);
      send({ type: 'stored-settings', settings, requestId: message.requestId });
    } else if (message.type === 'refresh') readSelection(true);
    else if (message.type === 'pin') {
      if (message.pinned && snapshot) {
        const current = snapshot, pageId = figma.currentPage.id;
        const nodes = await Promise.all(current.rootIds.map(id => figma.getNodeByIdAsync(id)));
        if (snapshot !== current || figma.currentPage.id !== pageId) return;
        pinnedNodes = nodes.filter(n => n && !n.removed);
        pinned = pinnedNodes.length > 0;
      } else { pinned = false; pinnedNodes = []; }
      send({ type: 'pin', pinned });
      readSelection(false);
    } else if (message.type === 'save-settings') {
      const clean = JSON.parse(JSON.stringify(message.settings));
      const write = storageWrites.catch(() => {}).then(async () => {
        const stored = await figma.clientStorage.getAsync(SETTINGS_KEY) || {};
        // Keep only current providers; keys saved under retired provider IDs are dropped.
        const profiles = Object.fromEntries(Object.entries(stored.profiles || {}).filter(([id]) => PROVIDERS.includes(id)));
        const ids = message.preferencesOnly ? [] : message.profilesToSave || Object.keys(clean.profiles || {});
        for (const id of ids) {
          if (!PROVIDERS.includes(id) || !(clean.profiles && clean.profiles[id])) continue;
          profiles[id] = clean.profiles[id];
          // Save always stores the configured key. Saving an empty key clears it.
          profiles[id].remember = true;
        }
        clean.profiles = profiles;
        await figma.clientStorage.setAsync(SETTINGS_KEY, clean);
      });
      storageWrites = write;
      await write;
      send({ type: 'settings-saved', requestId: message.requestId });
    } else if (message.type === 'preview') {
      const current = snapshot;
      if (!current || message.version !== current.version || !current.canPreview) return;
      const node = await figma.getNodeByIdAsync(current.rootIds[0]);
      if (!node || node.removed) throw new Error('The selected region no longer exists.');
      const bounds = box(node);
      if (!bounds || !bounds.width || !bounds.height) throw new Error('This region cannot be previewed.');
      const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: Math.min(2, 1600 / Math.max(bounds.width, bounds.height)) }, useAbsoluteBounds: true });
      if (snapshot && snapshot.version === current.version) send({ type: 'preview', version: current.version, bounds, bytes, background: previewBackground(node) });
    } else if (message.type === 'open-releases') {
      // Fixed destination: the UI cannot ask the host to open arbitrary URLs.
      figma.openExternal('https://github.com/rainachan/figma-lens-translate/releases/latest');
    } else if (message.type === 'layout') {
      layoutMode = ['compact', 'reader', 'mirror', 'settings'].includes(message.mode) ? message.mode : 'compact';
      followSelection = message.follow !== false;
      if (figma.editorType !== 'dev') {
        figma.ui.resize(layoutMode === 'compact' ? MINI_SIZE.width : layoutMode === 'mirror' ? 760 : 400, layoutMode === 'compact' ? MINI_SIZE.height : layoutMode === 'settings' ? 540 : 660);
        placeFloatingReader(true);
      }
    }
  } catch (_) {
    // Never relay raw exceptions: provider responses and user configuration can contain secrets.
    const errors = { preview: 'Preview unavailable for this region. Try selecting its parent frame.', 'save-settings': 'Figma could not save your settings. Your key is still available in this session. Retry saving before switching files.', ready: 'Figma could not load your saved settings. Reopen the plugin or enter your key in Settings.', 'restore-credentials': 'Figma could not restore your saved key. Reopen the plugin or enter it in Settings.' };
    send({ type: 'host-error', action: message.type, requestId: message.requestId, version: message.version, message: errors[message.type] || 'Figma could not complete this action. Please retry.' });
  }
};
