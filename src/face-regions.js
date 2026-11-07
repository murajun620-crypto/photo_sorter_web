import {detectFaces} from './imaging.js?v=1.0.2';

/** Normalize a drag in either direction and clip it to the oriented photo. */
export function normalizeRegion(box, width, height, {minSize = 16} = {}) {
  if (![width, height, minSize].every(value => Number.isFinite(value) && value > 0) ||
      !box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) {
    throw new Error('顔の範囲を正しく指定してください。');
  }
  const x0 = Math.max(0, Math.min(width, Math.min(box.x, box.x + box.width)));
  const y0 = Math.max(0, Math.min(height, Math.min(box.y, box.y + box.height)));
  const x1 = Math.max(0, Math.min(width, Math.max(box.x, box.x + box.width)));
  const y1 = Math.max(0, Math.min(height, Math.max(box.y, box.y + box.height)));
  if (x1 - x0 < minSize || y1 - y0 < minSize) {
    throw new Error('顔の範囲が小さすぎます。顔全体を少し大きめに囲んでください。');
  }
  return {x: x0, y: y0, width: x1 - x0, height: y1 - y0};
}

export function regionFromPoints(start, end, width, height, options) {
  if (!start || !end) throw new Error('顔の範囲を正しく指定してください。');
  return normalizeRegion({x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y}, width, height, options);
}

/** Add enough context for detection, while bounding intermediate canvas memory. */
export function regionCanvasPlan(box, width, height, {padding = 0.12} = {}) {
  if (!Number.isFinite(padding) || padding < 0 || padding > 2) throw new Error('顔の範囲を正しく指定してください。');
  const region = normalizeRegion(box, width, height);
  const marginX = region.width * padding;
  const marginY = region.height * padding;
  const crop = normalizeRegion({x: region.x - marginX, y: region.y - marginY,
    width: region.width + marginX * 2, height: region.height + marginY * 2}, width, height, {minSize: 1});
  const edge = Math.max(crop.width, crop.height);
  const scale = Math.min(4, Math.max(1, 320 / edge), 1280 / edge);
  return {region, crop, width: Math.max(1, Math.round(crop.width * scale)), height: Math.max(1, Math.round(crop.height * scale))};
}

const defaultCanvas = () => document.createElement('canvas');

/**
 * Re-detect inside a user-selected region before enrolling a reference.
 * A rectangle by itself is not evidence of a face: blank and ambiguous regions
 * remain editable rather than silently enrolling a meaningless/wrong identity.
 */
export async function descriptorFromRegion(canvas, box, {detect = detectFaces, createCanvas = defaultCanvas} = {}) {
  const seen = new Set();
  // A tightly drawn face can fill the detector's input. Gradually include the
  // surrounding head/background so the same face is seen at a useful scale.
  for (const padding of [0.12, 0.35, 0.65, 1]) {
    const plan = regionCanvasPlan(box, canvas?.width, canvas?.height, {padding});
    const key = Object.values(plan.crop).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const input = createCanvas(plan.width, plan.height);
    input.width = plan.width;
    input.height = plan.height;
    try {
      const context = input.getContext('2d', {alpha: false});
      if (!context) throw new Error('顔の範囲を読み込めません。ほかのタブを閉じて再試行してください。');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, input.width, input.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      const crop = plan.crop;
      context.drawImage(canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, input.width, input.height);
      const detections = await detect(input);
      const faces = (detections || []).map(face => {
        const detected = normalizeRegion(face.box, input.width, input.height, {minSize: 1});
        const resultBox = normalizeRegion({
          x: crop.x + detected.x * crop.width / input.width,
          y: crop.y + detected.y * crop.height / input.height,
          width: detected.width * crop.width / input.width,
          height: detected.height * crop.height / input.height,
        }, canvas.width, canvas.height, {minSize: 1});
        return {descriptor: face.descriptor, box: resultBox};
      }).filter(face => {
        // Friends found only in extra context must never become the target.
        const centerX = face.box.x + face.box.width / 2;
        const centerY = face.box.y + face.box.height / 2;
        const region = plan.region;
        return centerX >= region.x && centerX <= region.x + region.width && centerY >= region.y && centerY <= region.y + region.height;
      });
      if (!faces.length) continue;
      if (faces.length !== 1) {
        throw new Error('範囲内に複数の顔が見つかりました。登録する1人の顔だけを囲んでください。');
      }
      const feature = faces[0].descriptor;
      if (!feature?.length || !Array.from(feature).every(Number.isFinite)) {
        throw new Error('この顔の特徴を読み取れませんでした。囲み直すか、別の写真を選んでください。');
      }
      return {descriptor: Float32Array.from(feature), box: faces[0].box};
    } finally {
      input.width = 1;
      input.height = 1;
    }
  }
  throw new Error('この範囲では顔を確認できませんでした。顔全体を囲み直してください。別の写真でも登録できます。');
}
