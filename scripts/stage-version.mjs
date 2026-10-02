// 배포 준비만 수행한다. GitHub Pages 설정 변경·푸시·게시를 하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bytes=fs.readFileSync(path.join(root,'rollback-netcode.js')),hash=createHash('sha256').update(bytes).digest('hex');
const directory=path.join(root,'versions',hash),target=path.join(directory,'rollback-netcode.js');
if(fs.existsSync(target)&&!fs.readFileSync(target).equals(bytes))throw Error('Existing content-addressed version differs');
fs.mkdirSync(directory,{recursive:true});if(!fs.existsSync(target))fs.writeFileSync(target,bytes);
console.log(JSON.stringify({sha256:hash,path:path.relative(root,target).replaceAll('\\','/'),published:false},null,2));
