import { mkdir, copyFile, readdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (pkg.name !== 'human-in-the-loop') throw new Error('Run from the plugin root');
const root = 'artifacts/marketplace', target = `${root}/plugins/human-in-the-loop`;
const artifacts = await lstat('artifacts').catch(e => { if (e.code !== 'ENOENT') throw e; });
if (artifacts?.isSymbolicLink()) throw new Error('Refuse a symlinked artifacts directory');
await mkdir('artifacts', { recursive: true });
await rm(root, { recursive: true, force: true });
// Explicit files only: never copy the source checkout, local state, transcripts or caches.
const files = ['plugin.json', 'mcp.json', 'hooks/hooks.json', 'README.md', 'LICENSE', 'NOTICE', 'dist/server.mjs', 'dist/hook.mjs', 'dist/tasks.html'];
async function licenseFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) await licenseFiles(file); else files.push(file);
  }
}
await licenseFiles('dist/licenses');
for (const file of files) { await mkdir(join(target, file, '..'), { recursive: true }); await copyFile(file, join(target, file)); }
await mkdir(`${root}/.agents/plugins`, { recursive: true });
await writeFile(`${root}/.agents/plugins/marketplace.json`, JSON.stringify({ name: 'human-in-the-loop-local', interface: { displayName: 'Human in the loop' }, plugins: [{ name: pkg.name, source: { source: 'local', path: './plugins/human-in-the-loop' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }, null, 2) + '\n');
console.log('Clean local marketplace: artifacts/marketplace');
