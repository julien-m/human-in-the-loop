import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const started = Date.now();
async function run(args) {
  const remaining = 300000 - (Date.now() - started);
  assert(remaining > 0, 'check command exceeded its five-minute budget');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', detached: process.platform !== 'win32' });
    const timer = setTimeout(() => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} reject(new Error('check_timeout')); }, remaining);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`exit ${code}: ${args.join(' ')}`)); });
  });
}
await run(['scripts/build.mjs']);
await run(['--test', '--test-timeout=10000', ...(await readdir('tests')).filter(n => n.endsWith('.test.mjs')).map(n => `tests/${n}`)]);
const roots = ['src', 'tests', 'scripts', 'hooks', 'docs', 'dist', '.github'];
const forbidden = [/\/(?:Users|home)\/[a-zA-Z0-9_-]+\//, /(?:sk-ant-|github_pat_|ghp_)[A-Za-z0-9_-]{25,}/, /BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/];
async function scan(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await scan(file);
    else {
      const value = await readFile(file, 'utf8');
      assert(!forbidden.some(pattern => pattern.test(value)), `private content detected in ${file}`);
    }
  }
}
for (const root of roots) await scan(root);
for (const file of ['README.md', 'plugin.json', 'mcp.json', 'package.json', 'package-lock.json', '.gitignore', 'LICENSE', 'NOTICE']) {
  const value = await readFile(file, 'utf8');
  assert(!forbidden.some(pattern => pattern.test(value)), `private content detected in ${file}`);
}
console.log('check: full suite, build and public-content scan passed');
