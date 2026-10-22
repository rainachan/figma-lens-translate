const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');
const p = { ...C.defaults().profiles.team, endpoint: 'https://gateway.example.com/api', key: 'test-only-secret' };
const items = [{ id: '1:2', text: '设备离线' }, { id: '1:3', text: '重试' }];
test('desktop sandbox messages from outer ancestors reach the reader; unrelated sources are rejected', () => {
  const top = {}; top.parent = top;
  const shim = { parent: top }, network = { parent: shim }, ui = { parent: network };
  const data = { pluginMessage: { type: 'selection', items: [] } };
  for (const source of [network, shim, top]) assert.equal(C.isHostMessage({ source, data }, ui), true);
  for (const source of [null, {}, { parent: top }, ui]) assert.equal(C.isHostMessage({ source, data }, ui), false);
  for (const invalid of [null, {}, { pluginMessage: 'bad' }]) assert.equal(C.isHostMessage({ source: top, data: invalid }, ui), false);
});
test('team API base URLs and complete endpoints normalize without duplicate v1', () => {
  for (const endpoint of ['https://gateway.example/api', 'https://gateway.example/api/v1/', 'https://gateway.example/api/v1/messages']) assert.equal(C.endpointURL({ ...p, endpoint }), 'https://gateway.example/api/v1/messages');
  assert.equal(C.endpointURL({ ...p, endpoint: 'https://example.com/v1', protocol: 'chat' }), 'https://example.com/v1/chat/completions');
  assert.equal(C.endpointURL({ ...p, endpoint: 'http://localhost:9000/v1', protocol: 'responses' }), 'http://localhost:9000/v1/responses');
});
test('rejects credentials in URLs, remote HTTP and malformed auth headers', () => {
  for (const endpoint of ['http://gateway.example', 'https://key@gateway.example', 'https://gateway.example?key=secret', 'file:///etc/passwd']) assert.throws(() => C.endpointURL({ ...p, endpoint }));
  assert.throws(() => C.headers({ ...p, auth: 'custom', header: 'Cookie' }));
  assert.throws(() => C.headers({ ...p, auth: 'custom', header: 'x-key\nInjected' }));
});
test('authentication modes are isolated and secrets are never URL parameters', () => {
  const a = C.request(p, items, 'English', {}, '');
  assert.equal(a.options.headers['x-api-key'], p.key); assert.equal(a.options.redirect, 'error');
  assert.equal(a.url.includes(p.key), false); assert.equal(a.options.body.includes(p.key), false);
  assert.equal(C.headers({ ...p, auth: 'bearer' }).Authorization, 'Bearer ' + p.key);
  assert.equal(C.headers({ ...p, auth: 'custom', header: 'x-team-token' })['x-team-token'], p.key);
  assert.equal(C.headers({ ...p, auth: 'none', key: '' })['x-api-key'], undefined);
});
test('team API request disables thinking and requires structured complete translations', () => {
  const body = JSON.parse(C.request(p, items, 'English', {}, '').options.body);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.tool_choice.name, 'return_translations');
  assert.deepEqual(JSON.parse(body.messages[0].content).items, items);
});
test('all preset models use no thinking', () => {
  for (const provider of ['team']) for (const choice of C.modelChoices[provider]) {
    const profile = C.chooseModel(provider, { ...p, key: 'test-only' }, choice.id);
    const body = JSON.parse(C.request(profile, items, 'English', {}, '').options.body);
    if (profile.protocol === 'responses') assert.deepEqual(body.reasoning, { effort: 'none' });
    else if (choice.id === 'claude-sonnet-5-5') assert.deepEqual(body.thinking, { type: 'between_tools' });
    else assert.deepEqual(body.thinking, { type: 'disabled' });
  }
  const unknown = { ...p, model: 'custom-model', protocol: 'chat' };
  const body = JSON.parse(C.request(unknown, items, 'English', {}, '').options.body);
  assert.equal(body.thinking, undefined); assert.equal(body.reasoning_effort, undefined);
});
test('Luna uses Responses with reasoning off and a strict translation schema', () => {
  const luna = C.chooseModel('team', p, 'gpt-6-luna');
  const request = C.request(luna, items, 'English', {}, '');
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://gateway.example.com/openai/v1/responses');
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(body.store, false);
  assert.equal(body.tool_choice.type, 'function');
  assert.equal(body.tool_choice.name, 'return_translations');
  assert.equal(body.tools[0].strict, true);
  assert.deepEqual(body.tools[0].parameters.required, ['translations']);
  assert.equal(body.tools[0].parameters.additionalProperties, false);
  assert.deepEqual(JSON.parse(body.input[0].content[0].text).items, items);
  assert.equal(body.stream, true);
  assert.equal(body.max_output_tokens, undefined);
  const haiku = C.chooseModel('team', luna, p.model);
  assert.equal(haiku.endpoint, p.endpoint);
  assert.equal(haiku.protocol, 'anthropic');
  assert.equal(haiku.key, p.key);
  const custom = { ...p, endpoint: 'https://example.com/team-gateway/v1' };
  assert.equal(C.chooseModel('team', custom, 'gpt-6-luna').endpoint, custom.endpoint);
});
test('Responses streams require a complete final event before accepting translations', async () => {
  const profile = C.chooseModel('team', p, 'gpt-6-luna');
  const response = { status: 'completed', output_text: JSON.stringify({ translations: items.map(x => ({ ...x, text: 'Translated' })) }) };
  const fixture = text => async () => ({ ok: true, headers: new Map([['content-type', 'text/event-stream']]), text: async () => text });
  const prefix = 'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"partial"}\r\n\r\n';
  const stream = prefix + 'event: response.completed\r\ndata: ' + JSON.stringify({ type: 'response.completed', response }) + '\r\n\r\ndata: [DONE]\r\n\r\n';
  assert.equal((await C.translate(profile, items, 'English', {}, '', undefined, fixture(stream))).length, 2);
  const deltaStream = [
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: response.output_text.slice(0, 24) },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: response.output_text.slice(24) },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: response.output_text },
    { type: 'response.completed', response: { status: 'completed', output: [] } }
  ].map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('');
  assert.equal((await C.translate(profile, items, 'English', {}, '', undefined, fixture(deltaStream))).length, 2);
  const toolStream = [
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', name: 'return_translations', arguments: response.output_text } },
    { type: 'response.completed', response: { status: 'completed', output: [] } }
  ].map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('');
  assert.equal((await C.translate(profile, items, 'English', {}, '', undefined, fixture(toolStream))).length, 2);
  await assert.rejects(C.translate(profile, items, 'English', {}, '', undefined, fixture(prefix)), /ended before/);
  await assert.rejects(C.translate(profile, items, 'English', {}, '', undefined, fixture('data: {"type":"response.failed"}\n\n')), /did not finish/);
});
test('Chat and Responses adapters map outputs into original text order', () => {
  const translations = [{ id: '1:3', text: 'Retry' }, { id: '1:2', text: 'Device offline' }];
  const fixtures = [
    ['chat', { choices: [{ message: { content: JSON.stringify({ translations }) } }] }],
    ['responses', { output: [{ content: [{ type: 'output_text', text: JSON.stringify({ translations }) }] }] }],
    ['anthropic', { content: [{ type: 'tool_use', name: 'return_translations', input: { translations } }] }]
  ];
  for (const [protocol, data] of fixtures) assert.deepEqual(C.validate(C.extract(data, protocol), items), translations.slice().reverse());
  const body = JSON.parse(C.request({ ...p, protocol: 'responses' }, items, 'English', {}, '').options.body);
  assert.equal(body.store, false); assert.equal(body.tools, undefined);
});
test('missing, duplicate, unexpected and empty translations are rejected', () => {
  for (const translations of [[], [{ id: '1:2', text: 'A' }], [{ id: '1:2', text: 'A' }, { id: '1:2', text: 'B' }], [{ id: '1:2', text: 'A' }, { id: 'wrong', text: 'B' }], [{ id: '1:2', text: 'A' }, { id: '1:3', text: '' }]]) assert.throws(() => C.validate({ translations }, items));
  assert.throws(() => C.extract({ stop_reason: 'max_tokens' }, 'anthropic'));
  assert.throws(() => C.extract({ status: 'incomplete' }, 'responses'));
});
test('cache invalidates for text, terminology, language and model changes but not context or layer', () => {
  const key = C.cacheKey(p, 'English', 'one', items[0].text);
  for (const other of [C.cacheKey(p, 'English', 'two', items[0].text), C.cacheKey(p, 'French', 'one', items[0].text), C.cacheKey({ ...p, model: 'other' }, 'English', 'one', items[0].text), C.cacheKey(p, 'English', 'one', 'new text')]) assert.notEqual(other, key);
});
test('only plain English text is kept for an English target', () => {
  for (const text of ['Arm', 'Wi-Fi settings', '{{deviceName}}', 'Tap “Next”.']) assert.equal(C.inTarget(text, 'English'), true);
  for (const text of ['布防', 'Wi-Fi 摄像头', 'Déjà vu', 'Shè zhì', '09:41', 'Arm']) assert.equal(C.inTarget(text, text === 'Arm' ? '简体中文' : 'English'), false);
});
test('saved profiles remember keys by default, including legacy session-only settings', () => {
  const settings = C.defaults(); settings.profiles.team.key = 'team-secret'; settings.profiles.custom.key = 'custom-secret'; settings.profiles.custom.remember = false;
  const saved = C.persistentSettings(settings);
  assert.equal(saved.profiles.team.key, 'team-secret'); assert.equal(saved.profiles.custom.key, 'custom-secret'); assert.equal(saved.profiles.custom.remember, true); assert.equal(settings.profiles.custom.remember, false);
  assert.ok(Object.values(C.defaults().profiles).every(profile => profile.remember));
});
test('cross-file recovery restores saved keys only to the same service and preserves active keys', () => {
  const saved = C.defaults(); saved.profiles.custom.key = 'saved-test-key'; saved.profiles.custom.remember = true;
  const current = C.defaults(); current.provider = 'custom';
  assert.equal(C.restoreCredentials(current, saved).profiles.custom.key, 'saved-test-key');
  assert.equal(current.profiles.custom.key, '');
  saved.profiles.custom.key = '';
  assert.equal(C.restoreCredentials(current, saved).profiles.custom.key, '');
  saved.profiles.custom.key = 'saved-test-key'; current.profiles.custom.endpoint = 'https://different.example/v1';
  assert.equal(C.restoreCredentials(current, saved).profiles.custom.key, '');
  current.profiles.custom.endpoint = saved.profiles.custom.endpoint; current.profiles.custom.key = 'session-test-key';
  assert.equal(C.restoreCredentials(current, saved).profiles.custom.key, 'session-test-key');
  assert.equal(C.restoreCredentials(current, saved).profiles.team.key, '');
});
test('service errors tell users how to recover without displaying upstream content', async () => {
  for (const [status, pattern] of [[401, /key/], [403, /allowed/], [413, /smaller/], [429, /quota/], [502, /network/], [503, /unavailable/], [504, /timed out/]]) {
    await assert.rejects(C.translate(p, items, 'English', {}, '', undefined, async () => ({ ok: false, status, json: async () => ({ error: 'private-key-echo' }) })), error => pattern.test(error.message) && !error.message.includes('private-key-echo'));
  }
});
test('legacy Zen selection falls back to team API without moving credentials into another provider', () => {
  const settings = C.mergeSettings({ provider: 'zen', profiles: { zen: { key: 'old-zen-secret', remember: true }, team: { key: 'existing-team-secret', model: 'existing-model' } } });
  assert.equal(settings.provider, 'team');
  assert.equal(settings.profiles.zen, undefined);
  assert.equal(settings.profiles.team.key, 'existing-team-secret');
  assert.equal(settings.profiles.team.model, 'existing-model');
  assert.equal(settings.profiles.custom.key, '');
});
test('translation fetch handles structured results and does not expose upstream errors', async () => {
  const translated = await C.translate(p, items, 'English', {}, '', undefined, async () => ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'return_translations', input: { translations: items.map(x => ({ ...x, text: 'Translated' })) } }] }) }));
  assert.equal(translated.length, 2);
  await assert.rejects(C.translate(p, items, 'English', {}, '', undefined, async () => ({ ok: false, status: 401, text: async () => 'echoed-secret' })), error => error.message.includes('key') && !error.message.includes('secret'));
});
test('abort propagates to provider fetch', async () => {
  const ac = new AbortController(); ac.abort();
  await assert.rejects(C.translate(p, items, 'English', {}, '', ac.signal, async (_, options) => { assert.equal(options.signal.aborted, true); throw new DOMException('Aborted', 'AbortError'); }), { name: 'AbortError' });
});
test('batching preserves long text, IDs and order', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: String(i), text: 'A'.repeat(400) }));
  const groups = C.batches(many); assert.deepEqual(groups.flat(), many); assert.ok(groups.every(g => g.length <= 24 && g.reduce((s, x) => s + x.text.length, 0) <= 6500));
});

test('only language-free text skips the model, while word and paragraph structure stay intact', () => {
  for (const text of ['09:41', '01’53”', '1,234.50', '100%', '１２３', '—', '🌍', '1.\n2.']) assert.equal(C.keepOriginal(text), true);
  for (const text of ['', '   ', '1 min', '1 分钟', 'Déjà vu', '漢字', '{{deviceName}}']) assert.equal(C.keepOriginal(text), false);
  const long = { id: 'long', text: 'First paragraph\n\nSecond paragraph '.repeat(100) };
  const items = [...Array.from({ length: 12 }, (_, i) => ({ id: String(i), text: 'Text ' + i })), long];
  const groups = C.batches(items, 2400, 6);
  assert.deepEqual(groups.flat(), items); assert.ok(groups.every(group => group.length <= 6));
  assert.equal(groups.at(-1)[0], long);
});

test('a saved OpenCode Go selection falls back to team API and drops the Go profile', () => {
  const settings = C.mergeSettings({ provider: 'go', profiles: { go: { key: 'old-go-secret' }, team: { key: 'team-secret' } } });
  assert.equal(settings.provider, 'team'); assert.equal(settings.profiles.go, undefined); assert.equal(settings.profiles.team.key, 'team-secret');
});
test('the team preset ships without a service URL or key', () => {
  assert.equal(C.defaults().profiles.team.endpoint, ''); assert.equal(C.defaults().profiles.team.key, '');
  assert.equal(C.mergeSettings({ provider: 'retired', profiles: { retired: { endpoint: 'https://old.example.com/api', key: 'old' } } }).profiles.team.key, '');
});

test('Sonnet 5.5 turns thinking off with between_tools and uses auto tool choice with a strict schema', () => {
  const sonnet = C.chooseModel('team', p, 'claude-sonnet-5-5');
  const body = JSON.parse(C.request(sonnet, items, 'English', {}, '').options.body);
  assert.deepEqual(body.thinking, { type: 'between_tools' });
  assert.deepEqual(body.tool_choice, { type: 'auto' });
  assert.equal(body.tools[0].strict, true);
  assert.match(body.system, /return_translations/);
  const haiku = JSON.parse(C.request(p, items, 'English', {}, '').options.body);
  assert.deepEqual(haiku.tool_choice, { type: 'tool', name: 'return_translations' }); assert.equal(haiku.tools[0].strict, undefined);
});
