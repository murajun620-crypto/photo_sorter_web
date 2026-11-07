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

/** One detected face can confirm at most one registered identity. */
export function assignFace(face, profiles, {maxDistance, ambiguityMargin = .05, negativeMargin = .03}) {
  if (!Number.isFinite(maxDistance) || maxDistance < 0 || !Number.isFinite(ambiguityMargin) || ambiguityMargin < 0 ||
      !Number.isFinite(negativeMargin) || negativeMargin < 0) {
    throw new Error('顔の判定しきい値を正しく指定してください。');
  }
  const activeIds = [...new Set(profiles.map(person => person.id).filter(id => typeof id === 'string' && id))];
  const ranked = activeIds.map(id => ({id, distance: face?.distances?.[id]}))
    .filter(item => Number.isFinite(item.distance) && item.distance >= 0)
    .sort((a,b) => a.distance-b.distance);
  const best = ranked[0], runnerUp = ranked[1];
  const gap = runnerUp ? runnerUp.distance-best.distance : null;
  const result = {personId:null, status:'unknown', candidateIds:[], distance:best?.distance ?? null,
    runnerUpDistance:runnerUp?.distance ?? null, margin:gap, reviewReason:null};
  const accepted = activeIds.filter(id => face?.feedback?.[id] === 'ok');
  const rejected = activeIds.filter(id => face?.feedback?.[id] === 'ng');
  if (accepted.length === 1) {
    // This specific face was identified by the user, even if the model score
    // is absent or favors somebody else. Never assign an additional identity.
    const id = accepted[0];
    const positive = ranked.find(item => item.id === id)?.distance ?? null;
    const other = ranked.find(item => item.id !== id)?.distance ?? null;
    return {...result, personId:id, status:'matched', candidateIds:[id], distance:positive,
      runnerUpDistance:other, margin:positive !== null && other !== null ? other-positive : null};
  }
  if (accepted.length > 1) {
    // Conflicting manual labels are reviewable, not multiple people in one face.
    return {...result, status:'rejected', candidateIds:accepted, reviewReason:'feedback'};
  }
  if (!best) return rejected.length
    ? {...result, status:'rejected', candidateIds:rejected, reviewReason:'feedback'} : result;
  const epsilon = 1e-12;
  const negative = face?.rejectDistances?.[best.id];
  if (rejected.includes(best.id) || Number.isFinite(negative) && negative >= 0 && negative <= best.distance+negativeMargin+epsilon) {
    // A rejected best candidate cannot silently fall through to the runner-up.
    return {...result, status:'rejected', candidateIds:[best.id], reviewReason:'feedback'};
  }
  const nearby = ranked.filter(item => item.distance <= maxDistance+.10+epsilon && item.distance <= best.distance+.10+epsilon);
  if (best.distance <= maxDistance+epsilon) {
    // Exact ties remain unresolved even if a caller chooses a zero margin.
    if (runnerUp && (gap <= epsilon || gap+epsilon < ambiguityMargin)) {
      return {...result, status:'ambiguous', candidateIds:nearby.map(item => item.id)};
    }
    return {...result, personId:best.id, status:'matched', candidateIds:[best.id]};
  }
  if (best.distance <= maxDistance+.10+epsilon) {
    return {...result, status:'near', candidateIds:nearby.slice(0,2).map(item => item.id)};
  }
  return result;
}

export function classifyPhoto(record, profiles, {useFaces, maxDistance, blurThreshold, skipBlur, mode, ambiguityMargin = .05, negativeMargin = .03}) {
  if (record.error) return {...record, matchedIds: [], faceMatches:[], reviewIds:[], needsReview:false, reviewReason:null,
    match:false, sharpness:null, sharpnessBasis:null, blurry:false, selected:false};
  const faces = record.faces ?? [];
  const faceMatches = faces.map((face,faceIndex) => ({faceIndex, ...assignFace(face,profiles,{maxDistance,ambiguityMargin,negativeMargin})}));
  const activeIds = new Set(profiles.map(p => p.id));
  const confirmedIds = new Set(faceMatches.filter(face => face.status === 'matched').map(face => face.personId));
  const ids = [...activeIds].filter(id => confirmedIds.has(id));
  // A removed profile must not keep an old manual match alive.
  const matchedIds = record.manualPeople == null ? ids
    : [...new Set(record.manualPeople.filter(id => activeIds.has(id)))];
  const unresolved = faceMatches.filter(face => face.status === 'ambiguous' || face.status === 'near' || face.status === 'rejected');
  const manual = record.manualPeople != null;
  const needsReview = Boolean(useFaces && !manual && (!faces.length || unresolved.length));
  const reviewIds = needsReview ? [...new Set(unresolved.flatMap(face => face.candidateIds))] : [];
  const reviewReason = !needsReview ? null : !faces.length ? 'no-face'
    : unresolved.some(face => face.status === 'rejected') ? 'feedback'
      : unresolved.some(face => face.status === 'ambiguous') ? 'ambiguous' : 'near';
  // A close score for another identity must not choose the wrong face's blur.
  const targetFaces = faceMatches.filter(face => face.status === 'matched' && matchedIds.includes(face.personId))
    .map(face => faces[face.faceIndex]);
  const sharpnessBasis = useFaces && targetFaces.length ? 'face' : 'whole';
  const sharpness = sharpnessBasis === 'face' ? Math.min(...targetFaces.map(f => f.blur)) : record.fullBlur;
  const blurry = sharpness < blurThreshold;
  const match = !useFaces || (mode === 'all' ? profiles.length > 0 && profiles.every(p => matchedIds.includes(p.id)) : matchedIds.length > 0);
  return {...record, matchedIds, faceMatches, reviewIds, needsReview, reviewReason, sharpness, sharpnessBasis, blurry, match,
    selected: match && !(skipBlur && blurry)};
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
