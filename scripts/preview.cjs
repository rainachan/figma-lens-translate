// Isolated UI test harness. This server is not used by the installed Figma plugin.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const dictionary = {
  '设备离线时，无法查看实时画面。': 'Live view is unavailable while the device is offline.',
  '设备离线': 'Device offline',
  '检查设备电源和网络连接，然后重试。': 'Check the device’s power and network connection, then try again.',
  '重新连接': 'Reconnect',
  '通知设置': 'Notification settings',
  '关闭推送后，事件仍会保存在历史记录中。': 'When push notifications are off, events are still saved in history.'
};
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-api-key, anthropic-version, authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'POST' && ['/v1/messages', '/slow/v1/messages', '/failure/v1/messages'].includes(url.pathname)) {
    if (url.pathname === '/failure/v1/messages') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    if (url.pathname === '/slow/v1/messages') await new Promise(resolve => setTimeout(resolve, 6000));
    let raw = ''; for await (const part of req) { raw += part; if (raw.length > 250000) { res.writeHead(413); res.end(); return; } }
    try {
      const body = JSON.parse(raw); const items = JSON.parse(body.messages[0].content).items;
      if (items.some(x => !dictionary[x.text])) throw new Error('Unknown fixture');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'tool_use', name: 'return_translations', input: { translations: items.map(x => ({ id: x.id, text: dictionary[x.text] })) } }] }));
    } catch (_) { res.writeHead(400); res.end('{}'); }
    return;
  }
  if (url.pathname === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-translator' }] })); return; }
  const routes = { '/': 'dev/preview.html', '/ui.html': 'ui.html' };
  const file = routes[url.pathname];
  if (!file) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(path.join(root, file)));
}).listen(Number(process.env.LENS_PREVIEW_PORT || 49173), '127.0.0.1', () => console.log('Lens isolated UI preview ready (synthetic sample; simulated translator)'));
