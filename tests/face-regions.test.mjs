import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRegion, regionFromPoints, regionCanvasPlan, descriptorFromRegion} from '../src/face-regions.js';

function canvasFactory() {
  const calls = [];
  const context = {fillRect(...args) {calls.push(['fill', ...args]);}, drawImage(...args) {calls.push(['draw', ...args]);}};
  const canvas = {width: 0, height: 0, getContext() {return context;}};
  return {canvas, calls, createCanvas: () => canvas};
}

test('manual drag supports reverse direction and clips image boundaries', () => {
  assert.deepEqual(regionFromPoints({x: 90,y: 80},{x: 10,y: 20},100,100), {x:10,y:20,width:80,height:60});
  assert.deepEqual(normalizeRegion({x:-10,y:30,width:60,height:200},100,100), {x:0,y:30,width:50,height:70});
  assert.deepEqual(normalizeRegion({x:120,y:80,width:-70,height:-40},100,100), {x:50,y:40,width:50,height:40});
});

test('invalid, out-of-photo, and tiny selections remain unregistered', () => {
  for (const box of [{x:NaN,y:0,width:30,height:30},{x:120,y:0,width:30,height:30},{x:0,y:0,width:15,height:30}]) {
    assert.throws(() => normalizeRegion(box,100,100));
  }
  assert.throws(() => regionFromPoints(null,{x:3,y:3},100,100));
  assert.throws(() => normalizeRegion({x:0,y:0,width:30,height:30},0,100));
});

test('small manual face is enlarged but work canvas is bounded', () => {
  const small = regionCanvasPlan({x:10,y:10,width:20,height:30},100,100);
  assert.ok(small.width > small.crop.width && small.height > small.crop.height);
  assert.ok(small.width / small.crop.width <= 4.1);
  const large = regionCanvasPlan({x:0,y:0,width:6000,height:4000},6000,4000);
  assert.equal(large.width,1280);
  assert.ok(large.height < 1280);
});

test('blank crop and multiple-person crop never enroll a reference', async () => {
  const source = {width:1000,height:800};
  for (const faces of [[],[{box:{x:100,y:100,width:30,height:30}},{box:{x:150,y:150,width:30,height:30}}]]) {
    const factory = canvasFactory();
    await assert.rejects(descriptorFromRegion(source,{x:100,y:100,width:100,height:120}, {...factory,detect:async () => faces}), faces.length ? /複数の顔/ : /顔を確認できません/);
    assert.equal(factory.canvas.width,1);
    assert.equal(factory.canvas.height,1);
  }
});

test('single face maps back to photo coordinates and owns an independent descriptor', async () => {
  const source = {width:1000,height:800};
  const box = {x:100,y:100,width:100,height:120};
  const plan = regionCanvasPlan(box,source.width,source.height);
  const feature = new Float32Array([0.1,0.2,0.3]);
  const factory = canvasFactory();
  const result = await descriptorFromRegion(source,box,{...factory,detect:async input => {
    assert.equal(input.width,plan.width);
    return [{box:{x:input.width*.2,y:input.height*.2,width:input.width*.6,height:input.height*.6},descriptor:feature}];
  }});
  assert.ok(Math.abs(result.box.x-(plan.crop.x+plan.crop.width*.2)) < 1e-9);
  assert.ok(Math.abs(result.box.height-plan.crop.height*.6) < 1e-9);
  assert.deepEqual([...result.descriptor],[...feature]);
  assert.notEqual(result.descriptor,feature);
  assert.equal(factory.canvas.width,1);
  assert.equal(factory.calls[1][0],'draw');
});

test('neighbor found only in extra context is rejected', async () => {
  const factory = canvasFactory();
  await assert.rejects(descriptorFromRegion({width:1000,height:800},{x:100,y:100,width:100,height:120},
    {...factory,detect:async input => [{box:{x:0,y:input.height/2,width:8,height:8},descriptor:[.1,.2]}]}), /囲み直して/);
});

test('tight rectangle retries with wider context and ignores neighbors outside the selection', async () => {
  const source = {width:1000,height:800};
  const box = {x:100,y:100,width:100,height:120};
  const factory = canvasFactory();
  let attempts = 0;
  const result = await descriptorFromRegion(source,box,{...factory,detect:async input => {
    const padding = [0.12,0.35,0.65,1][attempts++];
    if (attempts === 1) return [];
    const plan = regionCanvasPlan(box,source.width,source.height,{padding});
    const map = (x,y,width,height) => ({box:{x:(x-plan.crop.x)/plan.crop.width*input.width,
      y:(y-plan.crop.y)/plan.crop.height*input.height,width:width/plan.crop.width*input.width,height:height/plan.crop.height*input.height}});
    return [{...map(110,110,50,60),descriptor:[.1,.2]}, {...map(70,100,20,20),descriptor:[.7,.8]}];
  }});
  assert.equal(attempts,2);
  assert.deepEqual([...result.descriptor],[Math.fround(.1),Math.fround(.2)]);
  assert.ok(Math.abs(result.box.x-110)<1e-9);
});

test('bad model output fails explicitly and always releases crop memory', async () => {
  const factory = canvasFactory();
  await assert.rejects(descriptorFromRegion({width:1000,height:800},{x:100,y:100,width:100,height:120},
    {...factory,detect:async () => [{box:{x:0,y:0,width:100,height:100},descriptor:[NaN]}]}), /特徴/);
  assert.equal(factory.canvas.width,1);
  await assert.rejects(descriptorFromRegion({width:1000,height:800},{x:100,y:100,width:100,height:120},
    {...factory,detect:async () => {throw new Error('detector failed');}}), /detector failed/);
  assert.equal(factory.canvas.height,1);
});
