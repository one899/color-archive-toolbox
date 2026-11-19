import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FastbootSession,isFastbootVariableName} from '../site/fastboot.mjs';
import {buildPalette,normalizeHex,parseAppearance} from '../site/appearance.mjs';
import {parseFastbootCommand} from '../site/adb-console.mjs';
import {createToolboxUsbMock} from './fixtures/toolbox-usb.mjs';
import {audit} from '../tools/audit-public.mjs';
import {startServer} from '../tools/serve.mjs';

test('published source stays inside the release allowlist',async()=>{await audit();});
test('FB and FBD queries stream protocol output without image methods',async t=>{
 const f=createToolboxUsbMock();const s=await FastbootSession.connect(f.usb);t.after(()=>s.close());
 assert.equal(s.flash,undefined);assert.equal(s.flashPartition,undefined);
 assert.equal((await s.readState()).mode,'bootloader');
 assert.equal(await s.getVariable('product'),'qa-phone');
 const parts=[];await s.getVariable('all',{onInfo:(text,tag)=>parts.push([tag,text])});
 assert.deepEqual(parts,[['INFO','product: qa-phone'],['TEXT','slot '],['TEXT','detail'+String.fromCharCode(10)]]);
 await assert.rejects(s.getVariable('missing'),{code:'deviceRejected'});assert.equal(s.ready,true);
 assert.equal(await s.setActiveSlot('b'),'b');
 assert.deepEqual(await s.reboot('fastbootd'),{acknowledged:true});
 assert.equal((await s.readState()).mode,'fastbootd');
});
test('invalid/pre-aborted queries send no USB; running cancellation invalidates the connection',async t=>{
 const f=createToolboxUsbMock();const s=await FastbootSession.connect(f.usb);t.after(()=>s.close());
 for(const name of ['','x y','a'.repeat(58),'x\n','x;reboot']){
  assert.equal(isFastbootVariableName(name),false);await assert.rejects(s.getVariable(name),{code:'invalidVariable'});
 }
 const pre=new AbortController();pre.abort();await assert.rejects(s.getVariable('product',{signal:pre.signal}),{name:'AbortError'});
 assert.equal(f.state.fastbootCommands.length,0);assert.equal(s.ready,true);
 f.state.holdVariable=true;const controller=new AbortController();let partial=false;
 const pending=s.getVariable('all',{signal:controller.signal,onInfo(){partial=true;controller.abort();}});
 await assert.rejects(pending,{name:'AbortError'});assert.equal(partial,true);assert.equal(s.ready,false);
});
test('appearance parsing and independent theme/accent settings remain public',()=>{
 assert.equal(normalizeHex('#fA0'),'#ffaa00');assert.equal(parseAppearance('bad').scheme,'system');
 for(const mode of ['dark','light']){
  const first=buildPalette(mode,'#ba604c','#7a2cd0');const second=buildPalette(mode,'#ba604c','#00ffff');
  assert.equal(first['--bg'],second['--bg']);assert.notEqual(first['--accent-fill'],second['--accent-fill']);
 }
 assert.equal(parseFastbootCommand('fastboot getvar product').name,'product');
 assert.equal(parseFastbootCommand('erase userdata'),null);
});
test('local server serves the device workbench as a static app', async t => {
  const server = await startServer({port: 0});
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('permissions-policy'), 'usb=(self)');
  assert.match(page.headers.get('content-security-policy'), /connect-src 'none'/);
  const html = await page.text();
  const views = [...html.matchAll(/data-view="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(views, ['device', 'terminal', 'activity']);
  for (const path of ['/package.json', '/.env', '/%2e%2e%2fpackage.json', '/unknown.mjs', '/api/example']) {
    assert.equal((await fetch(origin + path)).status, 404);
  }
  assert.equal((await fetch(origin + '/api/example', {method: 'POST'})).status, 405);
});
