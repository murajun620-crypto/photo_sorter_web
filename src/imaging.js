/** Local-only image processing. Only loadModels() requests the bundled models. */

export const MIN_TARGET_BYTES = 10_000;
const MAX_IMAGE_PIXELS = 64_000_000;
const MAX_IMAGE_EDGE = 16_384;
const QUALITY_MIN = 0.35;
const QUALITY_MAX = 0.95;
let modelsPromise;
let detectionQueue = Promise.resolve();

function faceApi() {
  const api = globalThis.faceapi;
  if (!api) throw new Error('顔認識ライブラリを読み込めません。ページを再読み込みしてください。');
  return api;
}

/** Load from this app's own model directory, including GitHub project Pages. */
export async function loadModels(onProgress = () => {}) {
  if (!modelsPromise) {
    modelsPromise = (async () => {
      const api = faceApi();
      const modelUrl = new URL('../models/', import.meta.url);
      if (globalThis.location && modelUrl.origin !== globalThis.location.origin) {
        throw new Error('顔認識モデルは、このアプリと同じサイトから読み込む必要があります。');
      }
      const nets = [api.nets.tinyFaceDetector, api.nets.faceLandmark68Net, api.nets.faceRecognitionNet];
      onProgress('顔認識モデルを読み込み中（0/3）');
      for (let i = 0; i < nets.length; i += 1) {
        await nets[i].loadFromUri(modelUrl.href);
        onProgress(`顔認識モデルを読み込み中（${i + 1}/3）`);
      }
      return api;
    })().catch((error) => {
      modelsPromise = undefined;
      throw new Error(`顔認識モデルを読み込めませんでした。接続と models フォルダを確認してください。\n${error.message}`);
    });
  }
  const api = await modelsPromise;
  onProgress('顔認識の準備ができました');
  return api;
}

export function fitDimensions(width, height, maxEdge) {
  if (![width, height, maxEdge].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error('画像サイズが正しくありません。');
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function newCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) throw new Error('画像処理用のメモリを確保できません。ほかのタブを閉じて再度お試しください。');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  return { canvas, context };
}

export function imageKind(header) {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'jpeg';
  if (header.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => header[index] === value)) return 'png';
  return null;
}

async function imageElement(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('画像を読み込めません。破損していない JPEG・PNG を選んでください。'));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Full-resolution, EXIF-oriented canvas. Call close() when finished with it. */
export async function decodeImage(file) {
  if (!file || typeof file.slice !== 'function') throw new Error('JPEG・PNG の写真を選んでください。');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (!imageKind(header)) throw new Error('対応形式は JPEG・PNG です。別の形式は変換してから選んでください。');
  let source;
  try {
    if (typeof globalThis.createImageBitmap === 'function') {
      try {
        source = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        source = await imageElement(file);
      }
    } else {
      source = await imageElement(file);
    }
    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;
    if (!width || !height || width * height > MAX_IMAGE_PIXELS || Math.max(width, height) > MAX_IMAGE_EDGE) {
      throw new Error('画像が大きすぎます。6400万画素・長辺16384px以内の写真を選んでください。');
    }
    const { canvas, context } = newCanvas(width, height);
    context.drawImage(source, 0, 0);
    return {
      canvas, width, height,
      close() { canvas.width = 1; canvas.height = 1; },
    };
  } catch (error) {
    if (error instanceof Error && error.message) throw error;
    throw new Error('この画像を読み込めません。ほかの JPEG・PNG でお試しください。');
  } finally {
    source?.close?.();
  }
}

/** Every box is scaled back to the supplied canvas's pixel coordinates. */
export async function detectFaces(canvas) {
  const api = await loadModels();
  const task = detectionQueue.then(async () => {
    const size = fitDimensions(canvas.width, canvas.height, 1280);
    let input = canvas;
    if (size.width !== canvas.width || size.height !== canvas.height) {
      const scaled = newCanvas(size.width, size.height);
      scaled.context.drawImage(canvas, 0, 0, size.width, size.height);
      input = scaled.canvas;
    }
    try {
      const faces = await api.detectAllFaces(input, new api.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.35 }))
        .withFaceLandmarks().withFaceDescriptors();
      const scaleX = canvas.width / input.width;
      const scaleY = canvas.height / input.height;
      return faces.map((face) => {
        const box = face.detection.box;
        const x = Math.max(0, box.x * scaleX);
        const y = Math.max(0, box.y * scaleY);
        const right = Math.min(canvas.width, (box.x + box.width) * scaleX);
        const bottom = Math.min(canvas.height, (box.y + box.height) * scaleY);
        return {
          box: { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) },
          descriptor: Float32Array.from(face.descriptor),
          confidence: face.detection.score,
        };
      }).filter((face) => face.box.width > 0 && face.box.height > 0)
        .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
    } finally {
      if (input !== canvas) { input.width = 1; input.height = 1; }
    }
  });
  detectionQueue = task.catch(() => {});
  return task;
}

/** Minimum descriptor distance, not a probability; lower means more similar. */
export function faceDistance(features, refs) {
  if (!features?.length || !refs?.length) return null;
  let best = Infinity;
  for (const feature of features) {
    for (const reference of refs) {
      if (!feature?.length || feature.length !== reference?.length) throw new Error('顔の特徴データの形式が異なります。参照写真を登録し直してください。');
      let sum = 0;
      for (let i = 0; i < feature.length; i += 1) {
        if (!Number.isFinite(feature[i]) || !Number.isFinite(reference[i])) throw new Error('顔の特徴データが正しくありません。');
        sum += (feature[i] - reference[i]) ** 2;
      }
      best = Math.min(best, Math.sqrt(sum));
    }
  }
  return best;
}

/** Population variance of the four-neighbour Laplacian on grayscale pixels. */
export function laplacianVariance(gray, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || gray.length !== width * height) {
    throw new Error('鮮明さの計算に必要な画像データが正しくありません。');
  }
  if (width < 3 || height < 3) return 0;
  let mean = 0;
  let m2 = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const value = gray[index - 1] + gray[index + 1] + gray[index - width] + gray[index + width] - 4 * gray[index];
      if (!Number.isFinite(value)) throw new Error('鮮明さの計算に無効な画素が含まれています。');
      count += 1;
      const delta = value - mean;
      mean += delta / count;
      m2 += delta * (value - mean);
    }
  }
  return Math.max(0, m2 / count);
}

/** Use the largest supplied target-face box; otherwise score the whole photo. */
export function blurScore(canvas, boxes = []) {
  const valid = boxes.map((value) => value.box || value).filter((box) =>
    [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  const box = valid[0] || { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const x = Math.max(0, Math.min(canvas.width - 1, box.x));
  const y = Math.max(0, Math.min(canvas.height - 1, box.y));
  const width = Math.max(1, Math.min(canvas.width - x, box.width));
  const height = Math.max(1, Math.min(canvas.height - y, box.height));
  const size = fitDimensions(width, height, valid.length ? 256 : 800);
  const sample = newCanvas(size.width, size.height);
  try {
    sample.context.drawImage(canvas, x, y, width, height, 0, 0, size.width, size.height);
    const rgba = sample.context.getImageData(0, 0, size.width, size.height).data;
    const gray = new Float32Array(size.width * size.height);
    for (let i = 0; i < gray.length; i += 1) gray[i] = rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114;
    return laplacianVariance(gray, size.width, size.height);
  } finally {
    sample.canvas.width = 1;
    sample.canvas.height = 1;
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('処理を中止しました。', 'AbortError');
}

function encodeJpeg(canvas, quality, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      try {
        checkAbort(signal);
        if (!blob || blob.type !== 'image/jpeg') throw new Error('JPEG への変換に失敗しました。別のブラウザでお試しください。');
        resolve(blob);
      } catch (error) { reject(error); }
    }, 'image/jpeg', quality);
  });
}

/** Return a JPEG actually at or below targetBytes, or an explicit error. */
export async function compressToTarget(file, targetBytes, allowResize = true, { signal, onProgress = () => {} } = {}) {
  if (!Number.isFinite(targetBytes) || targetBytes < MIN_TARGET_BYTES) throw new Error('目標サイズは 10 kB 以上で指定してください。');
  targetBytes = Math.floor(targetBytes);
  checkAbort(signal);
  const decoded = await decodeImage(file);
  let working = decoded.canvas;
  try {
    for (let pass = 0; pass < 20; pass += 1) {
      checkAbort(signal);
      const encode = async (quality) => {
        onProgress({ stage: 'encoding', width: working.width, height: working.height, quality });
        return encodeJpeg(working, quality, signal);
      };
      let blob = await encode(QUALITY_MAX);
      let quality = QUALITY_MAX;
      if (blob.size > targetBytes) {
        const minimumBlob = await encode(QUALITY_MIN);
        if (minimumBlob.size > targetBytes) {
          if (!allowResize) throw new Error('この解像度のままでは目標サイズに収まりません。「必要なら画像を縮小」を有効にするか、目標サイズを大きくしてください。');
          if (working.width === 1 && working.height === 1) throw new Error('目標サイズに収まりません。もう少し大きいサイズを指定してください。');
          const factor = Math.max(0.2, Math.min(0.9, Math.sqrt(targetBytes / minimumBlob.size) * 0.94));
          const width = Math.max(1, Math.floor(working.width * factor));
          const height = Math.max(1, Math.floor(working.height * factor));
          const scaled = newCanvas(width, height);
          scaled.context.drawImage(decoded.canvas, 0, 0, width, height);
          if (working !== decoded.canvas) { working.width = 1; working.height = 1; }
          working = scaled.canvas;
          onProgress({ stage: 'resizing', width, height, quality: QUALITY_MIN, bytes: minimumBlob.size });
          continue;
        }
        blob = minimumBlob;
        quality = QUALITY_MIN;
        let low = QUALITY_MIN;
        let high = QUALITY_MAX;
        for (let iteration = 0; iteration < 8; iteration += 1) {
          const candidateQuality = (low + high) / 2;
          const candidate = await encode(candidateQuality);
          if (candidate.size <= targetBytes) {
            blob = candidate;
            quality = candidateQuality;
            low = candidateQuality;
          } else {
            high = candidateQuality;
          }
        }
      }
      checkAbort(signal);
      const result = { blob, width: working.width, height: working.height, quality, resized: working.width !== decoded.width || working.height !== decoded.height };
      onProgress({ stage: 'done', width: result.width, height: result.height, quality, bytes: blob.size });
      return result;
    }
    throw new Error('目標サイズに収まりません。サイズを大きくして再度お試しください。');
  } finally {
    if (working !== decoded.canvas) { working.width = 1; working.height = 1; }
    decoded.close();
  }
}
