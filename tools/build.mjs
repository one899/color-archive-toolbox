import { build } from 'esbuild';
import { readFile, rm, mkdir, cp, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { audit } from './audit-public.mjs';
const root = new URL('../', import.meta.url);
await audit();
// Clear generated files so removed modules and maps cannot survive a rebuild.
await rm(new URL('dist', root), { recursive: true, force: true });
const entries = ['app','appearance','adb','adb-console','fastboot'];
const result = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: entries.map(name=>'site/'+name+'.mjs'),
  outdir:'dist',outExtension:{'.js':'.mjs'},
  bundle:false,format:'esm',platform:'browser',target:'chrome115',minify:true,
  sourcemap:true,sourcesContent:true,legalComments:'inline',metafile:true,
});
for(const name of Object.keys(result.metafile.inputs)) if(!name.split(String.fromCharCode(92)).join('/').startsWith('site/')) throw new Error('Unexpected build input');
await mkdir(new URL('dist/vendor/',root),{recursive:true});
await cp(new URL('site/assets/',root),new URL('dist/assets/',root),{recursive:true});
for(const name of ['index.html','_headers']) await cp(new URL('site/'+name,root),new URL('dist/'+name,root));
for(const name of ['web-adb.mjs','web-adb.LICENSE.txt']) await cp(new URL('site/vendor/'+name,root),new URL('dist/vendor/'+name,root));
await build({absWorkingDir:fileURLToPath(root),entryPoints:['site/toolbox.css'],outfile:'dist/toolbox.css',minify:true,sourcemap:true,sourcesContent:true});
for(const name of await readdir(new URL('dist/',root))) if(name.endsWith('.map')){
 const map=JSON.parse(await readFile(new URL('dist/'+name,root),'utf8'));
 if(map.sources.some(name=>!/^\.\.\/site\/[^/]+\.(mjs|css)$/.test(name))) throw new Error('Unexpected source-map source');
}
console.log('Built public-only modules and source maps in dist.');
