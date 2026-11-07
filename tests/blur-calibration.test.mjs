import test from 'node:test';
import assert from 'node:assert/strict';
import {inferBlurCalibration, calibrationKey, deriveCalibrations, reviewBlur} from '../src/blur-calibration.js';

const separated = () => [
  {id:'b1',label:'blur',score:10}, {id:'b2',label:'blur',score:20}, {id:'b3',label:'blur',score:30},
  {id:'s1',label:'sharp',score:80}, {id:'s2',label:'sharp',score:90}, {id:'s3',label:'sharp',score:100},
];
const records = () => separated().map(sample => ({id:sample.id,blurLabel:sample.label,sharpness:sample.score,
  date:'2026-11-07',sharpnessBasis:'face',analyzed:true}));

test('requires three examples of each class before allowing automatic decisions', () => {
  const calibration=inferBlurCalibration(separated().slice(1));
  assert.equal(calibration.ready,false);
  assert.equal(calibration.threshold,null);
  assert.equal(calibration.reason,'insufficient');
  assert.equal(calibration.sharpCount,3);
  assert.equal(calibration.blurCount,2);
  assert.throws(()=>inferBlurCalibration([], {minPerClass:0}), /枚数/);
});

test('strict separation produces a threshold between all labeled blur and sharp scores', () => {
  const calibration=inferBlurCalibration(separated());
  assert.equal(calibration.ready,true);
  assert.equal(calibration.reason,'ready');
  assert.equal(calibration.threshold,55);
  assert.ok(separated().filter(s=>s.label==='blur').every(s=>s.score<calibration.threshold));
  assert.ok(separated().filter(s=>s.label==='sharp').every(s=>s.score>=calibration.threshold));
});

test('overlap or equal boundary scores prevent automatic filtering', () => {
  const overlap=separated();overlap[0].score=85;
  const calibration=inferBlurCalibration(overlap);
  assert.equal(calibration.reason,'overlap');
  assert.equal(calibration.ready,false);
  assert.equal(calibration.threshold,null);
  overlap[0].score=80;
  assert.equal(inferBlurCalibration(overlap).reason,'overlap');
});

test('invalid numbers are ignored and duplicate IDs cannot inflate evidence', () => {
  const samples=separated().slice(1);
  samples.push(samples[0], {id:'bad1',label:'blur',score:NaN}, {id:'bad2',label:'blur',score:Infinity},
    {id:'bad3',label:'blur',score:-2}, {id:'bad4',label:'other',score:1}, null);
  const calibration=inferBlurCalibration(samples);
  assert.equal(calibration.blurCount,2);
  assert.equal(calibration.sampleCount,5);
  assert.equal(calibration.ready,false);
  const revised=inferBlurCalibration([...separated(),{id:'b1',label:'sharp',score:110}]);
  assert.equal(revised.blurCount,2);
  assert.equal(revised.sharpCount,4);
});

test('calibrations keep different shooting days and face/whole-image scores separate', () => {
  const input=records();
  input.push({id:'whole',date:'2026-11-07',sharpnessBasis:'whole',sharpness:1,analyzed:true});
  input.push({id:'tomorrow',date:'2026-11-08',sharpnessBasis:'face',sharpness:1,analyzed:true});
  const calibrations=deriveCalibrations(input);
  assert.equal(calibrations.size,3);
  assert.equal(calibrations.get('2026-11-07|face').ready,true);
  assert.equal(calibrations.get('2026-11-07|whole').reason,'insufficient');
  assert.equal(calibrations.get('2026-11-08|face').reason,'insufficient');
  assert.equal(calibrationKey({date:'2026-11-07'}),'2026-11-07|whole');
});

test('derive ignores unanalysed/error records and deduplicates actual record IDs', () => {
  const input=records();
  input.push(input[0], {id:'unread',blurLabel:'blur',sharpness:1,analyzed:false},
    {id:'broken',blurLabel:'sharp',sharpness:1,error:'broken',analyzed:true},
    {blurLabel:'blur',date:'2026-11-07',sharpnessBasis:'face',sharpness:1,analyzed:true});
  const calibration=deriveCalibrations(input).get('2026-11-07|face');
  assert.equal(calibration.sampleCount,6);
  assert.equal(calibration.ready,true);
});

test('uncalibrated low scores stay unfiltered and request review only when enabled', () => {
  const photo={id:'new',date:'2026-11-07',sharpnessBasis:'face',sharpness:0,analyzed:true};
  assert.deepEqual(reviewBlur(photo,new Map(),{enabled:false}), {blurry:false,blurUncertain:false,calibration:null});
  assert.deepEqual(reviewBlur(photo,new Map(),{enabled:true}), {blurry:false,blurUncertain:true,calibration:null});
  assert.equal(reviewBlur({...photo,analyzed:false},new Map(),{enabled:true}).blurUncertain,false);
});

test('enabled ready calibration classifies by threshold, while manual labels remain authoritative', () => {
  const calibrations=deriveCalibrations(records());
  const photo={id:'new',date:'2026-11-07',sharpnessBasis:'face',sharpness:40,analyzed:true};
  assert.equal(reviewBlur(photo,calibrations,{enabled:true}).blurry,true);
  assert.equal(reviewBlur({...photo,sharpness:55},calibrations,{enabled:true}).blurry,false);
  assert.equal(reviewBlur({...photo,blurLabel:'sharp'},calibrations,{enabled:true}).blurry,false);
  assert.equal(reviewBlur({...photo,sharpness:100,blurLabel:'blur'},calibrations,{enabled:false}).blurry,true);
});
