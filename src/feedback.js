import {faceDistance} from './imaging.js?v=1.1.0';
import {ENGINE_ID,assertCurrentFeature} from './recognition.js?v=1.1.0';

const SAME_FACE_EPSILON = 1e-6;

function validateEngines(records,profiles){
  const features=[...profiles.flatMap(person=>[...(person.refs||[]),...(person.negatives||[])]),
    ...records.flatMap(record=>(record.faces||[]).filter(face=>face?.descriptor?.length))];
  const declared=[...records,...profiles,...features].map(value=>value?.engineId).filter(Boolean);
  // Untagged legacy vectors are supported by pure helper callers. Main-app
  // features and owners always carry a tag, making mixed banks fail closed.
  if(!declared.length)return;
  if(declared.some(id=>id!==ENGINE_ID))throw new Error('異なる認識方式の顔データが混在しています。元の写真から登録・解析し直してください。');
  features.forEach(assertCurrentFeature);
}

function descriptor(value) {
  if (!value || !Number.isInteger(value.length) || value.length < 1 ||
      !Array.from(value).every(Number.isFinite)) {
    throw new Error('顔の特徴データが正しくありません。写真を解析し直してください。');
  }
  const copy = Float32Array.from(value);
  if (!Array.from(copy).every(Number.isFinite)) {
    throw new Error('顔の特徴データが正しくありません。写真を解析し直してください。');
  }
  return copy;
}

function examples(values = []) {
  if (!Array.isArray(values)) throw new Error('人物の登録データを確認してください。');
  return values.map(value => descriptor(value?.descriptor));
}

function sameExample(feature, values) {
  const distance = faceDistance([feature], examples(values));
  return distance !== null && distance <= SAME_FACE_EPSILON;
}

function faceKey(record, faceIndex) {
  if (!record || typeof record.id !== 'string' || !record.id ||
      !Number.isInteger(faceIndex) || faceIndex < 0 || !record.faces?.[faceIndex]) {
    throw new Error('確認する顔が見つかりません。写真を解析し直してください。');
  }
  return `${record.id}:${faceIndex}`;
}

/**
 * Prefer uncertain faces, while retaining one clear positive and one nearest
 * negative when enough slots are available. The returned descriptors are copies.
 */
export function collectFeedbackCandidates(records, profile, {maxDistance = .52, limit = 20, reviewAnswered = false} = {}) {
  if (!profile || typeof profile.id !== 'string') throw new Error('確認する人物を選んでください。');
  if (!Number.isFinite(maxDistance) || maxDistance < 0 || !Number.isInteger(limit) || limit < 0) {
    throw new Error('確認する写真の条件が正しくありません。');
  }
  if (!limit) return [];
  validateEngines(records||[],[profile]);
  const refs = examples(profile.refs);
  if (!refs.length) return [];
  const candidates = [], seen = new Set();
  for (const record of records || []) {
    if (!record.analyzed || record.error || !Array.isArray(record.faces)) continue;
    for (let faceIndex = 0; faceIndex < record.faces.length; faceIndex++) {
      const face = record.faces[faceIndex];
      const answered=Boolean(face?.feedback?.[profile.id]);
      if (!face?.descriptor?.length || (reviewAnswered?!answered:answered)) continue;
      const key = faceKey(record, faceIndex);
      if (seen.has(key)) continue;
      seen.add(key);
      const feature = descriptor(face.descriptor);
      const distance = faceDistance([feature], refs);
      if (distance === null || distance <= SAME_FACE_EPSILON&&!reviewAnswered) continue;
      candidates.push({key, recordId: record.id, faceIndex, descriptor: feature,engineId:face.engineId,
        box: face.box ? {...face.box} : null, distance, relative: record.relative || record.file?.name || ''});
    }
  }
  const order = new Map(candidates.map((candidate, index) => [candidate.key, index]));
  const compare = (a, b) => Math.abs(a.distance - maxDistance) - Math.abs(b.distance - maxDistance) || order.get(a.key) - order.get(b.key);
  candidates.sort(compare);
  const chosen = candidates.slice(0, limit);
  if (limit >= 3) {
    const clearPositive = candidates.filter(candidate => candidate.distance <= maxDistance)
      .reduce((best, candidate) => !best || candidate.distance < best.distance ? candidate : best, null);
    const nearestNegative = candidates.filter(candidate => candidate.distance > maxDistance)
      .reduce((best, candidate) => !best || candidate.distance < best.distance ? candidate : best, null);
    const reserved = new Set([clearPositive?.key, nearestNegative?.key].filter(Boolean));
    for (const candidate of [clearPositive, nearestNegative].filter(Boolean)) {
      if (chosen.some(value => value.key === candidate.key)) continue;
      const replacement = chosen.findLastIndex(value => !reserved.has(value.key));
      if (replacement >= 0) chosen[replacement] = candidate;
    }
  }
  return chosen.sort(compare);
}

/**
 * Apply a user's answer locally. Only this helper's feedback-owned examples are
 * removed on correction; manually enrolled references are always retained.
 * Root must attach a thumbnail URL/Blob to a returned new positive reference.
 */
export function applyFaceFeedback(profiles, record, faceIndex, personId, decision, {makeId} = {}) {
  if (!['ok', 'ng'].includes(decision)) throw new Error('OKまたはNGを選んでください。');
  const profile = profiles?.find(person => person.id === personId);
  if (!profile) throw new Error('確認する人物が見つかりません。');
  const key = faceKey(record, faceIndex), face = record.faces[faceIndex];
  validateEngines([record],profiles);
  const feature = descriptor(face.descriptor);
  // Validate dimensions before changing any existing feedback.
  for (const person of profiles) {
    faceDistance([feature], examples(person.refs));
    faceDistance([feature], examples(person.negatives));
  }
  if (face.feedback?.[personId] === decision) return {changed: false, addedReference: false, profile};
  const owned = entry => entry?.source === 'feedback' && entry.feedbackKey === key;
  const removedReferences = [];
  for (const person of profiles) {
    const correctingTarget = person.id === personId;
    const clearingOtherPositive = decision === 'ok' && face.feedback?.[person.id] === 'ok';
    if (!correctingTarget && !clearingOtherPositive) continue;
    removedReferences.push(...(person.refs || []).filter(owned));
    person.refs = (person.refs || []).filter(entry => !owned(entry));
    if (correctingTarget) person.negatives = (person.negatives || []).filter(entry => !owned(entry));
    else delete face.feedback[person.id];
  }
  face.feedback ||= {};
  face.feedback[personId] = decision;
  profile.refs ||= [];
  profile.negatives ||= [];
  const values = decision === 'ok' ? profile.refs : profile.negatives;
  let reference;
  if (!sameExample(feature, values)) {
    const example = {id: makeId?.() || `feedback:${key}:${personId}:${decision}`,
      descriptor: feature, engineId:face.engineId, feedbackKey: key, source: 'feedback'};
    values.push(example);
    if (decision === 'ok') reference = example;
  }
  return {changed: true, addedReference: Boolean(reference), reference, profile, removedReferences};
}

/** Re-score cached face descriptors without decoding or re-uploading photos. */
export function recomputeFaceDistances(records, profiles) {
  validateEngines(records||[],profiles);
  const references = profiles.map(profile => ({id: profile.id, refs: examples(profile.refs), negatives: examples(profile.negatives)}));
  const updates = [];
  let updatedFaces = 0, missingDescriptors = 0;
  for (const record of records || []) {
    const faces = Array.isArray(record.faces) ? record.faces : [];
    const faceUpdates = faces.map(face => {
      const feature = face?.descriptor?.length ? descriptor(face.descriptor) : null;
      if (feature) updatedFaces++; else missingDescriptors++;
      const distances = {}, rejectDistances = {};
      for (const person of references) {
        distances[person.id] = feature ? faceDistance([feature], person.refs) : null;
        rejectDistances[person.id] = feature ? faceDistance([feature], person.negatives) : null;
      }
      return {face, distances, rejectDistances};
    });
    const distances = Object.fromEntries(references.map(person => {
      const values = faceUpdates.map(update => update.distances[person.id]).filter(Number.isFinite);
      return [person.id, values.length ? Math.min(...values) : null];
    }));
    updates.push({record, faceUpdates, distances});
  }
  // Commit after validation, so malformed data cannot leave a half-scored batch.
  for (const update of updates) {
    for (const face of update.faceUpdates) Object.assign(face.face, {distances: face.distances, rejectDistances: face.rejectDistances});
    update.record.distances = update.distances;
  }
  return {updatedFaces, missingDescriptors};
}
