import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPhotos, verifyUnchanged, exportRecords, quarantineRecords, restoreQuarantine, validatedOutputParts, QUARANTINE_FOLDER} from '../src/filesystem.js';

const missing = () => new DOMException('Missing', 'NotFoundError');
const mismatch = () => new DOMException('Wrong kind', 'TypeMismatchError');
let clock = 100;
class MemoryFileHandle {
  kind = 'file';
  constructor(name, parent, bytes = new Uint8Array()) {
    this.name = name; this.parent = parent; this.bytes = new Uint8Array(bytes); this.lastModified = ++clock;
  }
  async isSameEntry(other) { return this === other; }
  async getFile() {
    if (this.parent.children.get(this.name) !== this) throw missing();
    return new File([this.bytes], this.name, {lastModified: this.lastModified});
  }
  async createWritable() {
    let pending;
    return {
      write: async data => {
        pending = new Uint8Array(await data.arrayBuffer());
        let root = this.parent;
        while (root.parent) root = root.parent;
        root.onFileWrite?.(this, pending);
        this.onWrite?.();
      },
      close: async () => { if (this.failClose) throw Error('Disk write failed'); this.bytes = pending; this.lastModified = ++clock; },
      abort: async () => {},
    };
  }
}
class MemoryDirectory {
  kind = 'directory';
  children = new Map();
  constructor(name, parent = null) { this.name = name; this.parent = parent; }
  async isSameEntry(other) { return this === other; }
  async queryPermission() { return 'granted'; }
  async *entries() { yield* this.children.entries(); }
  async resolve(child) {
    const parts = [];
    while (child && child !== this) { parts.unshift(child.name); child = child.parent; }
    return child === this ? parts : null;
  }
  async getFileHandle(name, {create = false} = {}) {
    if (this.children.has(name)) {
      const item = this.children.get(name);
      if (item.kind !== 'file') throw mismatch();
      return item;
    }
    if (!create) throw missing();
    const file = new MemoryFileHandle(name, this);
    this.children.set(name, file);
    this.onCreate?.(file);
    return file;
  }
  async getDirectoryHandle(name, {create = false} = {}) {
    if (this.children.has(name)) {
      const item = this.children.get(name);
      if (item.kind !== 'directory') throw mismatch();
      return item;
    }
    if (!create) throw missing();
    const dir = new MemoryDirectory(name, this);
    this.children.set(name, dir);
    return dir;
  }
  async removeEntry(name) {
    if (this.rejectRemove) throw Error('Removal denied');
    if (!this.children.has(name)) throw missing();
    this.children.delete(name);
  }
  async put(path, bytes) {
    const parts = path.split('/');
    let dir = this;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, {create: true});
    const handle = new MemoryFileHandle(parts.at(-1), dir, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
    dir.children.set(handle.name, handle);
    return handle;
  }
  async read(path) {
    const parts = path.split('/');
    let dir = this;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    return (await dir.getFileHandle(parts.at(-1))).getFile();
  }
}

function roots() { return {source: new MemoryDirectory('source'), output: new MemoryDirectory('output')}; }
async function readManifest(source, folderName) { return JSON.parse(await (await source.read(`${folderName}/manifest.json`)).text()); }
async function editManifest(source, folderName, edit) {
  const manifest = await readManifest(source, folderName);
  edit(manifest);
  await source.put(`${folderName}/manifest.json`, JSON.stringify(manifest));
}

test('shared output validation rejects ZIP traversal and unsafe Windows names', () => {
  for (const name of ['..\\escape.jpg', '../escape.jpg', 'CON.jpg', 'bad:name.jpg', 'a.jpg ']) {
    assert.throws(() => validatedOutputParts({parts: [name], outputParts: ['person', name]}));
  }
  assert.throws(() => validatedOutputParts({parts: ['a.jpg'], outputParts: ['..', 'a.jpg']}));
  assert.deepEqual(validatedOutputParts({parts: ['a.jpg'], outputParts: ['あおい', '2026-11-07', 'a.jpg']}), ['あおい', '2026-11-07', 'a.jpg']);
});

test('collects supported photos recursively and skips managed folders', async () => {
  const {source} = roots();
  await source.put('b.PNG', 'b');
  await source.put('a/a.JPEG', 'a');
  await source.put('note.txt', 'note');
  await source.put(`${QUARANTINE_FOLDER}/old.jpg`, 'skip');
  await source.put('_PhotoSorter_出力/old.jpg', 'skip');
  const records = await collectPhotos(source);
  assert.deepEqual(records.map(r => r.relative), ['a/a.JPEG', 'b.PNG']);
  assert.equal((await verifyUnchanged(records[0])).size, 1);
  records[0].handle.lastModified++;
  await assert.rejects(verifyUnchanged(records[0]), /変更/);
});

test('export duplicates a group photo into different named/date/event folders', async () => {
  const {source, output} = roots();
  await source.put('same.png', 'source bytes');
  const [record] = await collectPhotos(source);
  const a = {...record, outputParts: ['あおい', '2026-08-10_2026-08-13_旅行', '2026-08-10', 'same.png'], date: '2026-08-10', dateSource: 'EXIF', event: '旅行', people: ['あおい', 'はる']};
  const b = {...record, outputParts: ['はる', 'same.png']};
  const result = await exportRecords([a, b], output, source);
  assert.equal(result.exported, 2);
  assert.equal(await (await output.read(`${result.folderName}/はる/same.png`)).text(), 'source bytes');
  assert.equal(await (await source.read('same.png')).text(), 'source bytes');
  const report = JSON.parse(await (await output.read(`${result.folderName}/処理結果.json`)).text());
  assert.deepEqual(report.files[0].people, ['あおい', 'はる']);
  assert.equal(report.files[0].event, '旅行');
});

test('export never overwrites a destination and rejects unsafe target paths', async () => {
  const {source, output} = roots();
  await source.put('a.jpg', 'source');
  const [record] = await collectPhotos(source);
  const result = await exportRecords([record, record, {...record, outputParts: ['..', 'a.jpg']}, {...record, outputParts: ['other.jpg']}], output, source);
  assert.equal(result.exported, 1);
  assert.equal(result.errors.length, 3);
  await assert.rejects(exportRecords([record], source, source), /外側/);
  const child = await source.getDirectoryHandle('nested', {create: true});
  await assert.rejects(exportRecords([record], child, source), /外側/);
});

test('compression validates actual bytes and changed source', async () => {
  const {source, output} = roots();
  await source.put('a.png', 'original');
  const [record] = await collectPhotos(source);
  const good = await exportRecords([record], output, source, {targetBytes: 10000, compressFn: async () => ({blob: new Blob(['compressed'])})});
  assert.equal(good.exported, 1);
  assert.equal(await (await output.read(`${good.folderName}/a.png.jpg`)).text(), 'compressed');
  const oversized = await exportRecords([record], output, source, {targetBytes: 10000, compressFn: async () => new Blob([new Uint8Array(10001)])});
  assert.equal(oversized.exported, 0);
  const changed = await exportRecords([record], output, source, {targetBytes: 10000, compressFn: async () => { record.handle.lastModified++; return new Blob(['x']); }});
  assert.equal(changed.exported, 0);
  assert.equal(changed.errors.length, 1);
});

test('cancellation leaves completed outputs and report only', async () => {
  const {source, output} = roots();
  await source.put('a.jpg', 'a'); await source.put('b.jpg', 'b');
  const controller = new AbortController();
  const result = await exportRecords(await collectPhotos(source), output, source, {signal: controller.signal, onProgress: () => controller.abort()});
  assert.equal(result.exported, 1); assert.equal(result.cancelled, true);
  assert.ok(await output.read(`${result.folderName}/処理結果.json`));
  await assert.rejects(output.read(`${result.folderName}/b.jpg`));
});

test('cancellation during writable stream aborts and removes incomplete output', async () => {
  const {source, output} = roots();
  await source.put('a.jpg', 'original');
  const controller = new AbortController();
  output.onFileWrite = file => { if (file.name === 'a.jpg') controller.abort(); };
  const result = await exportRecords(await collectPhotos(source), output, source, {signal: controller.signal});
  assert.equal(result.exported, 0); assert.equal(result.cancelled, true);
  await assert.rejects(output.read(`${result.folderName}/a.jpg`));
  assert.equal(await (await source.read('a.jpg')).text(), 'original');
});

test('quarantine copies byte-exact originals and restores after reload', async () => {
  const {source} = roots();
  const bytes = new Uint8Array([0, 1, 2, 255, 100]);
  await source.put('album/a.jpg', bytes);
  const records = await collectPhotos(source);
  const result = await quarantineRecords(records, source);
  assert.equal(result.quarantined, 1); assert.deepEqual(result.paths, ['album/a.jpg']);
  assert.deepEqual(result.ids, [records[0].id]);
  await assert.rejects(source.read('album/a.jpg'));
  assert.deepEqual(new Uint8Array(await (await source.read(`${result.folderName}/files/album/a.jpg`)).arrayBuffer()), bytes);
  const manifest = await readManifest(source, result.folderName);
  assert.equal(manifest.entries[0].status, 'removed');
  const restored = await restoreQuarantine(source);
  assert.equal(restored.restored, 1); assert.deepEqual(restored.errors, []);
  assert.deepEqual(new Uint8Array(await (await source.read('album/a.jpg')).arrayBuffer()), bytes);
  assert.equal((await restoreQuarantine(source)).restored, 0);
});

test('remove failure preserves original and verified backup; restore skips it', async () => {
  const {source} = roots();
  await source.put('a.jpg', 'safe');
  source.rejectRemove = true;
  const result = await quarantineRecords(await collectPhotos(source), source);
  assert.equal(result.quarantined, 0); assert.equal(result.errors.length, 1);
  assert.equal(await (await source.read('a.jpg')).text(), 'safe');
  assert.equal(await (await source.read(`${result.folderName}/files/a.jpg`)).text(), 'safe');
  assert.equal((await readManifest(source, result.folderName)).entries[0].status, 'remove_failed');
  assert.equal((await restoreQuarantine(source)).restored, 0);
});

test('restore refuses changed backup and existing different originals', async () => {
  const {source} = roots();
  await source.put('a.jpg', 'original');
  const quarantined = await quarantineRecords(await collectPhotos(source), source);
  await source.put('a.jpg', 'new photo');
  const conflict = await restoreQuarantine(source);
  assert.equal(conflict.restored, 0); assert.equal(conflict.errors.length, 1);
  assert.equal(await (await source.read('a.jpg')).text(), 'new photo');
  await source.removeEntry('a.jpg');
  await source.put(`${quarantined.folderName}/files/a.jpg`, 'tampered');
  const corrupt = await restoreQuarantine(source);
  assert.equal(corrupt.restored, 0); assert.equal(corrupt.errors.length, 1);
  await assert.rejects(source.read('a.jpg'));
});

test('crash between deletion and final manifest update remains recoverable', async () => {
  const {source} = roots();
  await source.put('a.jpg', 'original');
  const quarantined = await quarantineRecords(await collectPhotos(source), source);
  await editManifest(source, quarantined.folderName, manifest => { manifest.entries[0].status = 'removing'; });
  const result = await restoreQuarantine(source);
  assert.equal(result.restored, 1); assert.equal(await (await source.read('a.jpg')).text(), 'original');
});

test('quarantine cancellation before start never removes original', async () => {
  const {source} = roots();
  await source.put('a.jpg', 'original');
  const controller = new AbortController(); controller.abort();
  const result = await quarantineRecords(await collectPhotos(source), source, {signal: controller.signal});
  assert.equal(result.quarantined, 0); assert.equal(result.cancelled, true);
  assert.equal(await (await source.read('a.jpg')).text(), 'original');
});

test('quarantine rejects stale source and never copies it', async () => {
  const {source} = roots();
  await source.put('a.jpg', 'original');
  const [record] = await collectPhotos(source); record.handle.lastModified++;
  const result = await quarantineRecords([record], source);
  assert.equal(result.quarantined, 0); assert.equal(result.errors.length, 1);
  assert.equal(await (await source.read('a.jpg')).text(), 'original');
});

test('failure to persist deletion intention never deletes original', async () => {
  const {source} = roots();
  await source.put('a.jpg', 'original');
  source.onFileWrite = (file, pending) => {
    if (file.name === 'manifest.json' && new TextDecoder().decode(pending).includes('"removing"')) file.failClose = true;
  };
  const result = await quarantineRecords(await collectPhotos(source), source);
  assert.equal(result.quarantined, 0); assert.equal(result.errors.length, 1);
  assert.equal(await (await source.read('a.jpg')).text(), 'original');
  assert.equal(await (await source.read(`${result.folderName}/files/a.jpg`)).text(), 'original');
});

test('failed backup write never deletes original', async () => {
  const {source} = roots();
  await source.put('a.jpg', 'original');
  source.onFileWrite = file => { if (file.name === 'a.jpg') file.failClose = true; };
  const result = await quarantineRecords(await collectPhotos(source), source);
  assert.equal(result.quarantined, 0); assert.equal(result.errors.length, 1);
  assert.equal(await (await source.read('a.jpg')).text(), 'original');
  await assert.rejects(source.read(`${result.folderName}/files/a.jpg`));
});
