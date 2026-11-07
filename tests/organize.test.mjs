import test from 'node:test';
import assert from 'node:assert/strict';
import {dateFromExif, validDate, validateEvent, outputPlan, classifyPhoto, assignFace, safeName} from '../src/organize.js';

test('EXIF local calendar day preserved and invalid dates rejected', () => {
  assert.equal(dateFromExif('2026:08:10 00:15:00'), '2026-08-10');
  assert.equal(dateFromExif('2026:02:30 12:00:00'), null);
  assert.equal(validDate('2024-02-29'), true);
  assert.equal(validDate('2026-02-29'), false);
});
test('multi-day trip includes endpoints and disallows ambiguous overlaps', () => {
  const event = {id:'trip',name:'夏の旅行',start:'2026-08-10',end:'2026-08-13'};
  validateEvent(event, []);
  assert.throws(() => validateEvent({id:'day',name:'花火',start:'2026-08-13',end:'2026-08-13'}, [event]), /重なって/);
  assert.doesNotThrow(() => validateEvent({...event,end:'2026-08-14'}, [event]));
});
test('group photo copied per person and organized by event and day', () => {
  const record = {selected:true,date:'2026-08-13',parts:['camera','a.jpg'],matchedIds:['a','b']};
  const result = outputPlan([record], [{id:'a',name:'A'},{id:'b',name:'B'}], [{name:'旅行',start:'2026-08-10',end:'2026-08-13'}]);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].outputParts, ['A','2026-08-10_2026-08-13_旅行','2026-08-13','camera','a.jpg']);
  assert.equal(result[1].outputParts[0], 'B');
  assert.equal(outputPlan([record], [], [], {useFaces:false}).length, 1);
});
test('any and all modes and manual membership produce correct selection', () => {
  const profiles = [{id:'a'},{id:'b'}];
  const record = {distances:{a:.3,b:.7},fullBlur:200,faces:[{distances:{a:.3,b:.7},blur:200}]};
  const opts = {useFaces:true,maxDistance:.52,blurThreshold:90,skipBlur:true,mode:'people'};
  assert.equal(classifyPhoto(record,profiles,opts).selected,true);
  assert.equal(classifyPhoto(record,profiles,{...opts,mode:'all'}).selected,false);
  assert.equal(classifyPhoto({...record,manualPeople:['a','b']},profiles,{...opts,mode:'all'}).selected,true);
});
test('unsafe folder names normalized', () => {
  assert.equal(safeName('旅/海:*'), '旅_海__');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('..'), '名前なし');
});

test('deleted manually matched person cannot keep a photo selected', () => {
  const profiles = [{id:'remaining', name:'Remaining'}];
  const opts = {useFaces:true,maxDistance:.52,blurThreshold:90,skipBlur:true,mode:'any'};
  const stale = {manualPeople:['removed'],distances:{remaining:.7},fullBlur:200,faces:[]};
  const classified = classifyPhoto(stale, profiles, opts);
  assert.deepEqual(classified.matchedIds, []);
  assert.equal(classified.match, false);
  assert.equal(classified.selected, false);
  const valid = classifyPhoto({...stale,manualPeople:['remaining','removed','remaining']}, profiles, opts);
  assert.deepEqual(valid.matchedIds, ['remaining']);
  assert.equal(valid.selected, true);
  assert.equal(classifyPhoto(stale, [], opts).selected, false);
});

test('manual empty membership still overrides an automatic face match', () => {
  const record = {manualPeople:[],distances:{a:.2},fullBlur:200,faces:[{distances:{a:.2},blur:200}]};
  const result = classifyPhoto(record,[{id:'a'}],{useFaces:true,maxDistance:.52,blurThreshold:90,skipBlur:true,mode:'any'});
  assert.deepEqual(result.matchedIds, []);
  assert.equal(result.selected, false);
  assert.equal(result.needsReview, false);
});

const people = [{id:'a',name:'A'},{id:'b',name:'B'},{id:'c',name:'C'}];
const faceOptions = {useFaces:true,maxDistance:.52,ambiguityMargin:.05,blurThreshold:90,skipBlur:true,mode:'people'};
const photo = faces => ({faces,fullBlur:200});

test('one face close to two people never counts as two people or ALL', () => {
  const face = {distances:{a:.40,b:.42,c:.85},blur:200};
  const result = classifyPhoto({...photo([face]),distances:{a:.40,b:.42}},people.slice(0,2),{...faceOptions,mode:'all'});
  assert.deepEqual(result.matchedIds, []);
  assert.equal(result.selected, false);
  assert.equal(result.needsReview, true);
  assert.equal(result.reviewReason, 'ambiguous');
  assert.deepEqual(result.reviewIds, ['a','b']);
  assert.equal(result.faceMatches[0].personId, null);
});

test('two separate clear faces can confirm both people in a group', () => {
  const result = classifyPhoto(photo([
    {distances:{a:.30,b:.75},blur:180},
    {distances:{a:.72,b:.32},blur:150},
  ]),people.slice(0,2),{...faceOptions,mode:'all'});
  assert.deepEqual(result.matchedIds,['a','b']);
  assert.equal(result.selected,true);
  assert.equal(result.needsReview,false);
  assert.deepEqual(result.faceMatches.map(face=>face.personId),['a','b']);
  assert.equal(result.sharpnessBasis,'face');
});

test('lower minimum distances after adding references cannot assign one face twice', () => {
  for (const distances of [{a:.40,b:.42},{a:.30,b:.31},{a:.20,b:.45}]) {
    const result=classifyPhoto(photo([{distances,blur:200}]),people.slice(0,2),faceOptions);
    assert.ok(result.matchedIds.length<=1);
    assert.equal(classifyPhoto(photo([{distances,blur:200}]),people.slice(0,2),{...faceOptions,mode:'all'}).selected,false);
  }
});

test('near-boundary face is reviewable but far unknown face is not assigned', () => {
  const near=assignFace({distances:{a:.56,b:.59,c:.9}},people,faceOptions);
  assert.equal(near.status,'near');
  assert.equal(near.personId,null);
  assert.deepEqual(near.candidateIds,['a','b']);
  const result=classifyPhoto(photo([{distances:{a:.56,b:.59},blur:200}]),people,faceOptions);
  assert.equal(result.reviewReason,'near');
  assert.equal(result.selected,false);
  assert.deepEqual(assignFace({distances:{a:.8,b:.9}},people,faceOptions).candidateIds,[]);
  assert.equal(classifyPhoto(photo([{distances:{a:.8,b:.9},blur:200}]),people,faceOptions).needsReview,false);
});

test('no detected face requests review instead of using photo-level minima', () => {
  const result=classifyPhoto({...photo([]),distances:{a:.1,b:.2}},people,faceOptions);
  assert.deepEqual(result.matchedIds,[]);
  assert.equal(result.reviewReason,'no-face');
  assert.equal(result.needsReview,true);
  assert.equal(result.selected,false);
  assert.equal(result.sharpnessBasis,'whole');
  assert.equal(classifyPhoto(photo([]),people,{...faceOptions,useFaces:false}).needsReview,false);
});

test('confirmed person remains selectable while another face is ambiguous', () => {
  const result=classifyPhoto(photo([
    {distances:{a:.2,b:.8,c:.8},blur:210},
    {distances:{a:.9,b:.4,c:.41},blur:1},
  ]),people,faceOptions);
  assert.deepEqual(result.matchedIds,['a']);
  assert.equal(result.selected,true);
  assert.equal(result.sharpness,210);
  assert.equal(result.needsReview,true);
  assert.deepEqual(result.reviewIds,['b','c']);
});

test('blur belongs only to faces actually assigned to confirmed target people', () => {
  const result=classifyPhoto(photo([
    {distances:{a:.2,b:.8},blur:180},
    {distances:{a:.45,b:.3},blur:2},
  ]),people.slice(0,2),faceOptions);
  // Manual photo membership A means the B face cannot decide A's sharpness,
  // even though its distance to A is below the absolute threshold.
  const manual=classifyPhoto({...result,manualPeople:['a']},people.slice(0,2),faceOptions);
  assert.equal(manual.sharpness,180);
  assert.equal(manual.sharpnessBasis,'face');
  assert.equal(manual.blurry,false);
  assert.equal(manual.needsReview,false);
});

test('manual membership resolves ambiguous and missing-face review explicitly', () => {
  for (const faces of [[],[{distances:{a:.40,b:.42},blur:200}]]) {
    const result=classifyPhoto({...photo(faces),manualPeople:['a','removed','a']},people,faceOptions);
    assert.deepEqual(result.matchedIds,['a']);
    assert.equal(result.selected,true);
    assert.equal(result.needsReview,false);
    assert.deepEqual(result.reviewIds,[]);
    assert.equal(result.reviewReason,null);
  }
});

test('face assignment validates settings and ignores invalid or inactive distances', () => {
  assert.throws(()=>assignFace({},people,{maxDistance:NaN}),/しきい値/);
  assert.throws(()=>assignFace({},people,{maxDistance:.5,ambiguityMargin:-1}),/しきい値/);
  assert.equal(assignFace({distances:{a:NaN,b:Infinity,c:-1,removed:.1}},people,faceOptions).status,'unknown');
  assert.equal(assignFace({distances:{a:.4,b:.4}},people,{...faceOptions,ambiguityMargin:0}).status,'ambiguous');
  assert.equal(assignFace({distances:{a:.4,b:.45}},people,faceOptions).status,'matched');
  assert.equal(assignFace({distances:{a:.62}},people,faceOptions).status,'near');
});

test('nearby NG examples reject a future best match without choosing another person', () => {
  const face={distances:{a:.30,b:.38},rejectDistances:{a:.32},blur:200};
  const result=assignFace(face,people,faceOptions);
  assert.equal(result.status,'rejected');
  assert.equal(result.personId,null);
  assert.equal(result.reviewReason,'feedback');
  assert.deepEqual(result.candidateIds,['a']);
  const photoResult=classifyPhoto(photo([face]),people,faceOptions);
  assert.deepEqual(photoResult.matchedIds,[]);
  assert.equal(photoResult.selected,false);
  assert.equal(photoResult.needsReview,true);
  assert.equal(photoResult.reviewReason,'feedback');
  assert.deepEqual(photoResult.reviewIds,['a']);
  assert.equal(assignFace({...face,rejectDistances:{a:.34}},people,faceOptions).status,'matched');
});

test('specific OK truth confirms one active identity despite model and NG prototypes', () => {
  const face={distances:{a:.8,b:.2},rejectDistances:{a:0,b:0},feedback:{a:'ok',b:'ng'},blur:200};
  const result=assignFace(face,people,faceOptions);
  assert.equal(result.status,'matched');
  assert.equal(result.personId,'a');
  assert.deepEqual(result.candidateIds,['a']);
  assert.equal(result.distance,.8);
  assert.deepEqual(classifyPhoto(photo([face]),people,faceOptions).matchedIds,['a']);
  assert.equal(assignFace({feedback:{a:'ok'}},people,faceOptions).personId,'a');
});

test('explicit NG of the best identity stays unresolved instead of falling through', () => {
  const result=assignFace({distances:{a:.2,b:.3},feedback:{a:'ng'}},people,faceOptions);
  assert.equal(result.status,'rejected');
  assert.equal(result.personId,null);
  assert.deepEqual(result.candidateIds,['a']);
  assert.equal(assignFace({feedback:{a:'ng'}},people,faceOptions).status,'rejected');
  const manual=classifyPhoto({...photo([{distances:{a:.2,b:.3},feedback:{a:'ng'},blur:200}]),manualPeople:['b']},people,faceOptions);
  assert.deepEqual(manual.matchedIds,['b']);
  assert.equal(manual.needsReview,false);
});

test('feedback ignores deleted profiles and never confirms conflicting active OK labels', () => {
  const result=assignFace({distances:{a:.2,b:.8},feedback:{removed:'ok'},rejectDistances:{removed:0}},people,faceOptions);
  assert.equal(result.personId,'a');
  const conflicting=assignFace({distances:{a:.2,b:.8},feedback:{a:'ok',b:'ok'}},people,faceOptions);
  assert.equal(conflicting.status,'rejected');
  assert.equal(conflicting.personId,null);
  assert.deepEqual(conflicting.candidateIds,['a','b']);
  assert.equal(assignFace({feedback:{removed:'ng'}},people,faceOptions).status,'unknown');
  assert.throws(()=>assignFace({},people,{...faceOptions,negativeMargin:NaN}),/しきい値/);
});

test('person folders reject collisions after sanitization, case folding, and normalization', () => {
  const record = {selected:true,date:'2026-08-13',parts:['a.jpg'],matchedIds:['a','b']};
  for (const [first,second] of [['A/B','A:B'],['Alice','alice'],['CON','_con'],['é','e\u0301']]) {
    const profiles = [{id:'a',name:first},{id:'b',name:second}];
    assert.throws(() => outputPlan([record],profiles,[]),/同じ出力フォルダ名/);
  }
  const distinct = outputPlan([record],[{id:'a',name:'Alice'},{id:'b',name:'Bob'}],[]);
  assert.deepEqual(distinct.map(item => item.outputParts[0]),['Alice','Bob']);
});
