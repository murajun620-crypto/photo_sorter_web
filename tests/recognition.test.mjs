import test from 'node:test';
import assert from 'node:assert/strict';
import {ENGINE_ID,DEFAULT_MAX_DISTANCE,assertCurrentFeature,migrateSnapshot,mergeRegisteredFaces} from '../src/recognition.js';
import {applyFaceFeedback,recomputeFaceDistances,collectFeedbackCandidates} from '../src/feedback.js';
import {assignFace} from '../src/organize.js';

const descriptor=angle=>{const vector=new Float32Array(128);vector[0]=Math.cos(angle);vector[1]=Math.sin(angle);return vector;};
const example=angle=>({descriptor:descriptor(angle),engineId:ENGINE_ID});
const profile=(id,angle=0)=>({id,name:id,engineId:ENGINE_ID,refs:[example(angle)],negatives:[]});
const photo=(id,angle)=>({id,engineId:ENGINE_ID,analyzed:true,featuresReady:true,facesDetected:true,faces:[example(angle)]});

test('main recognition accepts only the pinned normalized128D model descriptors',()=>{
  assertCurrentFeature(example(.8));
  assert.throws(()=>assertCurrentFeature({...example(.8),engineId:'face-api-old'}));
  assert.throws(()=>assertCurrentFeature({descriptor:descriptor(.8)}));
  assert.throws(()=>assertCurrentFeature({engineId:ENGINE_ID,descriptor:new Float32Array(128)}));
  const broken=example(0);broken.descriptor[1]=NaN;assert.throws(()=>assertCurrentFeature(broken));
  assert.ok(Math.abs((1-DEFAULT_MAX_DISTANCE**2/2)-.395)<1e-10);
});

test('legacy update keeps originals and explicit photo edits but quarantines all old face evidence',()=>{
  const file=new Blob(['photo']),preview=new Blob(['preview']);
  const snapshot={schema:1,source:{handle:'source'},sourceName:'trip',events:[{name:'trip'}],
    profiles:[{id:'a',name:'Alice',refs:[{...example(0),engineId:'old',blob:preview}],negatives:[example(.1)]}],
    records:[{...photo('photo',.2),engineId:'old',file,parts:['photo.jpg'],date:'2026-11-07',manualPeople:['a'],manualSelected:true,
      faces:[{...example(.2),engineId:'old',feedback:{a:'ok'}}],matchedIds:['a'],selected:true,blurLabel:'sharp'}],
    controls:{distance:'.52','ambiguity-margin':'.1','target-size':'2'},analyzedMode:true};
  const result=migrateSnapshot(snapshot);
  assert.equal(result.migrated,true);assert.equal(result.needsRegistration,1);
  const next=result.snapshot;
  assert.equal(next.engineId,ENGINE_ID);assert.equal(next.source,snapshot.source);assert.equal(next.events,snapshot.events);
  assert.equal(next.records[0].file,file);assert.equal(next.records[0].date,'2026-11-07');
  assert.deepEqual(next.records[0].manualPeople,['a']);assert.equal(next.records[0].manualSelected,true);assert.equal(next.records[0].blurLabel,'sharp');
  for(const key of ['selected','analyzed','featuresReady','facesDetected'])assert.equal(next.records[0][key],false);
  assert.deepEqual(next.records[0].faces,[]);assert.deepEqual(next.records[0].matchedIds,[]);
  assert.deepEqual(next.profiles[0].refs,[]);assert.deepEqual(next.profiles[0].negatives,[]);
  assert.equal(next.profiles[0].pendingRefs[0].blob,preview);assert.equal(next.profiles[0].pendingRefs[0].descriptor,undefined);
  assert.equal(next.controls.distance,'1.1');assert.equal(next.controls['target-size'],'2');
  assert.equal(snapshot.records[0].selected,true);assert.equal(snapshot.profiles[0].refs.length,1);
});

test('current snapshots preserve OK/NG and cached SFace data; a single untagged128D ref forces migration',()=>{
  const person=profile('a'),record=photo('one',.4);
  applyFaceFeedback([person],record,0,'a','ng');
  const snapshot={engineId:ENGINE_ID,profiles:[person],records:[record]};
  const current=migrateSnapshot(snapshot);
  assert.equal(current.migrated,false);assert.equal(current.snapshot,snapshot);
  assert.equal(current.snapshot.records[0].faces[0].feedback.a,'ng');
  const mixed=structuredClone(snapshot);delete mixed.profiles[0].refs[0].engineId;
  assert.equal(migrateSnapshot(mixed).migrated,true);
});

test('SFace OK/NG preserves engine provenance and changes other cached photos without another inference',()=>{
  const profiles=[profile('a'),profile('b',2)],first=photo('first',.75),future=photo('future',.76);
  recomputeFaceDistances([first,future],profiles);
  assert.equal(assignFace(future.faces[0],profiles,{maxDistance:DEFAULT_MAX_DISTANCE}).personId,'a');
  applyFaceFeedback(profiles,first,0,'a','ng');
  assert.equal(profiles[0].negatives[0].engineId,ENGINE_ID);
  recomputeFaceDistances([first,future],profiles);
  assert.equal(assignFace(first.faces[0],profiles,{maxDistance:DEFAULT_MAX_DISTANCE}).personId,null);
  assert.equal(assignFace(future.faces[0],profiles,{maxDistance:DEFAULT_MAX_DISTANCE}).personId,null);
  const answer=applyFaceFeedback(profiles,first,0,'b','ok');
  assert.equal(answer.reference.engineId,ENGINE_ID);
  recomputeFaceDistances([first,future],profiles);
  assert.equal(assignFace(first.faces[0],profiles,{maxDistance:DEFAULT_MAX_DISTANCE}).personId,'b');
  assert.equal(assignFace(future.faces[0],profiles,{maxDistance:DEFAULT_MAX_DISTANCE}).personId,'b');
});

test('equal-sized mixed model banks cannot partially change feedback or scores',()=>{
  const profiles=[profile('a')],good=photo('good',.7),bad=photo('bad',.9);
  delete bad.faces[0].engineId;
  assert.throws(()=>recomputeFaceDistances([good,bad],profiles));
  assert.equal(good.faces[0].distances,undefined);
  assert.throws(()=>collectFeedbackCandidates([bad],profiles[0],{maxDistance:DEFAULT_MAX_DISTANCE}));
  assert.throws(()=>applyFaceFeedback(profiles,bad,0,'a','ok'));
  assert.equal(profiles[0].refs.length,1);assert.equal(bad.faces[0].feedback,undefined);
});

test('registration survives a detector miss and replaces only its best matching face',()=>{
  const box=(x,y=10)=>({x,y,width:40,height:50});
  const detected=[{...example(.5),box:box(10)},{...example(1),box:box(52)}];
  const registered=[{...example(.4),box:box(12),feedback:{a:'ok'}},{...example(2),box:box(130),feedback:{b:'ok'}}];
  const merged=mergeRegisteredFaces(detected,registered);
  assert.equal(merged.length,3);assert.deepEqual(merged[0].feedback,{a:'ok'});
  assert.equal(merged[0].descriptor[0],registered[0].descriptor[0]);
  assert.equal(merged[1].descriptor[0],detected[1].descriptor[0]);
  assert.deepEqual(merged[2].feedback,{b:'ok'});
  merged[0].feedback.a='ng';assert.equal(registered[0].feedback.a,'ok');
  assert.equal(detected[0].feedback,undefined);
});

test('re-registering a region updates its identity without duplicating it or accepting old engine data',()=>{
  const box={x:10,y:20,width:50,height:60};
  const old={...example(.2),box,feedback:{a:'ok'}},corrected={...example(.3),box,feedback:{b:'ok'}};
  const merged=mergeRegisteredFaces([], [old,corrected]);
  assert.equal(merged.length,1);assert.deepEqual(merged[0].feedback,{b:'ok'});
  assert.throws(()=>mergeRegisteredFaces([],[{...old,engineId:'old'}]));
  const snapshot={engineId:ENGINE_ID,profiles:[profile('a')],records:[{...photo('a',.2),registeredFaces:[{...old,engineId:'old'}]}]};
  const migration=migrateSnapshot(snapshot);
  assert.equal(migration.migrated,true);assert.deepEqual(migration.snapshot.records[0].registeredFaces,[]);
});

test('two nearby registered faces cannot overwrite one another through one broad detected box',()=>{
  const left={...example(.2),box:{x:10,y:10,width:50,height:50},feedback:{a:'ok'}};
  const right={...example(.8),box:{x:28,y:10,width:50,height:50},feedback:{b:'ok'}};
  const broad={...example(.4),box:{x:10,y:10,width:68,height:50}};
  const faces=mergeRegisteredFaces([broad],[left,right]);
  assert.equal(faces.length,2);assert.deepEqual(faces.map(face=>Object.keys(face.feedback)[0]),['a','b']);
});

test('same five face landmarks unify differently sized registration boxes and keep the latest truth',()=>{
  const landmarks=[[20,25],[40,25],[30,35],[22,45],[38,45]];
  const original={...example(.2),box:{x:10,y:10,width:40,height:50},landmarks,feedback:{a:'ok'}};
  const corrected={...example(.2),box:{x:5,y:5,width:50,height:60},landmarks:landmarks.map(point=>[...point]),feedback:{b:'ok'}};
  const faces=mergeRegisteredFaces([original],[original,corrected]);
  assert.equal(faces.length,1);assert.deepEqual(faces[0].feedback,{b:'ok'});assert.deepEqual(faces[0].box,corrected.box);
});

test('nearby distinct five-point faces and incomplete landmarks cannot trigger registration deduplication',()=>{
  const landmarks=[[20,25],[40,25],[30,35],[22,45],[38,45]];
  const left={...example(.2),box:{x:10,y:10,width:40,height:50},landmarks,feedback:{a:'ok'}};
  const right={...example(.8),box:{x:28,y:10,width:40,height:50},landmarks:landmarks.map(([x,y])=>[x+18,y]),feedback:{b:'ok'}};
  const broad={...example(.4),box:{x:10,y:10,width:58,height:50},landmarks};
  const faces=mergeRegisteredFaces([broad],[left,right]);
  assert.equal(faces.length,2);assert.deepEqual(faces.map(face=>Object.keys(face.feedback)[0]),['a','b']);
  const incomplete={...right,box:{x:5,y:5,width:50,height:60},landmarks:landmarks.slice(0,2)};
  assert.equal(mergeRegisteredFaces([],[left,incomplete]).length,2);
});
