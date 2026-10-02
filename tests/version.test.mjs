import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
test('any staged version has a path matching the SHA-256 of its immutable module bytes',()=>{
  if(!fs.existsSync('versions'))return;
  for(const entry of fs.readdirSync('versions',{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    assert.match(entry.name,/^[0-9a-f]{64}$/);
    const bytes=fs.readFileSync(`versions/${entry.name}/rollback-netcode.js`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.name);
  }
});
