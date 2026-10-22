const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../src/core.js');
function setup(translate) {
  class Element {
    constructor() { this.children = []; this.attributes = {}; this.style = {}; this.dataset = {}; this.value = ''; this.checked = false; this.hidden = false; this.textContent = ''; this.disabled = false; this.classList = { toggle() {} }; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }
  const elements = new Map([...fs.readFileSync(require.resolve('../src/ui.html'), 'utf8').matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  elements.get('settings').hidden = true;
  const events = {}, timers = new Map(), intervals = new Map(), sent = [];
  let timerId = 0;
  const parent = { postMessage: data => sent.push(data.pluginMessage) }; parent.parent = parent;
  const document = { getElementById: id => elements.get(id), createElement: () => new Element(), body: new Element(), querySelectorAll: () => [], addEventListener: (name, fn) => { events[name] = fn; } };
  const window = { parent, addEventListener: (name, fn) => { events[name] = fn; } };
  const context = vm.createContext({ LensCore: { ...C, translate: translate || C.translate }, document, window, parent, console, AbortController, URL, Blob, Date, setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id), setInterval: fn => { intervals.set(++timerId, fn); return timerId; }, clearInterval: id => intervals.delete(id) });
  vm.runInContext(fs.readFileSync(require.resolve('../src/ui.js'), 'utf8'), context);
  const run = source => vm.runInContext(source, context);
  const message = data => events.message({ source: parent, data: { pluginMessage: data } });
  run("S.settings.profiles.team.key = 'test-only'; S.settings.profiles.team.endpoint = 'https://gateway.example.com/api'; S.initialized = true; S.selection = { title: 'Fixture', rootIds: ['fixture'], context: {}, items: Array.from({length: 30}, (_, i) => ({id: String(i), text: '文本 ' + i})) };");
  return { elements, events, sent, run, message, timers, intervals };
}
test('small parallel batches render early in source order and never exceed two in flight', async () => {
  const requests = []; let active = 0, peak = 0;
  const h = setup(async (_, items) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => requests.push({ items, resolve })); active--;
    return items.map(x => ({ id: x.id, text: 'Translated ' + x.id }));
  });
  const pending = h.run('translateSelection()');
  assert.equal(requests.length, 2);
  assert.equal(h.elements.get('translation-progress').hidden, false);
  assert.equal(h.elements.get('reading-list').attributes['aria-busy'], 'true');
  assert.ok(requests[0].items.length < 24);
  requests[1].resolve(); await new Promise(setImmediate);
  assert.equal(h.run('S.translations.size'), 6);
  assert.equal(h.elements.get('translation-progress').hidden, false);
  assert.equal(requests.length, 3);
  assert.deepEqual(h.elements.get('reading-list').children.map(row => row.dataset.id), Array.from({ length: 30 }, (_, i) => String(i)));
  assert.match(h.elements.get('progress-label').textContent, /6 \/ 30/);
  requests[0].resolve(); await new Promise(setImmediate);
  for (let i = 2; i < requests.length; i++) { requests[i].resolve(); await new Promise(setImmediate); }
  await pending;
  assert.equal(peak, 2); assert.equal(h.run('S.translations.size'), 30);
  assert.equal(h.elements.get('translation-progress').hidden, true);
  assert.equal(h.intervals.size, 0);
  assert.match(h.elements.get('status').textContent, /30 texts · [\d.]+s/);
  assert.match(h.elements.get('status').title, /First translation:/);
});
test('a failed batch cancels its sibling, stops queued work and retries only missing text', async () => {
  const requests = []; let retry = false;
  const h = setup(async (_, items, target, context, glossary, signal) => {
    if (retry) { assert.ok(items.every(item => Number(item.id) >= 6)); return items.map(x => ({ id: x.id, text: 'Translated ' + x.id })); }
    await new Promise((resolve, reject) => {
      requests.push({ items, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    return items.map(x => ({ id: x.id, text: 'Translated ' + x.id }));
  });
  const pending = h.run('translateSelection()');
  requests[0].resolve(); await new Promise(setImmediate);
  requests[2].reject(new Error('The service is rate-limited or out of quota. Wait, then retry.'));
  await pending;
  assert.equal(requests.length, 3); assert.equal(requests[1].signal.aborted, true);
  assert.equal(h.run('S.translations.size'), 6);
  assert.equal(h.elements.get('translation-progress').hidden, true);
  assert.equal(h.elements.get('notice').attributes.role, 'alert');
  assert.match(h.elements.get('notice-text').textContent, /rate-limited/);
  assert.equal(h.elements.get('retry').hidden, false);
  retry = true; await h.elements.get('retry').onclick();
  assert.equal(h.elements.get('notice').hidden, true);
  assert.equal(h.run('S.translations.size'), 30);
});
test('stopping cancels both workers and late responses cannot overwrite the stopped state', async () => {
  const requests = [];
  const h = setup(async (_, items, target, context, glossary, signal) => {
    await new Promise(resolve => requests.push({ resolve, signal }));
    return items.map(x => ({ ...x, text: 'Late' }));
  });
  const pending = h.run('translateSelection()');
  h.elements.get('cancel').onclick();
  requests.forEach(request => { assert.equal(request.signal.aborted, true); request.resolve(); });
  await pending;
  assert.equal(requests.length, 2);
  assert.equal(h.intervals.size, 0); assert.equal(h.elements.get('translation-progress').hidden, true);
  assert.match(h.elements.get('status').textContent, /Stopped/);
  assert.equal(h.run('S.translations.size'), 0);
});
test('switching selections ignores old parallel responses without clearing the new translation', async () => {
  const old = [];
  const h = setup(async (_, items) => {
    if (items[0].id !== 'new') await new Promise(resolve => old.push(resolve));
    return items.map(x => ({ ...x, text: x.id === 'new' ? 'New translation' : 'Old translation' }));
  });
  const pending = h.run('translateSelection()');
  h.run("stop(); S.selection = { title: 'New', rootIds: ['new'], context: {}, items: [{id: 'new', text: '新的选区'}] }");
  await h.run('translateSelection()'); old.forEach(resolve => resolve()); await pending;
  assert.equal(h.run('S.translations.size'), 1);
  assert.equal(h.run("S.translations.get('new')"), 'New translation');
  assert.equal(h.elements.get('translation-progress').hidden, true);
});
test('numbers and time stamps appear immediately without requesting translation or altering words', async () => {
  const sent = [];
  const h = setup(async (_, items) => { sent.push(...items); return items.map(x => ({ ...x, text: 'Translated' })); });
  h.run("S.selection.items = [{id:'time',text:'09:41'}, {id:'number',text:'1,234.50'}, {id:'text',text:'2 minutes ago'}, {id:'cn',text:'设备离线'}]");
  const pending = h.run('translateSelection()');
  assert.equal(h.run("S.translations.get('time')"), '09:41');
  assert.equal(h.run("S.translations.get('number')"), '1,234.50');
  await pending;
  assert.deepEqual(sent.map(x => x.id), ['cn']);
  assert.equal(h.run("S.translations.get('text')"), '2 minutes ago');
  sent.length = 0; h.run("S.selection.items = [{id:'time',text:'09:41'}, {id:'symbol',text:'—'}]");
  await h.run('translateSelection(true)');
  assert.equal(sent.length, 0); assert.equal(h.run('S.translations.size'), 2);
  assert.match(h.elements.get('status').textContent, /ready/);
});
test('settings close only after matching save confirmation; errors and missing acknowledgements remain visible', async () => {
  const h = setup(); h.run('S.settings.auto = false; openSettings()');
  const submit = () => h.elements.get('settings-form').onsubmit({ preventDefault() {} });
  submit();
  const request = h.sent.findLast(x => x.type === 'save-settings');
  assert.equal(h.elements.get('settings').hidden, false);
  h.message({ type: 'settings-saved', requestId: request.requestId - 1 });
  assert.equal(h.elements.get('settings').hidden, false);
  h.message({ type: 'host-error', action: 'save-settings', requestId: request.requestId, message: 'Could not save. Retry.' });
  assert.equal(h.elements.get('settings').hidden, false);
  assert.match(h.elements.get('connection-result').textContent, /Could not save/);
  assert.equal(h.elements.get('connection-result').attributes.role, 'alert');
  assert.equal(h.elements.get('save-settings').disabled, false);
  submit(); [...h.timers.values()][0]();
  assert.match(h.elements.get('connection-result').textContent, /did not confirm/);
  submit(); h.message({ type: 'settings-saved', requestId: h.sent.findLast(x => x.type === 'save-settings').requestId });
  assert.equal(h.elements.get('settings').hidden, true);
});

test('repeated labels are requested once and reused across selections and contexts', async () => {
  const sent = [];
  const h = setup(async (_, items, target, context) => { sent.push({ items, context }); return items.map(x => ({ id: x.id, text: 'T:' + x.text })); });
  h.run("S.selection.items = [{id:'a',text:'取消'}, {id:'b',text:'确定'}, {id:'c',text:'取消'}]");
  await h.run('translateSelection()');
  assert.deepEqual(sent.flatMap(x => x.items.map(i => i.text)), ['取消', '确定']);
  assert.equal(sent[0].context.nearby, '');
  assert.equal(h.run("S.translations.get('c')"), 'T:取消');
  sent.length = 0;
  h.run("S.selection = { title: 'Child', rootIds: ['c'], context: { regions: ['Other'] }, items: [{id:'c',text:'取消'}] }");
  await h.run('translateSelection()');
  assert.equal(sent.length, 0); assert.equal(h.run("S.translations.get('c')"), 'T:取消');
  await h.elements.get('translate').onclick();
  assert.equal(sent.length, 1);
});
test('moving layers updates the selection without cancelling the translation in flight', async () => {
  const requests = [];
  const h = setup(async (_, items, target, context, glossary, signal) => { await new Promise(resolve => requests.push({ resolve, signal })); return items.map(x => ({ id: x.id, text: 'Done' })); });
  const original = { type: 'selection', version: 1, title: 'F', rootIds: ['f'], context: { page: 'P' }, limited: false, items: [{ id: 'a', text: '一', bounds: { x: 0, y: 0, width: 1, height: 1 } }, { id: 'b', text: '二', bounds: { x: 0, y: 10, width: 1, height: 1 } }] };
  h.message(original);
  assert.equal(requests.length, 1);
  h.message({ ...original, version: 2, items: [{ ...original.items[1], bounds: { x: 0, y: -10, width: 1, height: 1 } }, original.items[0]] });
  assert.equal(requests[0].signal.aborted, false); assert.equal(requests.length, 1);
  assert.equal(h.run('S.selection.version'), 2);
  requests[0].resolve(); await new Promise(setImmediate);
  assert.equal(h.run('S.translations.size'), 2);
  h.message({ ...original, version: 3, items: [original.items[0], { ...original.items[1], text: '三' }] });
  assert.equal(requests.length, 2);
});
