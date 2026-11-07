import test from 'node:test';
import assert from 'node:assert/strict';
import { faceDistance, fitDimensions, imageKind, laplacianVariance, compressToTarget } from '../src/imaging.js';

test('distance matches the best pair without mutating descriptors', () => {
  const feature = new Float32Array([0.1, 0.2, 0.3]);
  const before = [...feature];
  assert.equal(faceDistance([new Float32Array([1, 0, 0]), feature], [feature]), 0);
  assert.deepEqual([...feature], before);
  assert.equal(faceDistance([[0, 0]], [[3, 4]]), 5);
});

test('no face or reference has no comparison score', () => {
  assert.equal(faceDistance([], [[1, 2]]), null);
  assert.equal(faceDistance([[1, 2]], []), null);
  assert.equal(faceDistance([], []), null);
});

test('invalid descriptors fail explicitly', () => {
  assert.throws(() => faceDistance([[1, 2]], [[1]]));
  assert.throws(() => faceDistance([[NaN, 2]], [[1, 2]]));
  assert.throws(() => faceDistance([[1, Infinity]], [[1, 2]]));
});

test('fitting preserves orientation and does not enlarge small images', () => {
  assert.deepEqual(fitDimensions(4000, 3000, 800), { width: 800, height: 600 });
  assert.deepEqual(fitDimensions(3000, 4000, 800), { width: 600, height: 800 });
  assert.deepEqual(fitDimensions(100, 50, 800), { width: 100, height: 50 });
  assert.deepEqual(fitDimensions(100000, 1, 800), { width: 800, height: 1 });
  assert.throws(() => fitDimensions(0, 100, 800));
});

test('file signature distinguishes supported images from renamed files', () => {
  assert.equal(imageKind(Uint8Array.from([255, 216, 255, 224])), 'jpeg');
  assert.equal(imageKind(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])), 'png');
  assert.equal(imageKind(Uint8Array.from([60, 104, 116, 109, 108])), null);
  assert.equal(imageKind(new Uint8Array()), null);
});

test('uniform and linear-gradient pixels have zero Laplacian variance', () => {
  assert.equal(laplacianVariance(new Float32Array(25).fill(120), 5, 5), 0);
  const gradient = Float32Array.from({ length: 25 }, (_, i) => (i % 5) * 10);
  assert.equal(laplacianVariance(gradient, 5, 5), 0);
});

test('sharp checkerboard scores above its smoothed version', () => {
  const size = 20;
  const sharp = Float32Array.from({ length: size * size }, (_, i) => ((i % size + Math.floor(i / size)) % 2) * 255);
  const soft = Float32Array.from(sharp, (value) => 100 + value * 0.1);
  assert.ok(laplacianVariance(sharp, size, size) > 50 * laplacianVariance(soft, size, size));
});

test('tiny image and invalid Laplacian dimensions are handled', () => {
  assert.equal(laplacianVariance(new Float32Array(4), 2, 2), 0);
  assert.throws(() => laplacianVariance(new Float32Array(4), 3, 3));
  const invalid = new Float32Array(25); invalid[12] = NaN;
  assert.throws(() => laplacianVariance(invalid, 5, 5));
});

test('compression validates target and cancellation before decoding a photo', async () => {
  await assert.rejects(compressToTarget(null, 9000), /10 kB/);
  await assert.rejects(compressToTarget(null, Infinity), /10 kB/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(compressToTarget(null, 10000, true, { signal: controller.signal }), { name: 'AbortError' });
});
