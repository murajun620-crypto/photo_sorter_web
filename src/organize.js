export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function dateFromExif(value) {
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4})[:-](\d{2})[:-](\d{2})/);
    const date = match ? `${match[1]}-${match[2]}-${match[3]}` : '';
    return validDate(date) ? date : null;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return localDate(value);
  return null;
}

export function localDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return '日付不明';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function photoDate(file) {
  try {
    const tags = await globalThis.exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate'], reviveValues: false,
      translateValues: false, gps: false, xmp: false, icc: false, iptc: false,
    });
    for (const key of ['DateTimeOriginal', 'CreateDate', 'ModifyDate']) {
      const date = dateFromExif(tags?.[key]);
      if (date) return {date, dateSource: `撮影情報 (${key})`};
    }
  } catch { /* Missing or malformed metadata does not hide a valid photo. */ }
  return {date: localDate(file.lastModified), dateSource: 'ファイル更新日（撮影日なし）'};
}

export function safeName(name) {
  let result = String(name).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!result || result === '.' || result === '..') result = '名前なし';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  return result.slice(0, 70).replace(/[. ]+$/g, '');
}

export function validateEvent(event, events = []) {
  if (!String(event.name ?? '').trim()) throw new Error('イベント名を入力してください。');
  if (!validDate(event.start) || !validDate(event.end) || event.start > event.end) throw new Error('開始日と終了日を正しく指定してください。');
  const overlap = events.find(e => e.id !== event.id && event.start <= e.end && e.start <= event.end);
  if (overlap) throw new Error(`「${overlap.name}」と日付が重なっています。期間を調整してください。`);
  return {...event, name: String(event.name).trim().slice(0, 70)};
}

export function eventForDate(date, events) {
  return events.find(e => date >= e.start && date <= e.end) ?? null;
}

export function eventFolder(event) {
  return `${event.start}${event.end !== event.start ? `_${event.end}` : ''}_${safeName(event.name)}`;
}

export function classifyPhoto(record, profiles, {useFaces, maxDistance, blurThreshold, skipBlur, mode}) {
  if (record.error) return {...record, matchedIds: [], blurry: false, selected: false};
  const ids = profiles.filter(p => record.distances?.[p.id] != null && record.distances[p.id] <= maxDistance).map(p => p.id);
  const activeIds = new Set(profiles.map(p => p.id));
  // A removed profile must not keep an old manual match alive.
  const matchedIds = record.manualPeople == null ? ids
    : [...new Set(record.manualPeople.filter(id => activeIds.has(id)))];
  const targetFaces = (record.faces ?? []).filter(f => matchedIds.some(id => f.distances?.[id] != null && f.distances[id] <= maxDistance));
  const sharpness = useFaces && targetFaces.length ? Math.min(...targetFaces.map(f => f.blur)) : record.fullBlur;
  const blurry = sharpness < blurThreshold;
  const match = !useFaces || (mode === 'all' ? profiles.length > 0 && profiles.every(p => matchedIds.includes(p.id)) : matchedIds.length > 0);
  return {...record, matchedIds, sharpness, blurry, match, selected: match && !(skipBlur && blurry)};
}

export function outputPlan(records, profiles, events, {mode = 'people', useFaces = true} = {}) {
  if (mode === 'people' && useFaces) {
    const folders = new Map();
    for (const person of profiles) {
      // Windows folder names are case-insensitive, and forbidden characters
      // can cause otherwise distinct names to collapse to the same folder.
      const folder = safeName(person.name).toLowerCase();
      if (folders.has(folder)) {
        throw new Error(`人物「${folders.get(folder)}」と「${person.name}」が同じ出力フォルダ名になります。人物名を変更してください。`);
      }
      folders.set(folder, person.name);
    }
  }
  const plan = [];
  for (const record of records.filter(r => r.selected && !r.error)) {
    const event = eventForDate(record.date, events);
    const dateParts = event ? [eventFolder(event), record.date] : [record.date || '日付不明'];
    const originalParts = record.parts ?? [record.file.name];
    const people = profiles.filter(p => record.matchedIds?.includes(p.id));
    const targets = mode === 'people' && useFaces ? (people.length ? people : [{name: '人物未分類'}]) : [null];
    for (const person of targets) {
      plan.push({...record, event: event?.name ?? '', people: people.map(p => p.name),
        outputParts: [...(person ? [safeName(person.name)] : []), ...dateParts, ...originalParts]});
    }
  }
  return plan;
}
