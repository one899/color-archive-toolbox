import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {relative,resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const allowed=new Set([
 '.gitignore','LICENSE','README.md','package.json','package-lock.json',
 'site/index.html','site/_headers','site/toolbox.css','site/appearance.mjs','site/app.mjs','site/adb.mjs','site/adb-console.mjs','site/fastboot.mjs',
 'site/assets/logo.png','site/assets/mark.svg','site/vendor/web-adb.mjs','site/vendor/web-adb.LICENSE.txt',
 'tools/build.mjs','tools/serve.mjs','tools/audit-public.mjs',
 'tests/public.test.mjs','tests/web-adb.test.mjs','tests/fixtures/toolbox-usb.mjs',
]);
async function files(dir=''){
 const output=[];
 for(const entry of await readdir(resolve(root,dir),{withFileTypes:true})){
  if(!dir&&['.git','node_modules','dist'].includes(entry.name))continue;
  if(entry.isSymbolicLink())throw new Error('Release must not contain symlinks');
  const name=(dir?dir+'/':'')+entry.name;
  if(entry.isDirectory())output.push(...await files(name));else output.push(name);
 }
 return output;
}
export async function audit(){
 const names=await files();
 for(const name of names){
  if(!allowed.has(name))throw new Error('Unexpected release file: '+name);
  if(name.endsWith('.png'))continue;
  const text=await readFile(resolve(root,name),'utf8');
  if(/gh[pousr]_[A-Za-z0-9_]{25,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:[A-Z]:[\\/](?:Users|color-archive|FastbootFlasher))/i.test(text))throw new Error('Credential or local path in '+name);
  if(/\b(?:[a-z0-9-]+[.])*colorarchive[.]cloud\b/i.test(text)||/\b[A-Z_]*(?:SESSION[_]SECRET|PRIVATE[_]MAPPING)\b/.test(text))throw new Error('Private configuration reference in '+name);
  if(name.startsWith('site/')&&!name.startsWith('site/vendor/')){
   if(/\b(?:account|login|logout|captcha)\w*\b|\blog-(?:in|out)\b|\/api\/|账号|登录|验证码/i.test(text))throw new Error('Authentication UI or endpoint in '+name);
   if(/runWorkflowPhase|preflightWorkflowImages|createWorkflow|downloadChunks|flashPartition|createLogicalPartition|deleteLogicalPartition|resizeLogicalPartition|flash-workflow|sparse\.mjs|f01|f14|f51/.test(text))throw new Error('Private implementation in '+name);
  }
 }
 const transport=await readFile(resolve(root,'site/fastboot.mjs'),'utf8');
 if(/download:|flash:|erase:|create-logical-partition:|delete-logical-partition:|resize-logical-partition:/.test(transport))throw new Error('Image or layout write command in public transport');
 return {files:names.length};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log('Public release audit passed:',await audit());
