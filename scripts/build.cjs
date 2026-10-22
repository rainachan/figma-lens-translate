const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'src/ui.html'), 'utf8');
for (const [marker, file] of [['/* CORE */', 'core.js'], ['/* APP */', 'ui.js'], ['/* STYLE */', 'style.css']]) {
  html = html.replace(marker, () => fs.readFileSync(path.join(root, 'src', file), 'utf8'));
}
html = html.replace(/__LENS_VERSION__/g, require(path.join(root, 'package.json')).version);
fs.writeFileSync(path.join(root, 'ui.html'), html);
console.log('Built Lens plugin UI (' + Buffer.byteLength(html) + ' bytes).');
