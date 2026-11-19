import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
// Explicit allowlist: never package .git, environment files, logs, fixtures or docs.
await rm('.wasmer-bundle',{recursive:true,force:true});
await mkdir('.wasmer-bundle');
for(const file of ['package.json','package-lock.json']) await copyFile(file,`.wasmer-bundle/${file}`);
await cp('src','.wasmer-bundle/src',{recursive:true});
