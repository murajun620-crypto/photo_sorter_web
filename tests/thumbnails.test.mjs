import test from 'node:test';
import assert from 'node:assert/strict';
import {createThumbnailQueue} from '../src/thumbnails.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};

function fixture(initial, make) {
  const state = {records:initial, visible:initial.map(record => record.id), paused:false};
  const calls = [], publications = [], failures = [], revoked = [];
  let queue;
  queue = createThumbnailQueue({
    getRecords:() => state.records,
    getVisibleRecords:() => state.visible.map(id => state.records.find(record => record.id === id)).filter(Boolean),
    isPaused:() => state.paused,
    makeThumbnail:record => { calls.push(record.id); return make(record); },
    publish:(record, value) => {
      record.thumbnail = value.url;
      delete record.thumbnailError;
      publications.push({record, value});
      queue.refresh(); // Rendering on completion must not start a second worker.
    },
    onError:(record, error) => { record.thumbnailError = error.message; failures.push({record, error}); },
    revoke:url => revoked.push(url),
  });
  return {state, queue, calls, publications, failures, revoked};
}

test('creates visible thumbnails without decoding hidden records', async () => {
  const f = fixture([{id:'a'}, {id:'b'}, {id:'c'}], async record => ({url:`blob:${record.id}`}));
  f.state.visible = ['a', 'b'];
  f.queue.refresh();
  await turn();
  assert.deepEqual(f.calls, ['a', 'b']);
  assert.equal(f.state.records[0].thumbnail, 'blob:a');
  assert.equal(f.state.records[1].thumbnail, 'blob:b');
  assert.equal(f.state.records[2].thumbnail, undefined);
});

test('publishes into a replacement record with the same ID', async () => {
  const pending = deferred();
  const original = {id:'a'};
  const f = fixture([original], () => pending.promise);
  f.queue.refresh();
  await turn();
  const replacement = {...original, selected:true};
  f.state.records = [replacement];
  pending.resolve({url:'blob:replacement', blob:'thumb-bytes'});
  await turn();
  assert.equal(replacement.thumbnail, 'blob:replacement');
  assert.equal(original.thumbnail, undefined);
  assert.equal(f.publications[0].record, replacement);
});

test('source reset discards and revokes an old in-flight result', async () => {
  const old = deferred();
  const f = fixture([{id:'old'}], record => record.id === 'old' ? old.promise : Promise.resolve({url:'blob:new'}));
  f.queue.refresh();
  await turn();
  f.queue.reset();
  f.state.records = [{id:'new'}];
  f.state.visible = ['new'];
  f.queue.refresh();
  old.resolve({url:'blob:old'});
  await turn();
  assert.deepEqual(f.revoked, ['blob:old']);
  assert.deepEqual(f.publications.map(entry => entry.record.id), ['new']);
  assert.equal(f.state.records[0].thumbnail, 'blob:new');
});

test('reset does not publish a stale decode error into the new source', async () => {
  const pending = deferred();
  const f = fixture([{id:'a'}], () => pending.promise);
  f.queue.refresh();
  await turn();
  f.queue.reset();
  f.state.records = [{id:'a'}];
  pending.reject(new Error('old source failed'));
  await turn();
  assert.deepEqual(f.failures, []);
  assert.equal(f.state.records[0].thumbnailError, undefined);
});

test('paused queue starts no work and resumes on refresh', async () => {
  const f = fixture([{id:'a'}], async () => ({url:'blob:a'}));
  f.state.paused = true;
  f.queue.refresh();
  await f.queue.waitForIdle();
  await turn();
  assert.deepEqual(f.calls, []);
  f.state.paused = false;
  f.queue.refresh();
  await turn();
  assert.deepEqual(f.calls, ['a']);
});

test('waitForIdle waits only for active decode and allows paused queued photos', async () => {
  const pending = deferred();
  const f = fixture([{id:'a'}, {id:'b'}], () => pending.promise);
  f.queue.refresh();
  await turn();
  f.state.paused = true;
  let idle = false;
  const waiter = f.queue.waitForIdle().then(() => { idle = true; });
  await turn();
  assert.equal(idle, false);
  pending.resolve({url:'blob:a'});
  await waiter;
  await turn();
  assert.equal(idle, true);
  assert.deepEqual(f.calls, ['a']);
  assert.equal(f.state.records[1].thumbnail, undefined);
});

test('failed preview is not repeatedly decoded or promoted to analysis error', async () => {
  const record = {id:'broken', analyzed:false};
  const f = fixture([record], async () => { throw new Error('invalid image'); });
  f.queue.refresh();
  await turn();
  f.queue.refresh();
  await turn();
  assert.deepEqual(f.calls, ['broken']);
  assert.equal(record.thumbnailError, 'invalid image');
  assert.equal(record.error, undefined);
  assert.equal(record.analyzed, false);
});

test('page change prioritizes the new visible page and remains single threaded', async () => {
  const first = deferred();
  let active = 0, maximum = 0;
  const f = fixture([{id:'a'}, {id:'b'}, {id:'c'}], async record => {
    active += 1;
    maximum = Math.max(maximum, active);
    try { return record.id === 'a' ? await first.promise : {url:`blob:${record.id}`}; }
    finally { active -= 1; }
  });
  f.state.visible = ['a', 'b'];
  f.queue.refresh();
  await turn();
  f.state.visible = ['c'];
  f.queue.refresh();
  first.resolve({url:'blob:a'});
  await turn();
  assert.deepEqual(f.calls, ['a', 'c']);
  assert.equal(maximum, 1);
  assert.equal(f.state.records[1].thumbnail, undefined);
});

test('existing thumbnail from analysis wins over an in-flight preview', async () => {
  const pending = deferred();
  const f = fixture([{id:'a'}], () => pending.promise);
  f.queue.refresh();
  await turn();
  f.state.records = [{id:'a', thumbnail:'blob:analysis'}];
  pending.resolve({url:'blob:preview'});
  await turn();
  assert.deepEqual(f.revoked, ['blob:preview']);
  assert.deepEqual(f.publications, []);
  assert.equal(f.state.records[0].thumbnail, 'blob:analysis');
});
