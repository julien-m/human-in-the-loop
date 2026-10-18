import { createServer } from 'node:http';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const demo = `import {mount} from './src/ui.mjs';
document.querySelector('#demo').textContent='DEMO — synthetic data, not a native Codex session';
const tasks=[
 {id:'demo-action',number:1,title:'Approve the staging preview',why:'A human review is needed before release.',done_when:'The preview has been reviewed.',kind:'do',state:'open',revision:0},
 {id:'demo-question',number:2,title:'What should we call this project?',why:'The package needs a public name.',kind:'answer',state:'open',revision:0},
 {id:'demo-choice',number:3,title:'Choose the export format',why:'The export layout depends on your choice.',kind:'choose',options:['PDF','Markdown'],state:'open',revision:0}
];
const snapshot={revision:1,working:true,tasks,pending:[],previous:[]};
mount(document.querySelector('#app'),{canSend:()=>false,call:async(name,args)=>{
 if(name==='human_read')return structuredClone(snapshot);
 if(name==='human_respond'){const task=tasks.find(t=>t.id===args.taskId);task.state=args.action==='reject'?'rejected':'done';const response={id:'demo-response-'+task.number,task_id:task.id,number:task.number,title:task.title,state:task.state,text:args.text||'Done.',delivery:'pending'};snapshot.pending.push(response);return {response,snapshot:structuredClone(snapshot)};}
 throw new Error('Demo only');
}},{scope:'demo-scope',uiToken:'demo-token'});`;
const bundled = await build({ stdin: { contents: demo, resolveDir: process.cwd(), sourcefile: 'demo.mjs' }, bundle: true, write: false, format: 'esm', platform: 'browser' });
const css = await readFile('src/ui.css', 'utf8');
const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Human in the loop — Demo</title><style>${css}#demo{padding:12px;background:#fff5cc;color:#423d20;font:12px system-ui}</style></head><body><aside id="demo"></aside><main id="app"></main><script type="module">${bundled.outputFiles[0].text.replaceAll('</script','<\\/script')}</script></body></html>`;
const server = createServer((req,res) => { if(req.url!=='/') {res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(html); });
server.listen(Number(process.env.PORT || 43187), '127.0.0.1', () => console.log(`Demo: http://127.0.0.1:${server.address().port}`));
