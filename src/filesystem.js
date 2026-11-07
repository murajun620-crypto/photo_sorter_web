// File System Access operations. Photo bytes stay in this browser and local disk.
export const QUARANTINE_FOLDER = '_PhotoSorter_退避';
export const OUTPUT_FOLDER = '_PhotoSorter_出力';
const RESERVED = new Set([QUARANTINE_FOLDER, OUTPUT_FOLDER]);
const PHOTO = /\.(jpe?g|png)$/i;
const MANIFEST = 'manifest.json';

const cancelled = signal => Boolean(signal?.aborted);
const message = error => error instanceof Error ? error.message : String(error);
const progress = (fn, done, total, path) => fn?.(done, total, path);
const signature = file => ({size: file.size, lastModified: file.lastModified});
const sameSignature = (a, b) => a?.size === b?.size && a?.lastModified === b?.lastModified;
const relative = parts => parts.join('/');

function validateParts(parts, {photo = false, allowReserved = false} = {}) {
  if (!Array.isArray(parts) || !parts.length || parts.some(part =>
    typeof part !== 'string' || !part || part === '.' || part === '..' ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
    (!allowReserved && RESERVED.has(part)))) {
    throw new Error('安全でないファイル名・フォルダ名が含まれています。');
  }
  if (photo && !PHOTO.test(parts.at(-1))) throw new Error('JPEG・PNG以外のファイルは操作できません。');
  return parts;
}

// Shared with ZIP export: never place traversal or Windows path separators in an archive.
export function validatedOutputParts(record) {
  const original = validateParts(record.parts, {photo: true});
  const parts = [...validateParts(record.outputParts || original, {photo: true})];
  if (parts.at(-1) !== original.at(-1)) throw new Error('出力ファイル名が元の写真名と一致しません。');
  return parts;
}

function sessionName(prefix = 'PhotoSorter') {
  const date = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${prefix}_${stamp}_${crypto.randomUUID().slice(0, 8)}`;
}

async function lookup(directory, name) {
  try { return await directory.getFileHandle(name); }
  catch (error) {
    if (error.name === 'TypeMismatchError') return await directory.getDirectoryHandle(name);
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
}

async function assertWritePermission(handle) {
  if (handle.queryPermission && await handle.queryPermission({mode: 'readwrite'}) !== 'granted') {
    throw new Error('フォルダへの書き込み許可が必要です。フォルダを選び直してください。');
  }
}

async function freshDirectory(parent, prefix) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = sessionName(prefix);
    if (!await lookup(parent, name)) return {name, handle: await parent.getDirectoryHandle(name, {create: true})};
  }
  throw new Error('新しい出力フォルダを作成できませんでした。');
}

async function directories(root, parts, create = false) {
  let current = root;
  for (const part of parts) current = await current.getDirectoryHandle(part, {create});
  return current;
}

async function writeBlob(parent, name, blob, {signal, overwrite = false} = {}) {
  if (cancelled(signal)) throw new DOMException('処理を中止しました。', 'AbortError');
  if (!overwrite && await lookup(parent, name)) throw new Error('同名のファイルがあるため、上書きしませんでした。');
  const handle = await parent.getFileHandle(name, {create: true});
  let stream;
  let closed = false;
  try {
    stream = await handle.createWritable({keepExistingData: false});
    await stream.write(blob);
    if (cancelled(signal)) throw new DOMException('処理を中止しました。', 'AbortError');
    await stream.close();
    closed = true;
    const written = await handle.getFile();
    if (written.size !== blob.size) throw new Error('書き込んだファイルのサイズを確認できませんでした。');
    return handle;
  } catch (error) {
    if (stream && !closed) await stream.abort().catch(() => {});
    if (!overwrite) {
      const current = await lookup(parent, name).catch(() => null);
      if (current && await current.isSameEntry(handle)) await parent.removeEntry(name).catch(() => {});
    }
    throw error;
  }
}

async function writeJSON(directory, name, value) {
  return writeBlob(directory, name, new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}), {overwrite: true});
}

async function sha256(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyRecordLocation(record, sourceHandle) {
  validateParts(record.parts, {photo: true});
  const actual = await sourceHandle.resolve(record.handle);
  if (!actual || relative(actual) !== relative(record.parts)) throw new Error('写真の場所が解析時と変わっています。再解析してください。');
  const parent = await directories(sourceHandle, record.parts.slice(0, -1));
  if (!await parent.isSameEntry(record.parent)) throw new Error('写真の親フォルダを確認できませんでした。');
}

export async function collectPhotos(directoryHandle, {signal, onProgress} = {}) {
  const records = [];
  async function walk(parent, parts) {
    for await (const [name, handle] of parent.entries()) {
      if (cancelled(signal)) return;
      if (handle.kind === 'directory') {
        if (!RESERVED.has(name)) await walk(handle, [...parts, name]);
      } else if (PHOTO.test(name)) {
        const file = await handle.getFile();
        const full = [...parts, name];
        records.push({id: crypto.randomUUID(), file, handle, parent, parts: full, relative: relative(full), signature: signature(file)});
        progress(onProgress, records.length, 0, relative(full));
      }
    }
  }
  await walk(directoryHandle, []);
  return records.sort((a, b) => a.relative.localeCompare(b.relative, 'ja'));
}

export async function verifyUnchanged(record) {
  const file = await record.handle.getFile();
  if (!sameSignature(signature(file), record.signature)) throw new Error('解析後に写真が変更されています。再解析してください。');
  return file;
}

export async function exportRecords(records, outputHandle, sourceHandle, {
  targetBytes = null, allowResize = true, signal, onProgress, compressFn,
} = {}) {
  await assertWritePermission(outputHandle);
  const relation = await sourceHandle.resolve(outputHandle);
  if (await sourceHandle.isSameEntry(outputHandle) || relation !== null) {
    throw new Error('出力先は元の写真フォルダの外側を選んでください。');
  }
  if (targetBytes !== null && (!Number.isSafeInteger(targetBytes) || targetBytes < 10_000)) throw new Error('目標サイズは10 KB以上にしてください。');
  if (targetBytes !== null && typeof compressFn !== 'function') throw new Error('圧縮処理を利用できません。');
  const run = await freshDirectory(outputHandle, 'PhotoSorter');
  const result = {folderName: run.name, exported: 0, errors: [], cancelled: false};
  const report = {version: 1, createdAt: new Date().toISOString(), targetBytes, files: []};
  for (let index = 0; index < records.length; index++) {
    if (cancelled(signal)) break;
    const record = records[index];
    const row = {source: record.relative, date: record.date ?? null, dateSource: record.dateSource ?? null, event: record.event ?? null, people: record.people ?? [], status: 'error'};
    let destination;
    let targetName;
    let written;
    try {
      await verifyRecordLocation(record, sourceHandle);
      const parts = validatedOutputParts(record);
      const file = await verifyUnchanged(record);
      let blob = file;
      if (targetBytes !== null) {
        const compressed = await compressFn(file, targetBytes, {allowResize, signal});
        blob = compressed instanceof Blob ? compressed : compressed?.blob;
        if (!(blob instanceof Blob) || blob.size > targetBytes || blob.size === 0) throw new Error('指定容量以下への圧縮に失敗しました。');
        parts[parts.length - 1] += '.jpg';
      }
      await verifyUnchanged(record);
      destination = await directories(run.handle, parts.slice(0, -1), true);
      targetName = parts.at(-1);
      written = await writeBlob(destination, targetName, blob, {signal});
      await verifyUnchanged(record);
      row.status = 'exported';
      row.output = relative(parts);
      row.sourceBytes = file.size;
      row.outputBytes = blob.size;
      result.exported++;
    } catch (error) {
      if (written && destination) await destination.removeEntry(targetName).catch(() => {});
      row.error = message(error);
      row.status = error.name === 'AbortError' ? 'cancelled' : 'error';
      if (error.name !== 'AbortError') result.errors.push({path: record.relative, error: message(error)});
    }
    report.files.push(row);
    progress(onProgress, index + 1, records.length, record.relative);
  }
  result.cancelled = cancelled(signal);
  report.summary = result;
  await writeJSON(run.handle, '処理結果.json', report);
  return result;
}

export async function quarantineRecords(records, sourceHandle, {signal, onProgress} = {}) {
  await assertWritePermission(sourceHandle);
  const reserved = await sourceHandle.getDirectoryHandle(QUARANTINE_FOLDER, {create: true});
  const run = await freshDirectory(reserved, '退避');
  const files = await run.handle.getDirectoryHandle('files', {create: true});
  const manifest = {version: 1, type: 'PhotoSorterQuarantine', createdAt: new Date().toISOString(), entries: []};
  await writeJSON(run.handle, MANIFEST, manifest);
  const result = {folderName: `${QUARANTINE_FOLDER}/${run.name}`, quarantined: 0, errors: [], cancelled: false, paths: [], ids: []};
  for (let index = 0; index < records.length; index++) {
    if (cancelled(signal)) break;
    const record = records[index];
    let entry;
    try {
      await verifyRecordLocation(record, sourceHandle);
      const file = await verifyUnchanged(record);
      const digest = await sha256(file);
      const parent = await directories(files, record.parts.slice(0, -1), true);
      const backup = await writeBlob(parent, record.parts.at(-1), file, {signal});
      const backupFile = await backup.getFile();
      if (backupFile.size !== file.size || await sha256(backupFile) !== digest) throw new Error('退避先の内容を検証できませんでした。元の写真は削除していません。');
      const current = await verifyUnchanged(record);
      if (await sha256(current) !== digest) throw new Error('退避中に写真の内容が変わりました。元の写真は削除していません。');
      entry = {originalParts: [...record.parts], relative: record.relative, signature: {...record.signature}, sha256: digest, status: 'backed_up'};
      manifest.entries.push(entry);
      await writeJSON(run.handle, MANIFEST, manifest);
      if (cancelled(signal)) break;
      await verifyRecordLocation(record, sourceHandle);
      await verifyUnchanged(record);
      entry.status = 'removing';
      // Persist intention before deleting. A crash after deletion is recoverable.
      await writeJSON(run.handle, MANIFEST, manifest);
      if (cancelled(signal)) {
        entry.status = 'backed_up';
        await writeJSON(run.handle, MANIFEST, manifest);
        break;
      }
      await verifyUnchanged(record);
      await record.parent.removeEntry(record.parts.at(-1));
      entry.status = 'removed';
      result.quarantined++;
      result.paths.push(record.relative);
      result.ids.push(record.id);
      await writeJSON(run.handle, MANIFEST, manifest);
    } catch (error) {
      if (entry && entry.status !== 'removed') {
        entry.status = 'remove_failed';
        entry.error = message(error);
        await writeJSON(run.handle, MANIFEST, manifest).catch(() => {});
      }
      if (error.name !== 'AbortError') result.errors.push({path: record.relative, error: message(error)});
    }
    progress(onProgress, index + 1, records.length, record.relative);
  }
  result.cancelled = cancelled(signal);
  return result;
}

export async function restoreQuarantine(sourceHandle, {signal, onProgress} = {}) {
  await assertWritePermission(sourceHandle);
  const result = {restored: 0, errors: [], cancelled: false, paths: []};
  let reserved;
  try { reserved = await sourceHandle.getDirectoryHandle(QUARANTINE_FOLDER); }
  catch (error) { if (error.name === 'NotFoundError') return result; throw error; }
  let completed = 0;
  for await (const [session, run] of reserved.entries()) {
    if (cancelled(signal)) break;
    if (run.kind !== 'directory') continue;
    let manifest;
    try {
      const manifestFile = await (await run.getFileHandle(MANIFEST)).getFile();
      if (manifestFile.size > 25_000_000) throw new Error('退避記録が大きすぎます。');
      manifest = JSON.parse(await manifestFile.text());
      if (manifest.version !== 1 || manifest.type !== 'PhotoSorterQuarantine' || !Array.isArray(manifest.entries)) throw new Error('退避記録の形式を確認できませんでした。');
    } catch (error) {
      result.errors.push({path: `${QUARANTINE_FOLDER}/${session}`, error: message(error)});
      continue;
    }
    for (const entry of manifest.entries) {
      if (cancelled(signal)) break;
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.originalParts)) {
        result.errors.push({path: `${QUARANTINE_FOLDER}/${session}`, error: '退避記録に不正な項目があります。'});
        continue;
      }
      if (!['removed', 'removing', 'restoring'].includes(entry.status)) continue;
      let written;
      let destination;
      try {
        const parts = validateParts(entry.originalParts, {photo: true});
        if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.signature?.size) || entry.signature.size < 0) throw new Error('退避記録の検証情報が不正です。');
        const backupParent = await directories(await run.getDirectoryHandle('files'), parts.slice(0, -1));
        const backup = await (await backupParent.getFileHandle(parts.at(-1))).getFile();
        if (backup.size !== entry.signature.size || await sha256(backup) !== entry.sha256) throw new Error('退避ファイルの内容が変わっています。復元を中止しました。');
        destination = await directories(sourceHandle, parts.slice(0, -1), true);
        const existing = await lookup(destination, parts.at(-1));
        if (existing) {
          if (existing.kind !== 'file' || await sha256(await existing.getFile()) !== entry.sha256) throw new Error('元の場所に別のファイルがあるため、上書きせずにスキップしました。');
          // A crash after successful restoration or a failed removal left the original intact.
          entry.status = 'restored';
          await writeJSON(run, MANIFEST, manifest);
          continue;
        }
        entry.status = 'restoring';
        await writeJSON(run, MANIFEST, manifest);
        written = await writeBlob(destination, parts.at(-1), backup, {signal});
        if (await sha256(await written.getFile()) !== entry.sha256) throw new Error('復元したファイルの内容を確認できませんでした。');
        entry.status = 'restored';
        result.restored++;
        result.paths.push(relative(parts));
        await writeJSON(run, MANIFEST, manifest);
      } catch (error) {
        if (written && entry.status !== 'restored') await destination.removeEntry(entry.originalParts.at(-1)).catch(() => {});
        if (error.name !== 'AbortError') result.errors.push({path: relative(entry.originalParts || [session]), error: message(error)});
      }
      progress(onProgress, ++completed, 0, entry.relative || session);
    }
  }
  result.cancelled = cancelled(signal);
  return result;
}
