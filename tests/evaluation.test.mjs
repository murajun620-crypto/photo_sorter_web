import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateEngines,predictFace,prepareReferenceBanks,anonymizeResults,boxIoU,OTHER_PERSON,UNCERTAIN_PERSON} from '../src/evaluation.js';

const OLD='face-api-0.22.2:5d66ec95338d7fcc365ce15481b8599baf4b6e22c9a624b76d4ca821a669a659:full1280-landmarks68-v1';
const NEW='opencv-yunet-2023mar-8f2383e4+sface-2021dec-0ba9fbfa:rgb5p-v1';
const profiles=[{id:'private-child-a',name:'子供の実名A'},{id:'private-child-b',name:'子供の実名B'}];
function feature(axis,offset=0){const values=new Float32Array(128);values[axis]=1;values[(axis+2)%128]=offset;return values;}
const A=feature(0),B=feature(1),OTHER=feature(7);
const box=(x=0)=>({x,y:0,width:100,height:100});
const truth=(label,position=0,extra={})=>({id:`truth-${label}-${position}`,label,box:box(position),...extra});
const face=(descriptor,position=0)=>({box:box(position),descriptor});
const sample=(id,role,truths,oldFaces=[],newFaces=[],extra={})=>({id,sourceGroup:`photo-${id}`,role,reviewed:true,truths,oldFaces,newFaces,oldEngineId:OLD,newEngineId:NEW,...extra});
function references(){return [
  sample('ref-A','reference',[truth(profiles[0].id,0,{oldDescriptor:A,newDescriptor:A})]),
  sample('ref-B','reference',[truth(profiles[1].id,0,{oldDescriptor:B,newDescriptor:B})]),
];}

test('separate held-out group faces confirm both identities and correct folder membership',()=>{
  const photos=[...references(),sample('group','test',[truth(profiles[0].id),truth(profiles[1].id,150)],
    [face(feature(0,.05)),face(feature(1,.04),150)],[face(feature(0,.05)),face(feature(1,.04),150)])];
  const result=evaluateEngines(photos,profiles);
  for(const engine of ['old','new']){
    assert.equal(result[engine].metrics.targetFaces,2);
    assert.equal(result[engine].metrics.correctKnownFaces,2);
    assert.equal(result[engine].metrics.acceptedPredictions,2);
    assert.equal(result[engine].metrics.precision,1);
    assert.equal(result[engine].metrics.recall,1);
    for(const person of profiles){assert.equal(result[engine].byPerson[person.id].exportedPhotos,1);assert.equal(result[engine].byPerson[person.id].wrongFolderPhotos,0);}
  }
  assert.ok(result.warnings.some(w=>w.code==='LOW_TEST_COUNT'));
  assert.equal(result.references.new.modelId,NEW);
});

test('accepted strangers and unmatched recognized detections penalize precision and wrong folders',()=>{
  const photos=[...references(),sample('stranger','test',[truth(OTHER_PERSON)], [face(A),face(B,300)],[face(A),face(B,300)])];
  const result=evaluateEngines(photos,profiles);
  for(const engine of ['old','new']){
    assert.equal(result[engine].metrics.acceptedPredictions,2);
    assert.equal(result[engine].metrics.wrongPredictions,2);
    assert.equal(result[engine].metrics.precision,0);
    assert.equal(result[engine].metrics.recall,null);
    assert.equal(result[engine].byPerson[profiles[0].id].wrongFolderPhotos,1);
    assert.equal(result[engine].byPerson[profiles[1].id].wrongFolderPhotos,1);
  }
});

test('missed detections differ from identity rejections, and all-reject is never perfect',()=>{
  const photos=[...references(),sample('miss-and-reject','test',[truth(profiles[0].id),truth(profiles[1].id,150)], [face(OTHER)],[face(OTHER)])];
  const result=evaluateEngines(photos,profiles);
  for(const engine of ['old','new']){
    assert.equal(result[engine].metrics.targetFaces,2);
    assert.equal(result[engine].metrics.detectedTargetFaces,1);
    assert.equal(result[engine].metrics.correctKnownFaces,0);
    assert.equal(result[engine].metrics.precision,null);
    assert.equal(result[engine].metrics.recall,0);
    assert.equal(result[engine].metrics.detectionRecall,.5);
    assert.equal(result[engine].metrics.missedDetections,1);
    assert.equal(result[engine].metrics.rejectedFaces,1);
    assert.equal(result[engine].byPerson[profiles[1].id].missedPhotos,1);
  }
});

test('uncertain face identities and their matched predictions do not count as errors',()=>{
  const photos=[...references(),sample('uncertain','test',[truth(profiles[0].id),truth(UNCERTAIN_PERSON,150)],
    [face(A),face(B,150)],[face(A),face(B,150)])];
  const result=evaluateEngines(photos,profiles);
  for(const engine of ['old','new']){
    assert.equal(result[engine].metrics.correctKnownFaces,1);
    assert.equal(result[engine].metrics.acceptedPredictions,1);
    assert.equal(result[engine].metrics.wrongPredictions,0);
    assert.equal(result[engine].metrics.excludedUncertainFaces,1);
    assert.equal(result[engine].metrics.excludedUncertainPhotos,1);
    assert.equal(result[engine].byPerson[profiles[0].id].truthPhotos,0);
    assert.equal(result[engine].byPerson[profiles[1].id].wrongFolderPhotos,0);
  }
});

test('greedy geometry is one-to-one, so duplicated detections do not double correct counts',()=>{
  const photos=[...references(),sample('duplicate-detection','test',[truth(profiles[0].id)], [face(A),face(A,1)],[face(A),face(A,1)])];
  const result=evaluateEngines(photos,profiles);
  assert.equal(result.new.metrics.correctKnownFaces,1);
  assert.equal(result.new.metrics.wrongPredictions,1);
  assert.equal(result.new.metrics.precision,.5);
  assert.equal(result.new.byPerson[profiles[0].id].exportedPhotos,1);
  assert.equal(boxIoU(box(0),box(0)),1);
  assert.equal(boxIoU(box(0),box(150)),0);
});

test('reference/test source leakage, unreviewed test photos, and absent references fail closed',()=>{
  assert.throws(()=>evaluateEngines([...references(),sample('test','test',[truth(profiles[0].id)],[],[],{sourceGroup:'photo-ref-A'})],profiles),/同じ元写真/);
  assert.throws(()=>evaluateEngines([...references(),sample('ref-A','test',[])],profiles),/重複/);
  assert.throws(()=>evaluateEngines([...references(),sample('test','test',[],[],[],{reviewed:false})],profiles),/確認済み/);
  assert.throws(()=>evaluateEngines([references()[0],sample('test','test',[])],profiles),/参照用写真/);
});

test('matching keeps Euclidean old scores and cosine new scores independent',()=>{
  const banks=prepareReferenceBanks(references(),profiles);
  assert.equal(predictFace('old',feature(0,.1),banks.old).personId,profiles[0].id);
  assert.equal(predictFace('new',feature(0,.1),banks.new).personId,profiles[0].id);
  assert.throws(()=>predictFace('new',A,banks.old),/混ぜる/);
  assert.throws(()=>predictFace('old',A,banks.new),/混ぜる/);
  assert.throws(()=>predictFace('new',A,banks.new,{modelId:'changed-preprocessing'}),/一致しません/);
  const tied=Float32Array.from(A,(_,i)=>i<2?Math.SQRT1_2:0);
  assert.equal(predictFace('new',tied,banks.new).status,'ambiguous');
  assert.throws(()=>predictFace('old',new Float32Array(8),banks.old),/128個/);
});

test('128D equality cannot bypass engine or preprocessing identity checks',()=>{
  const tests=sample('test','test',[truth(profiles[0].id)],[face(A)],[face(A)]);
  assert.throws(()=>evaluateEngines([...references(),{...tests,newEngineId:'different-new-preprocess'}],profiles),/異なるモデル/);
  assert.throws(()=>evaluateEngines([...references(),{...tests,newEngineId:undefined}],profiles),/一部の写真/);
  const wrongTruth=references();wrongTruth[0].truths[0].newDescriptorEngineId=OLD;
  assert.throws(()=>evaluateEngines([...wrongTruth,tests],profiles),/参照した顔/);
  const wrongFace={...tests,newFaces:[{...face(A),engineId:OLD}]};
  assert.throws(()=>evaluateEngines([...references(),wrongFace],profiles),/モデル識別子/);
});

test('missing per-engine reference is not replaced with another model vector',()=>{
  const refs=references();delete refs[0].truths[0].oldDescriptor;
  const result=evaluateEngines([...refs,sample('test','test',[truth(profiles[0].id)],[face(A)],[face(A)])],profiles);
  assert.equal(result.old.metrics.correctKnownFaces,0);
  assert.equal(result.new.metrics.correctKnownFaces,1);
  assert.ok(result.old.missingReferencePeople.includes(profiles[0].id));
  assert.ok(result.warnings.some(w=>w.code==='MISSING_ENGINE_REFERENCE'&&w.engine==='old'));
});

test('anonymized report contains numeric aggregate data, no names, source IDs, filenames or features',()=>{
  const result=evaluateEngines([...references(),sample('C:/private/child-photo.jpg','test',[truth(profiles[0].id)],[face(A)],[face(A)])],profiles);
  result.old.metrics['sensitive-numeric-key']=123;
  result.warnings.push({code:'secret-id-in-unknown-code',engine:'private-name',message:'sensitive text',personId:profiles[0].id,count:2});
  const anonymous=anonymizeResults(result),text=JSON.stringify(anonymous);
  assert.equal(anonymous.persons,2);
  assert.equal(anonymous.new.byPerson.person1.exportedPhotos,1);
  assert.ok(!text.includes('private'));
  assert.ok(!text.includes('子供'));
  assert.ok(!text.includes('child-photo'));
  assert.ok(!text.includes('Descriptor'));
  assert.ok(!text.includes('sensitive'));
  assert.ok(!text.includes('secret-id'));
  assert.ok(!('references'in anonymous));
  assert.ok(!('sampleResults'in anonymous.new));
});
