import { App } from '@modelcontextprotocol/ext-apps';
import { mount, decodeToolResult } from './ui.mjs';

const root = document.getElementById('app');
const app = new App({ name: 'Human in the loop', version: '0.1.0' }, {});
let panel, initialBinding;
function bindingFrom(result) {
  const scope = result?.structuredContent?.scope;
  const uiToken = result?._meta?.uiToken;
  return scope && uiToken ? { scope, uiToken } : undefined;
}
app.ontoolresult = result => {
  const binding = bindingFrom(result);
  if (binding) { initialBinding = binding; panel?.bind(binding); }
};
try {
  await app.connect();
  panel = mount(root, {
    canSend: () => Boolean(app.getHostCapabilities()?.message?.text),
    async call(name, args) {
      return decodeToolResult(await app.callServerTool({ name, arguments: args }, { timeout: 15000, maxTotalTimeout: 15000 }));
    },
    async send(text) {
      const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] }, { timeout: 15000, maxTotalTimeout: 15000 });
      if (result.isError) throw new Error('L’hôte a refusé le message');
    },
  }, initialBinding);
} catch {
  root.textContent = 'Human in the loop — connexion à l’hôte indisponible. Rouvrez le panneau depuis la conversation.';
}
window.addEventListener('pagehide', () => panel?.destroy(), { once: true });
