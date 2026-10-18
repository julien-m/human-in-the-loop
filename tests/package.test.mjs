import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('packaging excludes stale files from a previous marketplace', { timeout: 2000 }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'human-loop-package-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['scripts', 'hooks', 'dist/licenses', 'artifacts/marketplace/plugins/human-in-the-loop']) mkdirSync(join(dir, name), { recursive: true });
  for (const file of ['package.json', 'plugin.json', 'mcp.json', 'README.md', 'LICENSE', 'NOTICE', 'hooks/hooks.json', 'scripts/package.mjs']) copyFileSync(file, join(dir, file));
  for (const file of ['server.mjs', 'hook.mjs', 'tasks.html']) writeFileSync(join(dir, 'dist', file), 'synthetic fixture');
  const stale = join(dir, 'artifacts/marketplace/plugins/human-in-the-loop/private-data.txt');
  writeFileSync(stale, 'synthetic fixture, never real user data');
  execFileSync(process.execPath, ['scripts/package.mjs'], { cwd: dir, timeout: 1500 });
  assert.equal(existsSync(stale), false);
  assert(existsSync(join(dir, 'artifacts/marketplace/plugins/human-in-the-loop/dist/server.mjs')));
  assert.equal(existsSync(join(dir, 'artifacts/marketplace/plugins/human-in-the-loop/package.json')), false);
});
