import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, extname, sep } from 'node:path';
export async function startServer({port=4173,host='127.0.0.1'}={}) {
 const root=fileURLToPath(new URL('../site/',import.meta.url));
 const types={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.txt':'text/plain','.map':'application/json'};
 const server=createServer(async(req,res)=>{
  const headers={'X-Content-Type-Options':'nosniff','Permissions-Policy':'usb=(self)','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Cache-Control':'no-store',
   'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"};
  try{
   const url=new URL(req.url,'http://localhost');
   if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,headers).end();return;}
   const decoded=decodeURIComponent(url.pathname);
   if(decoded.includes('\0')||decoded.includes('\\')){res.writeHead(400,headers).end();return;}
   const path=resolve(root,'.'+(decoded==='/'?'/index.html':decoded));
   const rel=relative(root,path);
   if(rel.startsWith('..'+sep)||rel==='..'||rel.startsWith('.')||!types[extname(path)]){res.writeHead(404,headers).end();return;}
   const info=await stat(path);if(!info.isFile()){res.writeHead(404,headers).end();return;}
   const body=await readFile(path);
   res.writeHead(200,{...headers,'Content-Type':types[extname(path)],'Content-Length':body.length});res.end(req.method==='HEAD'?undefined:body);
  }catch(error){res.writeHead(error.code==='ENOENT'?404:400,headers).end();}
 });
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,host,ok);});
 return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const server=await startServer({port:Number(process.env.PORT)||4173});
 console.log('Public device toolbox: http://127.0.0.1:'+server.address().port);
}
