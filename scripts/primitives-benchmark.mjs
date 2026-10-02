// 최적화 채택 전 정확한 BigInt 기준과 안전 범위의 후보를 비교한다.
import {performance} from 'node:perf_hooks';
import {fixedPoint,nostrCrypto} from '../rollback-netcode.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const iterations=100000,results=[];
const signed=value=>{if(!Number.isSafeInteger(value)||value< -2147483648||value>2147483647)throw new RangeError('fixed-point result');return value};
for(const [name,operation]of [['bigint-reference',(a,b)=>signed(Number(BigInt(signed(a))*BigInt(signed(b))/1024n))],['current',fixedPoint.mul],['safe-product-candidate',(a,b)=>{
  const product=a*b;assert.ok(Number.isSafeInteger(product));return Math.trunc(product/1024);
}]]){
  let checksum=0;const start=performance.now();
  for(let i=0;i<iterations;i++)checksum=(checksum+operation((i%20001)-10000,12345))|0;
  results.push({name,iterations,ms:performance.now()-start,checksum});
}
assert.equal(results[0].checksum,results[1].checksum);
assert.equal(results[0].checksum,results[2].checksum);
const secret=new Uint8Array(32);secret[31]=3;const message=new Uint8Array(32),auxiliary=new Uint8Array(32),key=nostrCrypto.publicKey(secret);
const signature=await nostrCrypto.sign(message,secret,auxiliary),costs=[];
for(let i=0;i<32;i++){const start=performance.now();assert.equal(await nostrCrypto.verify(signature,message,key),true);costs.push(performance.now()-start)}
costs.sort((a,b)=>a-b);const crypto={samples:32,p50Ms:costs[16],p95Ms:costs[30],maxMs:costs.at(-1)};
fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/primitives-benchmark.json',JSON.stringify({fixedPoint:results,nostrVerification:crypto},null,2));
console.log(JSON.stringify({fixedPoint:results,nostrVerification:crypto},null,2));
