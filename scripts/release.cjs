// Usage: npm run release -- <x.y.z> "What changed"
// Commit code changes first. This bumps the version, tests, builds, checks for
// private service details, commits, pushes and publishes the GitHub release.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.join(__dirname, '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
const fail = message => { console.error('✖ ' + message); process.exit(1); };

const [version, notes] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || '') || !notes) fail('Usage: npm run release -- <x.y.z> "What changed"');
if (run('git', ['status', '--porcelain'], { quiet: true }).trim()) fail('Commit or discard your changes first.');
const pkgPath = path.join(root, 'package.json'), pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
if (!newer(version, pkg.version)) fail('Version must be newer than ' + pkg.version + '.');

pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
run('npm', ['test', '--silent']);
run('node', ['scripts/build.cjs']);

// Public repo: never ship private service names, hosts or anything key-like.
// Private terms live in .release-blocklist (one regex per line, not committed).
const blocklist = path.join(root, '.release-blocklist');
if (!fs.existsSync(blocklist)) { run('git', ['checkout', '--', 'package.json', 'ui.html']); fail('Missing .release-blocklist; refusing to publish without the private-term check.'); }
const terms = fs.readFileSync(blocklist, 'utf8').split('\n').map(x => x.trim()).filter(Boolean);
const banned = new RegExp(terms.concat('\\bsk-[A-Za-z0-9]{12,}').join('|'), 'i');
const files = run('git', ['ls-files'], { quiet: true }).trim().split('\n').concat('ui.html');
const hits = [...new Set(files)].filter(file => banned.test(fs.readFileSync(path.join(root, file), 'utf8')));
if (hits.length) { run('git', ['checkout', '--', 'package.json', 'ui.html']); fail('Private details found in: ' + hits.join(', ')); }

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-release-')), folder = path.join(stage, 'lens-translate');
fs.mkdirSync(folder);
for (const file of ['manifest.json', 'code.js', 'ui.html', 'README.md']) fs.copyFileSync(path.join(root, file), path.join(folder, file));
run('zip', ['-qr', 'lens-translate.zip', 'lens-translate'], { cwd: stage });
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const zip = path.join(root, 'dist', 'lens-translate.zip');
fs.copyFileSync(path.join(stage, 'lens-translate.zip'), zip);

run('git', ['commit', '-qam', 'Release v' + version + '\n\n' + notes]);
run('git', ['push', '-q']);
run('gh', ['release', 'create', 'v' + version, zip, '--title', 'Lens Translate ' + version, '--notes', notes]);
console.log('✔ Released v' + version);
