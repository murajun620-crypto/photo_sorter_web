import test from 'node:test';
import assert from 'node:assert/strict';
import {ENGINE_ID,ENGINE_MODEL_SHA256,planTiles,fitSimilarity,decodeYuNet,nonMaxSuppression,intersectionOverUnion} from '../src/onnx-face-engine.js';

test('engine provenance separates old128D embeddings and pins both models',()=>{
  assert.match(ENGINE_ID,/rgb5p-v1/);assert.equal(ENGINE_MODEL_SHA256.detector.length,64);assert.equal(ENGINE_MODEL_SHA256.recognizer.length,64);
});
test('source-pixel tiles cover all edges with overlap and no redundant small-photo pass',()=>{
  assert.deepEqual(planTiles(640,400),[]);
  const tiles=planTiles(1500,1100);assert.ok(tiles.some(t=>t.x===860&&t.y===460));
  for(let y=0;y<1100;y+=50)for(let x=0;x<1500;x+=50)assert.ok(tiles.some(t=>x>=t.x&&x<t.x+t.width&&y>=t.y&&y<t.y+t.height));
  assert.equal(new Set(tiles.map(t=>`${t.x},${t.y}`)).size,tiles.length);
  assert.ok(planTiles(1200,300).every(t=>t.height===300));
  assert.throws(()=>planTiles(1000,1000,{step:641}));
});
test('five-point fit recovers identity and a known rotated/scaled transform',()=>{
  const template=[[38.2946,51.6963],[73.5318,51.5014],[56.0252,71.7366],[41.5493,92.3655],[70.7299,92.2041]];
  const identity=fitSimilarity(template);assert.ok(Math.abs(identity[0]-1)<1e-12);assert.ok(Math.abs(identity[4]-1)<1e-12);
  const input=template.map(([x,y])=>[2*x-y+300,x+2*y+100]);
  const matrix=fitSimilarity(input);
  for(let i=0;i<5;i++){const [x,y]=input[i];assert.ok(Math.abs(matrix[0]*x+matrix[1]*y+matrix[2]-template[i][0])<1e-9);assert.ok(Math.abs(matrix[3]*x+matrix[4]*y+matrix[5]-template[i][1])<1e-9);}
  assert.throws(()=>fitSimilarity(Array.from({length:5},()=>[1,1])));
});
test('cross-tile NMS merges duplicate detections while preserving separate faces',()=>{
  const a={box:{x:10,y:10,width:80,height:90},confidence:.8},b={box:{x:12,y:11,width:80,height:90},confidence:.9},c={box:{x:300,y:100,width:80,height:90},confidence:.85};
  assert.ok(intersectionOverUnion(a.box,b.box)>.8);
  assert.deepEqual(nonMaxSuppression([a,b,c]),[b,c]);
  assert.equal(nonMaxSuppression([a,b,c],{maxFaces:1}).length,1);
});
test('YuNet decodes score, exponential sizes and five grid landmarks correctly',()=>{
  const outputs={};
  for(const stride of [8,16,32]){const n=(640/stride)**2;for(const [prefix,channels]of[['cls',1],['obj',1],['bbox',4],['kps',10]])outputs[`${prefix}_${stride}`]={data:new Float32Array(n*channels)};}
  const i=2*80+3;outputs.cls_8.data[i]=.81;outputs.obj_8.data[i]=1;
  outputs.bbox_8.data[i*4]=.5;outputs.bbox_8.data[i*4+1]=.25;outputs.bbox_8.data[i*4+2]=Math.log(10);outputs.bbox_8.data[i*4+3]=Math.log(12);
  for(let j=0;j<5;j++){outputs.kps_8.data[i*10+j*2]=j;outputs.kps_8.data[i*10+j*2+1]=j+.5;}
  const [face]=decodeYuNet(outputs);assert.ok(Math.abs(face.confidence-.9)<1e-6);assert.ok(Math.abs(face.box.width-80)<1e-4);assert.ok(Math.abs(face.box.height-96)<1e-4);
  assert.deepEqual(face.landmarks[0],[24,20]);assert.equal(face.landmarks.length,5);
  assert.throws(()=>decodeYuNet({}));assert.throws(()=>decodeYuNet(outputs,{inputWidth:512}));
});
