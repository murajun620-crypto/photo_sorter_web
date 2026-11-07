import test from 'node:test';
import assert from 'node:assert/strict';
import {compareVersions,validateManifest,isNewRelease,installUpdates} from '../src/updates.js';

function element() { return {textContent:'',hidden:false,disabled:false,dataset:{},addEventListener(){},removeEventListener(){}}; }
function harness(overrides={}) {
  const data=new Map(), assigned=[], deleted=[], messages=[];
  const storage={get:async key=>data.get(key),put:async(key,value)=>data.set(key,structuredClone(value)),delete:async key=>{deleted.push(key);data.delete(key);}};
  const location={href:'https://example.github.io/photos/',assign:url=>assigned.push(url)};
  const opts={versionElement:element(),checkButton:element(),statusElement:element(),restartButton:element(),retryButton:element(),
    getSnapshot:async()=>({photos:['a'],selected:1}),applySnapshot:async()=>{},storage,location,
    current:{version:'1.0.1',build:'old'},makeToken:()=> 'test-token',onError:message=>messages.push(message),
    fetchImpl:async()=>({ok:true,json:async()=>({version:'1.0.2',build:'new'})}),...overrides};
  return {opts,data,assigned,deleted,messages};
}

test('versions compare numerically and same-version new build can update',()=>{
  assert.equal(compareVersions('1.0.10','1.0.9'),1);
  assert.equal(compareVersions('2.0.0','1.99.99'),1);
  assert.equal(compareVersions('1.0.1','1.0.1'),0);
  assert.equal(isNewRelease({version:'1.0.1',build:'new'},{version:'1.0.1',build:'old'}),true);
  assert.equal(isNewRelease({version:'1.0.0',build:'new'},{version:'1.0.1',build:'old'}),false);
  assert.throws(()=>validateManifest({version:'x',build:'x'}));
  assert.throws(()=>validateManifest({version:'1.2.3',build:'../../evil'}));
});
test('check fetches only project version manifest without cache',async()=>{
  let request;
  const h=harness({fetchImpl:async(url,options)=>{request={url,options};return{ok:true,json:async()=>({version:'1.0.2',build:'new'})};}});
  const manager=await installUpdates(h.opts);await manager.check();
  assert.equal(new URL(request.url).pathname,'/photos/version.json');
  assert.equal(request.options.cache,'no-store');
  assert.equal(request.options.method,undefined);
  assert.equal(h.opts.versionElement.textContent,'v1.0.1');
  assert.equal(h.opts.restartButton.hidden,false);
});
test('latest version is reported and cannot trigger restart',async()=>{
  const h=harness({fetchImpl:async()=>({ok:true,json:async()=>({version:'1.0.1',build:'old'})})});
  const manager=await installUpdates(h.opts);await manager.check();
  assert.match(h.opts.statusElement.textContent,/最新の v1.0.1/);
  assert.equal(await manager.restart(),false);assert.equal(h.assigned.length,0);
});
test('save is committed before navigation and snapshots preserve typed arrays',async()=>{
  const h=harness({getSnapshot:async()=>({descriptor:new Float32Array([.1,.2]),file:new Blob(['local bytes'])})});
  const manager=await installUpdates(h.opts);await manager.check();
  assert.equal(await manager.restart(),true);
  assert.match(h.assigned[0],/_update=test-token/);
  assert.ok(h.data.get('test-token').state.descriptor instanceof Float32Array);
  assert.equal(await h.data.get('test-token').state.file.text(),'local bytes');
});
test('quota/save error preserves page and suppresses navigation',async()=>{
  const h=harness();h.opts.storage.put=async()=>{throw new DOMException('full','QuotaExceededError');};
  const manager=await installUpdates(h.opts);await manager.check();
  assert.equal(await manager.restart(),false);assert.equal(h.assigned.length,0);
  assert.match(h.opts.statusElement.textContent,/現在の作業はそのまま/);
});
test('failed restore keeps recovery data and retry succeeds before deletion',async()=>{
  let fail=true, applied;
  const h=harness({applySnapshot:async snapshot=>{if(fail)throw new Error('temporary');applied=snapshot;}});
  h.opts.location.href+='?_update=test-token';
  h.data.set('test-token',{format:'photosorter-update',schema:1,pathname:'/photos/',state:{photo:'retained'}});
  const manager=await installUpdates(h.opts);
  assert.equal(h.opts.retryButton.hidden,false);assert.equal(h.deleted.length,0);assert.ok(h.data.has('test-token'));
  fail=false;assert.equal(await manager.restore(),true);
  assert.deepEqual(applied,{photo:'retained'});assert.deepEqual(h.deleted,['test-token']);assert.equal(h.opts.retryButton.hidden,true);
});
test('recovery from another project is rejected and retained',async()=>{
  const h=harness();h.opts.location.href+='?_update=test-token';
  h.data.set('test-token',{format:'photosorter-update',schema:1,pathname:'/elsewhere/',state:{photo:'private'}});
  await installUpdates(h.opts);assert.equal(h.deleted.length,0);assert.equal(h.opts.retryButton.hidden,false);
});
test('active processing prevents both check and restart',async()=>{
  let allowed=true, requests=0;
  const h=harness({canUpdate:()=>allowed,fetchImpl:async()=>{requests++;return{ok:true,json:async()=>({version:'1.0.2',build:'new'})};}});
  const manager=await installUpdates(h.opts);allowed=false;
  await manager.check();assert.equal(requests,0);
  allowed=true;await manager.check();allowed=false;assert.equal(await manager.restart(),false);assert.equal(h.assigned.length,0);
});
