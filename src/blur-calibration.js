/** Local calibration fits labeled examples; it does not certify photo quality. */
const validScore = value => Number.isFinite(value) && value >= 0;
const validLabel = label => label === 'sharp' || label === 'blur';

/**
 * Infer a threshold only when all labeled blurry scores fall strictly below
 * all labeled sharp scores. An overlap remains unconfigured, not auto-filtered.
 * Samples with IDs are deduplicated; the latest valid label for an ID wins.
 */
export function inferBlurCalibration(samples = [], {minPerClass = 3} = {}) {
  if (!Number.isInteger(minPerClass) || minPerClass < 1) {
    throw new Error('基準に使う写真の枚数を正しく指定してください。');
  }
  const identified = new Map();
  const anonymous = [];
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (!sample || !validScore(sample.score) || !validLabel(sample.label)) continue;
    if (typeof sample.id === 'string' && sample.id) identified.set(sample.id, sample);
    else anonymous.push(sample);
  }
  const examples = [...identified.values(), ...anonymous];
  const sharp = examples.filter(sample => sample.label === 'sharp').map(sample => sample.score);
  const blur = examples.filter(sample => sample.label === 'blur').map(sample => sample.score);
  const maxBlurScore = blur.length ? Math.max(...blur) : null;
  const minSharpScore = sharp.length ? Math.min(...sharp) : null;
  const result = {
    ready: false, threshold: null, sharpCount: sharp.length, blurCount: blur.length,
    sampleCount: examples.length, minPerClass, maxBlurScore, minSharpScore,
    reason: 'insufficient',
  };
  if (sharp.length < minPerClass || blur.length < minPerClass) return result;
  if (maxBlurScore >= minSharpScore) return {...result, reason: 'overlap'};
  // This form avoids overflow for large finite nonnegative scores.
  const midpoint = maxBlurScore + (minSharpScore - maxBlurScore) / 2;
  const threshold = midpoint > maxBlurScore ? midpoint : minSharpScore;
  return {...result, ready: true, threshold, reason: 'ready'};
}

/** Different dates and face/whole-image score populations do not share a fit. */
export function calibrationKey(record) {
  const date = typeof record?.date === 'string' && record.date ? record.date : '日付不明';
  const basis = typeof record?.sharpnessBasis === 'string' && record.sharpnessBasis
    ? record.sharpnessBasis : 'whole';
  return `${date}|${basis}`;
}

/** Create a status for every scored group, including groups with no labels. */
export function deriveCalibrations(records = [], options) {
  const groups = new Map();
  const latestRecords = new Map();
  const anonymous = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.analyzed || record.error || !validScore(record.sharpness)) continue;
    if (typeof record.id === 'string' && record.id) latestRecords.set(record.id, record);
    else anonymous.push(record);
  }
  for (const record of [...latestRecords.values(), ...anonymous]) {
    const key = calibrationKey(record);
    if (!groups.has(key)) groups.set(key, []);
    // Real record IDs are required for distinct-photo calibration evidence.
    if (typeof record.id === 'string' && record.id && validLabel(record.blurLabel)) {
      groups.get(key).push({id: record.id, score: record.sharpness, label: record.blurLabel});
    }
  }
  return new Map([...groups].map(([key, samples]) => [key, inferBlurCalibration(samples, options)]));
}

/** Manual labels win. No enabled, ready calibration means no automatic blur. */
export function reviewBlur(record, calibrations, {enabled = false} = {}) {
  const calibration = calibrations instanceof Map ? calibrations.get(calibrationKey(record)) ?? null : null;
  if (validLabel(record?.blurLabel)) {
    return {blurry: record.blurLabel === 'blur', blurUncertain: false, calibration};
  }
  if (!enabled || !record?.analyzed || record.error || !validScore(record.sharpness)) {
    return {blurry: false, blurUncertain: false, calibration};
  }
  if (!calibration?.ready || !validScore(calibration.threshold)) {
    return {blurry: false, blurUncertain: true, calibration};
  }
  return {blurry: record.sharpness < calibration.threshold, blurUncertain: false, calibration};
}
