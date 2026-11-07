import test from 'node:test';
import assert from 'node:assert/strict';
import {dateFromExif, validDate, validateEvent, outputPlan, classifyPhoto, safeName} from '../src/organize.js';

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
  const record = {distances:{a:.3,b:.7},fullBlur:200,faces:[]};
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
  const record = {manualPeople:[],distances:{a:.2},fullBlur:200,faces:[]};
  const result = classifyPhoto(record,[{id:'a'}],{useFaces:true,maxDistance:.52,blurThreshold:90,skipBlur:true,mode:'any'});
  assert.deepEqual(result.matchedIds, []);
  assert.equal(result.selected, false);
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
