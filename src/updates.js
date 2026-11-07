// App files are checked over the network; work snapshots stay in this browser.
export const CURRENT_VERSION = '1.0.1';
export const CURRENT_BUILD = '20261107.1';
const SNAPSHOT_FORMAT = 'photosorter-update';
const UPDATE_PARAM = '_update';

function versionParts(value) {
  if (typeof value !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) {
    throw new Error('配信されているバージョン情報の形式が正しくありません。');
  }
  return value.split('.').map(Number);
}

export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

export function validateManifest(value) {
  versionParts(value?.version);
  if (typeof value.build !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(value.build)) {
    throw new Error('配信されているビルド情報の形式が正しくありません。');
  }
  return {version: value.version, build: value.build};
}

export function isNewRelease(latest, current = {version: CURRENT_VERSION, build: CURRENT_BUILD}) {
  const difference = compareVersions(latest.version, current.version);
  return difference > 0 || difference === 0 && latest.build !== current.build;
}

function storageError(error) {
  const detail = error?.name === 'QuotaExceededError' ? 'ブラウザの保存容量が不足しています。' : (error?.message || '一時保存を利用できません。');
  return new Error(`作業内容をブラウザ内に一時保存できませんでした。${detail}`);
}

/** IndexedDB structured cloning preserves File, Blob, typed arrays and handles. */
export function createUpdateStore(indexedDB = globalThis.indexedDB) {
  async function operation(method, key, value) {
    if (!indexedDB) throw storageError();
    const database = await new Promise((resolve, reject) => {
      let rejected = false;
      const opening = indexedDB.open('photosorter-updates', 1);
      opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains('sessions')) opening.result.createObjectStore('sessions');
      };
      opening.onerror = () => reject(storageError(opening.error));
      opening.onblocked = () => { rejected = true; reject(new Error('別のタブが一時保存を使用しています。ほかのPhotoSorterタブを閉じて再試行してください。')); };
      opening.onsuccess = () => { if (rejected) opening.result.close(); else resolve(opening.result); };
    });
    try {
      return await new Promise((resolve, reject) => {
        let request, settled = false;
        const transaction = database.transaction('sessions', method === 'get' ? 'readonly' : 'readwrite');
        const fail = error => { if (!settled) { settled = true; reject(storageError(error)); } };
        transaction.onabort = () => fail(transaction.error);
        transaction.onerror = () => fail(transaction.error);
        transaction.oncomplete = () => { if (!settled) { settled = true; resolve(request?.result); } };
        try {
          const store = transaction.objectStore('sessions');
          request = method === 'put' ? store.put(value, key) : method === 'get' ? store.get(key) : store.delete(key);
        } catch (error) {
          try { transaction.abort(); } catch { /* Already aborted. */ }
          fail(error);
        }
      });
    } finally { database.close(); }
  }
  return {get: key => operation('get', key), put: (key,value) => operation('put', key, value), delete: key => operation('delete', key)};
}

/**
 * UI nodes are supplied by the app. Snapshot state is deliberately opaque here.
 * Failed save/restore never discards the current page or the recovery record.
 */
export async function installUpdates({
  versionElement, checkButton, statusElement, restartButton, retryButton,
  getSnapshot, applySnapshot, canUpdate = () => true,
  onError = () => {}, onBusy = () => {}, onCheck = () => {},
  storage = createUpdateStore(), fetchImpl = globalThis.fetch?.bind(globalThis),
  location = globalThis.location, history = globalThis.history,
  current = {version: CURRENT_VERSION, build: CURRENT_BUILD},
  makeToken = () => globalThis.crypto.randomUUID(),
} = {}) {
  let available = null, checking = false, working = false, disposed = false;
  let recoveryToken = new URL(location.href).searchParams.get(UPDATE_PARAM);
  if (versionElement) versionElement.textContent = `v${current.version}`;
  if (restartButton) { restartButton.textContent = '更新して再開'; restartButton.hidden = true; }
  if (retryButton) { retryButton.textContent = '復元を再試行'; retryButton.hidden = true; }
  const message = (text, error = false) => {
    if (statusElement) { statusElement.textContent = text; if (statusElement.dataset) statusElement.dataset.kind = error ? 'error' : 'ready'; }
    if (error) onError(text);
  };
  const buttons = () => {
    if (checkButton) checkButton.disabled = checking || working;
    if (restartButton) restartButton.disabled = working || !available;
    if (retryButton) retryButton.disabled = working;
  };

  async function check() {
    if (checking || working || disposed) return null;
    if (!canUpdate()) { message('写真の処理が終わってから、もう一度更新を確認してください。'); onCheck(null); return null; }
    checking = true; available = null;
    if (restartButton) restartButton.hidden = true;
    message('更新を確認しています…'); buttons(); onCheck(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const url = new URL('./version.json', location.href);
      url.searchParams.set('check', String(Date.now()));
      const response = await fetchImpl(url.href, {cache:'no-store', credentials:'same-origin', signal:controller.signal});
      if (!response.ok) throw new Error(`配信情報を取得できませんでした（HTTP ${response.status}）。`);
      const latest = validateManifest(await response.json());
      if (compareVersions(latest.version, current.version) < 0) {
        message(`現在は v${current.version} です。配信情報が古いため、少し後に再確認してください。`);
      } else if (isNewRelease(latest, current)) {
        available = latest;
        if (restartButton) restartButton.hidden = false;
        message(`v${latest.version} に更新できます。開いている写真・人物登録・分類設定を維持して更新します。`);
      } else message(`最新の v${current.version} を使用しています。`);
      onCheck(latest);
      return latest;
    } catch (error) {
      message(`更新を確認できませんでした。接続を確認して再試行してください。${error.message || ''}`, true);
      return null;
    } finally { clearTimeout(timer); checking = false; buttons(); }
  }

  async function restart() {
    if (!available || working || disposed) return false;
    if (recoveryToken) { message('一時保存した作業の復元が残っています。「復元を再試行」してから更新してください。', true); return false; }
    if (!canUpdate()) { message('写真の処理が終わってから、更新してください。'); return false; }
    working = true; buttons(); onBusy(true);
    message('作業内容をブラウザ内に一時保存しています…');
    try {
      if (typeof getSnapshot !== 'function') throw new Error('作業内容の一時保存を準備できません。');
      const snapshot = await getSnapshot();
      if (snapshot == null) throw new Error('作業内容の一時保存を完了できません。');
      const token = makeToken();
      const envelope = {format:SNAPSHOT_FORMAT, schema:1, pathname:new URL(location.href).pathname,
        target:{...available}, from:{...current}, createdAt:Date.now(), state:snapshot};
      await storage.put(token,envelope);
      const url = new URL(location.href);
      url.searchParams.set(UPDATE_PARAM,token);
      location.assign(url.href);
      return true;
    } catch (error) {
      message(`更新を中止しました。現在の作業はそのままです。${error.message || ''}`,true);
      return false;
    } finally { working = false; buttons(); onBusy(false); }
  }

  async function restore() {
    if (!recoveryToken || working || disposed) return false;
    working = true; buttons(); onBusy(true);
    message('更新前の写真・人物登録を復元しています…');
    try {
      const envelope = await storage.get(recoveryToken);
      if (!envelope || envelope.format !== SNAPSHOT_FORMAT || envelope.schema !== 1 || envelope.pathname !== new URL(location.href).pathname || envelope.state == null) {
        throw new Error('このページの一時保存データが見つかりません。');
      }
      const target = envelope.target ? validateManifest(envelope.target) : null;
      if (typeof applySnapshot !== 'function') throw new Error('作業内容を復元する準備ができません。');
      await applySnapshot(envelope.state);
      const oldToken = recoveryToken;
      recoveryToken = null;
      const url = new URL(location.href); url.searchParams.delete(UPDATE_PARAM);
      history?.replaceState?.(null,'',url.href);
      if (retryButton) retryButton.hidden = true;
      // Cleanup failure must not undo a successful restoration.
      try { await storage.delete(oldToken); } catch { /* Local recovery copy remains. */ }
      if (target && isNewRelease(target, current)) {
        message(`作業は復元しましたが、更新ファイルをまだ取得できませんでした。現在は v${current.version} です。少し後に再確認してください。`);
      } else message(`v${current.version} で作業を再開しました。`);
      return true;
    } catch (error) {
      if (retryButton) retryButton.hidden = false;
      message(`作業の復元を完了できませんでした。一時保存した内容は保持しています。${error.message || ''}`,true);
      return false;
    } finally { working = false; buttons(); onBusy(false); }
  }

  const checkClick = () => { void check(); };
  const restartClick = () => { void restart(); };
  const retryClick = () => { void restore(); };
  checkButton?.addEventListener('click',checkClick);
  restartButton?.addEventListener('click',restartClick);
  retryButton?.addEventListener('click',retryClick);
  buttons();
  await restore();
  return {check,restart,restore,dispose() { disposed=true;checkButton?.removeEventListener('click',checkClick);restartButton?.removeEventListener('click',restartClick);retryButton?.removeEventListener('click',retryClick); }};
}
