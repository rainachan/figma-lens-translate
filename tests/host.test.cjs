const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup(stored = new Map()) {
  const messages = [], events = {}, positions = [], sizes = [];
  const b = { x: 0, y: 0, width: 200, height: 200 };
  const page = { id: '0:1', name: 'Page', type: 'PAGE', selection: [], on() {}, off() {} };
  const frame = { id: '1:0', name: 'Frame', type: 'FRAME', parent: page, visible: true, absoluteBoundingBox: b, exportAsync: async () => new Uint8Array([1, 2]) };
  const node = (id, text, y, extra = {}) => ({ id, name: 'Text', type: 'TEXT', characters: text, visible: true, parent: frame, absoluteBoundingBox: { x: 0, y, width: 100, height: 20 }, ...extra });
  frame.children = [node('1:2', 'Second', 20), node('1:1', 'First', 0), node('1:3', 'Secret hidden text', 40, { visible: false })];
  page.selection = [frame];
  const nodes = [frame, ...frame.children];
  // Fail immediately if production code attempts ANY document mutation.
  for (const n of nodes) Object.freeze(n); Object.freeze(frame.children);
  const figma = { editorType: 'figma', currentPage: page, viewport: { zoom: 1, bounds: { x: 0, y: 0, width: 1200, height: 800 } }, showUI() {}, ui: { postMessage: x => messages.push(JSON.parse(JSON.stringify(x))), resize: (w, h) => sizes.push([w, h]), reposition: (x, y) => positions.push([x, y]) }, on: (name, cb) => events[name] = cb, clientStorage: { getAsync: async k => stored.get(k), setAsync: async (k, v) => stored.set(k, v) }, getNodeByIdAsync: async id => nodes.find(n => n.id === id) };
  for (const name of ['createText', 'createFrame', 'createRectangle', 'group', 'commitUndo', 'setPluginData']) figma[name] = () => { throw new Error('Write forbidden'); };
  const source = fs.readFileSync(require.resolve('../code.js'), 'utf8');
  const ctx = { figma, __html__: '', setTimeout, clearTimeout, setInterval: cb => { events.viewportPoll = cb; } };
  vm.runInNewContext('"use strict";\n' + source, ctx);
  return { figma, messages, events, stored, frame, page, positions, sizes, ctx };
}
test('selection reads preserve original nodes, hide invisible content and sort geometrically', async () => {
  const h = setup(); const before = h.frame.children.map(n => n.characters);
  await h.figma.ui.onmessage({ type: 'ready' });
  const data = h.messages.find(x => x.type === 'selection');
  assert.deepEqual(data.items.map(x => x.text), ['First', 'Second']); assert.equal(data.canPreview, true);
  assert.deepEqual(h.frame.children.map(n => n.characters), before);
});
test('pin retains selection; unpin follows canvas; duplicate children are not repeated', async () => {
  const h = setup(); h.page.selection = [h.frame, h.frame.children[0]];
  await h.figma.ui.onmessage({ type: 'ready' }); assert.equal(h.messages.at(-1).items.length, 2);
  await h.figma.ui.onmessage({ type: 'pin', pinned: true }); h.page.selection = [];
  await h.figma.ui.onmessage({ type: 'refresh' }); assert.equal(h.messages.at(-1).items.length, 2);
  await h.figma.ui.onmessage({ type: 'pin', pinned: false }); assert.equal(h.messages.at(-1).items.length, 0);
});
test('pin uses the displayed region even if a new canvas selection is still debouncing', async () => {
  const h = setup(); await h.figma.ui.onmessage({ type: 'ready' });
  h.page.selection = [h.frame.children[0]];
  await h.figma.ui.onmessage({ type: 'pin', pinned: true });
  await h.figma.ui.onmessage({ type: 'refresh' });
  assert.deepEqual(h.messages.at(-1).rootIds, ['1:0']);
});
test('preview is local and stale preview requests are ignored', async () => {
  const h = setup(); await h.figma.ui.onmessage({ type: 'ready' }); const version = h.messages.at(-1).version;
  const count = h.messages.length; await h.figma.ui.onmessage({ type: 'preview', version: version - 1 }); assert.equal(h.messages.length, count);
  await h.figma.ui.onmessage({ type: 'preview', version }); assert.equal(h.messages.at(-1).type, 'preview');
  assert.equal(h.frame.children[0].characters, 'Second');
});
test('Save stores keys automatically even from a legacy profile with remember off', async () => {
  const h = setup(); await h.figma.ui.onmessage({ type: 'save-settings', settings: { profiles: { team: { key: 'legacy-configured-key', remember: false }, custom: { key: 'new-configured-key' } } } });
  const value = [...h.stored.values()][0]; assert.equal(value.profiles.team.key, 'legacy-configured-key'); assert.equal(value.profiles.custom.key, 'new-configured-key'); assert.equal(value.profiles.team.remember, true); assert.equal(value.profiles.custom.remember, true);
});
test('remembered keys restore in another file and stale preference saves cannot wipe them', async () => {
  const first = setup();
  const settings = { provider: 'custom', profiles: { custom: { key: 'fake-custom-key', remember: true }, team: { key: 'fake-team-key', remember: true } } };
  await first.figma.ui.onmessage({ type: 'save-settings', settings, requestId: 7 });
  assert.deepEqual(first.messages.at(-1), { type: 'settings-saved', requestId: 7 });
  const second = setup(first.stored);
  await second.figma.ui.onmessage({ type: 'ready' });
  assert.equal(second.messages.find(x => x.type === 'settings').settings.profiles.custom.key, 'fake-custom-key');
  await second.figma.ui.onmessage({ type: 'save-settings', preferencesOnly: true, settings: { ...settings, follow: false, profiles: { custom: { key: '', remember: false } } } });
  await second.figma.ui.onmessage({ type: 'restore-credentials', requestId: 9 });
  assert.equal(second.messages.at(-1).settings.profiles.custom.key, 'fake-custom-key');
  assert.equal(second.messages.at(-1).requestId, 9);
  // Clearing and saving Custom removes only that key, preserving team API.
  await second.figma.ui.onmessage({ type: 'save-settings', profilesToSave: ['custom'], settings: { ...settings, profiles: { custom: { key: '', remember: true }, team: { key: '', remember: false } } } });
  const saved = [...first.stored.values()][0];
  assert.equal(saved.profiles.custom.key, '');
  assert.equal(saved.profiles.team.key, 'fake-team-key');
});
test('storage failures are explicit and sanitized, with no false save confirmation', async () => {
  const h = setup();
  h.figma.clientStorage.setAsync = async () => { throw new Error('private-key-echo'); };
  await h.figma.ui.onmessage({ type: 'save-settings', requestId: 42, settings: { profiles: {} } });
  const failure = h.messages.at(-1);
  assert.equal(failure.type, 'host-error'); assert.equal(failure.action, 'save-settings'); assert.equal(failure.requestId, 42);
  assert.match(failure.message, /could not save/); assert.equal(failure.message.includes('private-key-echo'), false);
  assert.equal(h.messages.some(m => m.type === 'settings-saved'), false);
  h.figma.clientStorage.getAsync = async () => { throw new Error('private-key-echo'); };
  await h.figma.ui.onmessage({ type: 'ready' }); assert.match(h.messages.at(-1).message, /could not load/);
});
test('transparent preview carries its dark canvas backdrop without modifying nodes', async () => {
  const h = setup();
  h.page.backgrounds = [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.1 } }];
  const before = JSON.stringify(h.page.backgrounds);
  await h.figma.ui.onmessage({ type: 'ready' });
  await h.figma.ui.onmessage({ type: 'preview', version: h.messages.at(-1).version });
  assert.equal(h.messages.at(-1).background, 'rgb(26, 26, 26)');
  assert.equal(JSON.stringify(h.page.backgrounds), before);
});
test('mini reader follows selection and viewport without retranslating; settings and fixed position stay still', async () => {
  const h = setup(); await h.figma.ui.onmessage({ type: 'ready' });
  assert.deepEqual(h.positions.at(-1), [112, 12]);
  const count = h.messages.length, moves = h.positions.length;
  h.events.viewportPoll(); assert.equal(h.positions.length, moves);
  h.figma.viewport.zoom = 2; h.events.viewportPoll();
  assert.equal(h.messages.length, count); assert.deepEqual(h.positions.at(-1), [106, 6]);
  await h.figma.ui.onmessage({ type: 'layout', mode: 'settings', follow: true });
  assert.deepEqual(h.sizes.at(-1), [400, 540]);
  const before = h.positions.length; h.figma.viewport.zoom = 1; h.events.viewportPoll();
  assert.equal(h.positions.length, before);
  await h.figma.ui.onmessage({ type: 'layout', mode: 'compact', follow: false });
  assert.deepEqual(h.sizes.at(-1), [320, 420]); assert.equal(h.positions.length, before);
});
test('native list paragraphs survive translation input without changing source characters', async () => {
  const h = setup();
  const characters = '标题\n第一项\n第二项\n子项\n第三项\n\n普通正文';
  const lines = characters.split('\n'); let offset = 0;
  const segments = lines.map((line, i) => {
    const segment = { start: offset, end: offset + line.length + 1, listOptions: { type: [1, 2, 4].includes(i) ? 'ORDERED' : i === 3 ? 'UNORDERED' : 'NONE' }, indentation: i === 3 ? 2 : 1 };
    offset = segment.end; return segment;
  });
  const node = Object.freeze({ id: '2:1', type: 'TEXT', name: 'List', characters, parent: h.page, fontWeight: 600, getStyledTextSegments: () => segments });
  h.page.selection = [node]; await h.figma.ui.onmessage({ type: 'ready' });
  const item = h.messages.find(m => m.type === 'selection').items[0];
  assert.equal(item.text, '标题\n1. 第一项\n2. 第二项\n  • 子项\n3. 第三项\n\n普通正文');
  assert.equal(item.emphasis, true); assert.equal(node.characters, characters);
});

test('layers on one visual row read left to right despite small vertical offsets', () => {
  const { ctx } = setup();
  const item = (id, x, y, height = 20) => ({ id, bounds: { x, y, width: 50, height } });
  const order = ctx.readingOrder([item('value', 200, 0), item('label', 0, 3), item('next', 0, 30), item('tall', 300, 1, 200)]);
  assert.deepEqual(Array.from(order, x => x.id), ['label', 'value', 'tall', 'next']);
});

test('saving drops stored keys of removed providers', async () => {
  const h = setup(new Map([['lens-reader.settings.v1', { profiles: { go: { key: 'old-go-key' }, team: { key: 'team-key' } } }]]));
  await h.figma.ui.onmessage({ type: 'save-settings', preferencesOnly: true, settings: { follow: false, profiles: {} } });
  const saved = [...h.stored.values()][0];
  assert.equal(saved.profiles.go, undefined); assert.equal(saved.profiles.team.key, 'team-key');
});
