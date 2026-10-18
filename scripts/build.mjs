import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp, rm, lstat } from 'node:fs/promises';

const previous = await lstat('dist').catch(e => { if (e.code !== 'ENOENT') throw e; });
if (previous?.isSymbolicLink()) throw new Error('Refuse a symlinked build directory');
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const name of ['server', 'hook']) await build({ entryPoints: [`src/${name}.mjs`], outfile: `dist/${name}.mjs`, bundle: true, platform: 'node', target: 'node22', format: 'esm', banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } });
const app = await build({ entryPoints: ['src/app.mjs'], bundle: true, write: false, platform: 'browser', target: 'es2022', format: 'esm', minify: true });
const css = await readFile('src/ui.css', 'utf8');
await writeFile('dist/tasks.html', `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Human in the loop</title><style>${css}</style></head><body><main id="app"></main><script type="module">${app.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`);
for (const pkg of ['@modelcontextprotocol/core', '@modelcontextprotocol/server', '@modelcontextprotocol/ext-apps', 'zod']) {
  const dir = `node_modules/${pkg}`;
  const { readdir } = await import('node:fs/promises');
  for (const file of await readdir(dir)) if (/^(license|notice|copyright)/i.test(file)) {
    await mkdir(`dist/licenses/${pkg}`, { recursive: true });
    await cp(`${dir}/${file}`, `dist/licenses/${pkg}/${file}`);
  }
}
console.log('Built server, hook and self-contained task panel. Native rendering is not asserted.');
