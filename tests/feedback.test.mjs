import test from 'node:test';
import assert from 'node:assert/strict';
import {collectFeedbackCandidates, applyFaceFeedback, recomputeFaceDistances} from '../src/feedback.js';
import {assignFace} from '../src/organize.js';

const feature = value => new Float32Array([value, 0]);
const person = (id, value = 0) => ({id, refs: [{descriptor: feature(value), source: 'enrollment'}]});
const photo = (id, ...values) => ({id, analyzed: true, relative: `${id}.png`, faces: values.map(value => ({descriptor: feature(value), box: {x: 1, y: 2, width: 30, height: 40}}))});

test('answered examples can be revisited and corrected even after an OK becomes an exact reference',()=>{
  const profiles=[person('a')],record=photo('answer',.4),newRecord=photo('unanswered',.5);
  applyFaceFeedback(profiles,record,0,'a','ok');
  assert.equal(collectFeedbackCandidates([record,newRecord],profiles[0]).length,1);
  assert.deepEqual(collectFeedbackCandidates([record,newRecord],profiles[0],{reviewAnswered:true}).map(c=>c.key),['answer:0']);
  applyFaceFeedback(profiles,record,0,'a','ng');
  assert.equal(profiles[0].refs.length,1);
  assert.equal(profiles[0].negatives.length,1);
  assert.equal(collectFeedbackCandidates([record,newRecord],profiles[0],{reviewAnswered:true})[0].key,'answer:0');
});

test('candidate faces are independent in a group and already answered/enrolled faces are skipped', () => {
  const profile = person('a');
  const record = photo('group', 0, .5, .55);
  record.faces[1].feedback = {a: 'ng'};
  const list = collectFeedbackCandidates([record, record], profile);
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'group:2');
  assert.notEqual(list[0].descriptor, record.faces[2].descriptor);
  list[0].descriptor[0] = 99;
  assert.ok(record.faces[2].descriptor[0] < 1);
});

test('candidate queue prioritizes boundary examples but retains clear positive and nearest negative', () => {
  const records = [photo('clear', .1), photo('near1', .51), photo('near2', .515), photo('negative', .54)];
  const list = collectFeedbackCandidates(records, person('a'), {limit: 3});
  assert.equal(list.length, 3);
  assert.ok(list.some(value => value.recordId === 'clear'));
  assert.ok(list.some(value => value.recordId === 'negative'));
  assert.equal(list[0].recordId, 'near2');
  assert.deepEqual(collectFeedbackCandidates(records, person('a'), {limit: 0}), []);
});

test('OK adds a cloned positive example and repeated answers do not multiply references', () => {
  const profiles = [person('a')], record = photo('one', .4);
  const answer = applyFaceFeedback(profiles, record, 0, 'a', 'ok', {makeId: () => 'example-id'});
  assert.equal(answer.changed, true);
  assert.equal(answer.addedReference, true);
  assert.equal(answer.reference.id, 'example-id');
  assert.equal(answer.reference.feedbackKey, 'one:0');
  assert.notEqual(answer.reference.descriptor, record.faces[0].descriptor);
  assert.equal(profiles[0].refs.length, 2);
  assert.equal(record.faces[0].feedback.a, 'ok');
  assert.equal(applyFaceFeedback(profiles, record, 0, 'a', 'ok').changed, false);
  assert.equal(profiles[0].refs.length, 2);
});

test('NG adds local rejection evidence and re-scoring exposes exact negative distance', () => {
  const profiles = [person('a')], record = photo('one', .4);
  applyFaceFeedback(profiles, record, 0, 'a', 'ng');
  recomputeFaceDistances([record], profiles);
  assert.equal(profiles[0].refs.length, 1);
  assert.equal(profiles[0].negatives.length, 1);
  assert.equal(record.faces[0].feedback.a, 'ng');
  assert.equal(record.faces[0].rejectDistances.a, 0);
  assert.ok(Math.abs(record.faces[0].distances.a - .4) < 1e-6);
});

test('human NG prevents the original mistaken assignment and a later OK confirms the corrected identity', () => {
  const profiles = [person('a'), person('b', 1)], record = photo('one', .4);
  const options = {maxDistance: .52, ambiguityMargin: .05};
  recomputeFaceDistances([record], profiles);
  assert.equal(assignFace(record.faces[0], profiles, options).personId, 'a');
  applyFaceFeedback(profiles, record, 0, 'a', 'ng');
  recomputeFaceDistances([record], profiles);
  assert.equal(assignFace(record.faces[0], profiles, options).personId, null);
  assert.equal(assignFace(record.faces[0], profiles, options).status, 'rejected');
  applyFaceFeedback(profiles, record, 0, 'b', 'ok');
  recomputeFaceDistances([record], profiles);
  assert.equal(assignFace(record.faces[0], profiles, options).personId, 'b');
});

test('correcting an answer reverses only its own examples and returns thumbnail references for cleanup', () => {
  const profiles = [person('a')], record = photo('one', .4);
  const original = profiles[0].refs[0];
  const ok = applyFaceFeedback(profiles, record, 0, 'a', 'ok');
  ok.reference.url = 'blob:local';
  const ng = applyFaceFeedback(profiles, record, 0, 'a', 'ng');
  assert.deepEqual(ng.removedReferences.map(value => value.url), ['blob:local']);
  assert.equal(profiles[0].refs[0], original);
  assert.equal(profiles[0].refs.length, 1);
  assert.equal(profiles[0].negatives.length, 1);
  const corrected = applyFaceFeedback(profiles, record, 0, 'a', 'ok');
  assert.equal(corrected.addedReference, true);
  assert.equal(profiles[0].negatives.length, 0);
  assert.equal(profiles[0].refs[0], original);
});

test('a face can have one confirmed identity without fabricating negative labels for another', () => {
  const profiles = [person('a'), person('b', 1)], record = photo('one', .4);
  const original = profiles[0].refs[0];
  applyFaceFeedback(profiles, record, 0, 'a', 'ok');
  applyFaceFeedback(profiles, record, 0, 'b', 'ok');
  assert.deepEqual(record.faces[0].feedback, {b: 'ok'});
  assert.equal(profiles[0].refs.length, 1);
  assert.equal(profiles[0].refs[0], original);
  assert.equal(profiles[0].negatives?.length || 0, 0);
  assert.equal(profiles[1].refs.length, 2);
});

test('duplicate positive descriptors still store confirmation without duplicating manually enrolled refs', () => {
  const profiles = [person('a')], record = photo('one', 0);
  const answer = applyFaceFeedback(profiles, record, 0, 'a', 'ok');
  assert.equal(answer.changed, true);
  assert.equal(answer.addedReference, false);
  assert.equal(profiles[0].refs.length, 1);
  assert.equal(record.faces[0].feedback.a, 'ok');
});

test('re-scoring uses all references, keeps per-face rejection evidence and photo minima display only', () => {
  const profiles = [person('a'), person('b', 1)];
  profiles[0].refs.push({descriptor: feature(.2)});
  profiles[1].negatives = [{descriptor: feature(.9)}];
  const record = photo('group', .2, .8);
  record.faces.push({box: {x: 0, y: 0, width: 10, height: 10}});
  const result = recomputeFaceDistances([record], profiles);
  assert.deepEqual(result, {updatedFaces: 2, missingDescriptors: 1});
  assert.equal(record.distances.a, 0);
  assert.ok(Math.abs(record.distances.b - .2) < 1e-6);
  assert.ok(Math.abs(record.faces[1].rejectDistances.b - .1) < 1e-6);
  assert.deepEqual(record.faces[2].distances, {a: null, b: null});
});

test('malformed vectors and wrong dimensions reject without partially mutating answers or scores', () => {
  const profiles = [person('a')], record = photo('one', .4);
  record.faces[0].descriptor = new Float32Array([NaN, 0]);
  assert.throws(() => applyFaceFeedback(profiles, record, 0, 'a', 'ok'));
  assert.equal(record.faces[0].feedback, undefined);
  assert.equal(profiles[0].refs.length, 1);
  assert.throws(() => collectFeedbackCandidates([record], profiles[0]));
  const good = photo('good', .2), bad = photo('bad', .3);
  bad.faces[0].descriptor = new Float32Array([.3]);
  assert.throws(() => recomputeFaceDistances([good, bad], profiles));
  assert.equal(good.faces[0].distances, undefined);
  assert.throws(() => applyFaceFeedback(profiles, good, 5, 'a', 'ng'));
  assert.throws(() => applyFaceFeedback(profiles, good, 0, 'missing', 'ng'));
  assert.throws(() => applyFaceFeedback(profiles, good, 0, 'a', 'skip'));
});
