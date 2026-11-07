/** Local-only YuNet/SFace engine. Not interchangeable with old embeddings. */
export const ENGINE_MODEL_SHA256 = Object.freeze({
  detector:'8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
  recognizer:'0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
});
export const ENGINE_ID='opencv-yunet-2023mar-8f2383e4+sface-2021dec-0ba9fbfa:rgb5p-v1';
const TEMPLATE=[[38.2946,51.6963],[73.5318,51.5014],[56.0252,71.7366],[41.5493,92.3655],[70.7299,92.2041]];
const INPUT_EDGE=640;
let sessionsPromise;
let inferenceQueue=Promise.resolve();

function checkAbort(signal){if(signal?.aborted)throw new DOMException('処理を中止しました。','AbortError');}
function tick(){return new Promise(resolve=>setTimeout(resolve,0));}
function finitePositive(value){return Number.isFinite(value)&&value>0;}
function context2D(canvas){const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw new Error('画像処理用の領域を作れません。');return context;}
function canvas2D(width,height){const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;}
function serialize(action){const result=inferenceQueue.then(action);inferenceQueue=result.catch(()=>{});return result;}
function normalize(values){
  const output=Float32Array.from(values);let squared=0;
  for(const value of output){if(!Number.isFinite(value))throw new Error('顔の特徴量を読み取れません。');squared+=value*value;}
  const norm=Math.sqrt(squared);
  if(output.length!==128||!Number.isFinite(norm)||norm<1e-10)throw new Error('顔の特徴量の形式が正しくありません。');
  for(let i=0;i<output.length;i++)output[i]/=norm;
  return output;
}

/** Fixed-size source-pixel tiles, including final edges; small photos need only global pass. */
export function planTiles(width,height,{tileSize=640,step=512}={}){
  if(![width,height,tileSize,step].every(Number.isInteger)||![width,height,tileSize,step].every(finitePositive)||step>tileSize)throw new Error('タイルの寸法が正しくありません。');
  if(width<=tileSize&&height<=tileSize)return [];
  const starts=length=>{if(length<=tileSize)return [0];const list=[];for(let at=0;at<=length-tileSize;at+=step)list.push(at);if(list.at(-1)!==length-tileSize)list.push(length-tileSize);return list;};
  const output=[];
  for(const y of starts(height))for(const x of starts(width))output.push({x,y,width:Math.min(tileSize,width-x),height:Math.min(tileSize,height-y)});
  return output;
}

/** Source-to112px similarity transform, equivalent to OpenCV's proper 2D fit. */
export function fitSimilarity(landmarks){
  if(!Array.isArray(landmarks)||landmarks.length!==5||landmarks.some(point=>!Array.isArray(point)||point.length!==2||!point.every(Number.isFinite)))throw new Error('顔の5点位置を読み取れません。');
  const sourceMean=[0,1].map(c=>landmarks.reduce((sum,point)=>sum+point[c],0)/5);
  const targetMean=[0,1].map(c=>TEMPLATE.reduce((sum,point)=>sum+point[c],0)/5);
  let denominator=0,real=0,imaginary=0;
  for(let i=0;i<5;i++){
    const x=landmarks[i][0]-sourceMean[0],y=landmarks[i][1]-sourceMean[1];
    const u=TEMPLATE[i][0]-targetMean[0],v=TEMPLATE[i][1]-targetMean[1];
    denominator+=x*x+y*y;real+=x*u+y*v;imaginary+=x*v-y*u;
  }
  if(!Number.isFinite(denominator)||denominator<1e-8)throw new Error('顔の位置を整列できません。');
  const a=real/denominator,b=imaginary/denominator;
  if(a*a+b*b<1e-12)throw new Error('顔の位置を整列できません。');
  return [a,-b,targetMean[0]-a*sourceMean[0]+b*sourceMean[1],b,a,targetMean[1]-b*sourceMean[0]-a*sourceMean[1]];
}

export function intersectionOverUnion(a,b){
  const left=Math.max(a.x,b.x),top=Math.max(a.y,b.y);
  const area=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-left)*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-top);
  const union=a.width*a.height+b.width*b.height-area;return union>0?area/union:0;
}

export function nonMaxSuppression(faces,{iouThreshold=.3,maxFaces=5000}={}){
  if(!Number.isFinite(iouThreshold)||iouThreshold<0||iouThreshold>1||!Number.isInteger(maxFaces)||maxFaces<1)throw new Error('顔の重複除去条件が正しくありません。');
  const ranked=faces.filter(face=>face?.box&&[face.box.x,face.box.y,face.box.width,face.box.height,face.confidence].every(Number.isFinite)&&face.box.width>0&&face.box.height>0)
    .map((face,index)=>({face,index})).sort((a,b)=>b.face.confidence-a.face.confidence||a.index-b.index);
  const kept=[];
  for(const {face} of ranked){if(kept.every(other=>intersectionOverUnion(face.box,other.box)<=iouThreshold))kept.push(face);if(kept.length>=maxFaces)break;}
  return kept;
}

/** Decode the official2023mar model's twelve outputs, still in640-input coordinates. */
export function decodeYuNet(outputs,{threshold=.6,inputWidth=640}={}){
  if(!Number.isFinite(threshold)||threshold<0||threshold>1||inputWidth!==640)throw new Error('顔検出条件が正しくありません。');
  const faces=[];
  for(const stride of [8,16,32]){
    const cls=outputs[`cls_${stride}`]?.data,obj=outputs[`obj_${stride}`]?.data;
    const bbox=outputs[`bbox_${stride}`]?.data,kps=outputs[`kps_${stride}`]?.data;
    const cols=inputWidth/stride,total=cols*cols;
    if(!cls||!obj||!bbox||!kps||cls.length!==total||obj.length!==total||bbox.length!==total*4||kps.length!==total*10)throw new Error('顔検出モデルの出力形式が異なります。');
    for(let index=0;index<total;index++){
      const score=Math.sqrt(Math.max(0,Math.min(1,cls[index]))*Math.max(0,Math.min(1,obj[index])));
      if(!Number.isFinite(score)||score<threshold)continue;
      const row=Math.floor(index/cols),column=index%cols;
      const width=Math.exp(bbox[index*4+2])*stride,height=Math.exp(bbox[index*4+3])*stride;
      const box={x:(column+bbox[index*4])*stride-width/2,y:(row+bbox[index*4+1])*stride-height/2,width,height};
      const landmarks=Array.from({length:5},(_,j)=>[(kps[index*10+j*2]+column)*stride,(kps[index*10+j*2+1]+row)*stride]);
      if(![box.x,box.y,width,height,...landmarks.flat()].every(Number.isFinite))continue;
      faces.push({box,landmarks,confidence:score});
    }
  }
  return nonMaxSuppression(faces);
}

export async function loadEngine(onProgress=()=>{}){
  if(!sessionsPromise){
    sessionsPromise=(async()=>{
      const runtime=globalThis.ort;
      if(!runtime?.InferenceSession||!runtime?.Tensor)throw new Error('ONNX Runtimeを読み込めません。ページを再読み込みしてください。');
      const runtimeUrl=new URL('../vendor/ort/',import.meta.url),modelUrl=new URL('../models-v2/',import.meta.url);
      if(runtimeUrl.origin!==location.origin||modelUrl.origin!==location.origin)throw new Error('モデルはこのアプリと同じ配信元から読み込む必要があります。');
      runtime.env.logLevel='error';runtime.env.wasm.numThreads=1;runtime.env.wasm.proxy=false;runtime.env.wasm.wasmPaths=runtimeUrl.href;
      const options={executionProviders:['wasm'],logSeverityLevel:3};
      onProgress('新しい顔検出モデルを準備中（0/2）');
      const detector=await runtime.InferenceSession.create(new URL('face_detection_yunet_2023mar.onnx',modelUrl).href,options);
      try{
        onProgress('新しい顔特徴モデルを準備中（1/2）');
        const recognizer=await runtime.InferenceSession.create(new URL('face_recognition_sface_2021dec.onnx',modelUrl).href,options);
        onProgress('モデルの準備ができました（2/2）');return {detector,recognizer};
      }catch(error){await detector.release();throw error;}
    })().catch(error=>{sessionsPromise=null;throw new Error(`顔認識モデルを準備できませんでした。${error.message||error}`);});
  }
  return sessionsPromise;
}

function imageToBGR(canvas){
  const rgba=context2D(canvas).getImageData(0,0,640,640).data,plane=640*640,data=new Float32Array(plane*3);
  for(let i=0;i<plane;i++){data[i]=rgba[i*4+2];data[plane+i]=rgba[i*4+1];data[plane*2+i]=rgba[i*4];}
  return new globalThis.ort.Tensor('float32',data,[1,3,640,640]);
}

async function inferDetector(canvas,sessions){
  const tensor=imageToBGR(canvas);let outputs;
  try{outputs=await sessions.detector.run({[sessions.detector.inputNames[0]]:tensor});return decodeYuNet(outputs);}
  finally{tensor.dispose?.();if(outputs)for(const output of Object.values(outputs))output.dispose?.();}
}

function mapDetection(face,{x,y,width,height,scaleX=1,scaleY=1},sourceWidth,sourceHeight){
  const centerX=face.box.x+face.box.width/2,centerY=face.box.y+face.box.height/2;
  const renderedWidth=width*scaleX,renderedHeight=height*scaleY;
  if(centerX<0||centerY<0||centerX>=renderedWidth||centerY>=renderedHeight)return null;
  const box={x:x+face.box.x/scaleX,y:y+face.box.y/scaleY,width:face.box.width/scaleX,height:face.box.height/scaleY};
  const right=Math.min(sourceWidth,box.x+box.width),bottom=Math.min(sourceHeight,box.y+box.height);
  box.x=Math.max(0,box.x);box.y=Math.max(0,box.y);box.width=right-box.x;box.height=bottom-box.y;
  if(box.width<8||box.height<8)return null;
  const landmarks=face.landmarks.map(([u,v])=>[x+u/scaleX,y+v/scaleY]);
  return {box,landmarks,confidence:face.confidence,engineId:ENGINE_ID};
}

/** Aligned112px face samples original source pixels, not the detection thumbnail. */
export function getAlignedFace(source,face){
  const matrix=fitSimilarity(face.landmarks),[a,,tx,b,,ty]=matrix,denominator=a*a+b*b;
  const inverse=(x,y)=>[(a*(x-tx)+b*(y-ty))/denominator,(-b*(x-tx)+a*(y-ty))/denominator];
  const corners=[[0,0],[111,0],[0,111],[111,111]].map(([x,y])=>inverse(x,y));
  const left=Math.max(0,Math.floor(Math.min(...corners.map(point=>point[0])))-1),top=Math.max(0,Math.floor(Math.min(...corners.map(point=>point[1])))-1);
  const right=Math.min(source.width,Math.ceil(Math.max(...corners.map(point=>point[0])))+2),bottom=Math.min(source.height,Math.ceil(Math.max(...corners.map(point=>point[1])))+2);
  if(right<=left||bottom<=top)throw new Error('顔の位置が画像の外側です。');
  const pixels=context2D(source).getImageData(left,top,right-left,bottom-top).data,regionWidth=right-left;
  const aligned=canvas2D(112,112),context=context2D(aligned),output=context.createImageData(112,112);
  const sample=(x,y,c)=>x<left||y<top||x>=right||y>=bottom?0:pixels[((y-top)*regionWidth+x-left)*4+c];
  for(let y=0;y<112;y++)for(let x=0;x<112;x++){
    const point=inverse(x,y),sx=Math.round(point[0]*32)/32,sy=Math.round(point[1]*32)/32;
    const ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy,index=(y*112+x)*4;
    for(let c=0;c<3;c++)output.data[index+c]=Math.round(sample(ix,iy,c)*(1-fx)*(1-fy)+sample(ix+1,iy,c)*fx*(1-fy)+sample(ix,iy+1,c)*(1-fx)*fy+sample(ix+1,iy+1,c)*fx*fy);
    output.data[index+3]=255;
  }
  context.putImageData(output,0,0);return aligned;
}

async function describeOriginal(source,face,sessions){
  const aligned=getAlignedFace(source,face);let tensor,outputs;
  try{
    const rgba=context2D(aligned).getImageData(0,0,112,112).data,plane=112*112,data=new Float32Array(plane*3);
    for(let i=0;i<plane;i++)for(let c=0;c<3;c++)data[c*plane+i]=rgba[i*4+c];
    tensor=new globalThis.ort.Tensor('float32',data,[1,3,112,112]);
    outputs=await sessions.recognizer.run({[sessions.recognizer.inputNames[0]]:tensor});
    return {...face,descriptor:normalize(outputs[sessions.recognizer.outputNames[0]].data)};
  }finally{aligned.width=aligned.height=1;tensor?.dispose?.();if(outputs)for(const output of Object.values(outputs))output.dispose?.();}
}

async function findCandidates(source,sessions,{signal,onProgress,tiled}){
  const width=source.width,height=source.height;
  if(![width,height].every(value=>Number.isInteger(value)&&value>0))throw new Error('写真を読み込めません。');
  const tiles=tiled?planTiles(width,height):[];
  const candidates=[];const input=canvas2D(640,640),context=context2D(input);
  const globalScale=Math.min(1,640/Math.max(width,height));
  const globalWidth=Math.max(1,Math.round(width*globalScale)),globalHeight=Math.max(1,Math.round(height*globalScale));
  try{
    const passes=[{x:0,y:0,width,height,scaleX:globalWidth/width,scaleY:globalHeight/height,global:true},...tiles];
    for(let index=0;index<passes.length;index++){
      checkAbort(signal);const tile=passes[index];context.fillStyle='#000';context.fillRect(0,0,640,640);
      if(tile.global)context.drawImage(source,0,0,width,height,0,0,globalWidth,globalHeight);
      else context.drawImage(source,tile.x,tile.y,tile.width,tile.height,0,0,tile.width,tile.height);
      for(const detection of await inferDetector(input,sessions)){
        const mapped=mapDetection(detection,tile,width,height);if(!mapped)continue;
        // Ignore predictions whose landmarks depend on pixels outside an
        // interior tile. Adjacent overlap/global pass supplies those faces.
        if(!tile.global&&mapped.landmarks.some(([x,y])=>x<tile.x&&tile.x>0||y<tile.y&&tile.y>0||x>=tile.x+tile.width&&tile.x+tile.width<width||y>=tile.y+tile.height&&tile.y+tile.height<height))continue;
        candidates.push(mapped);
      }
      onProgress?.(index+1,passes.length,`顔検出 ${index+1}/${passes.length}`);await tick();
    }
    return nonMaxSuppression(candidates).sort((a,b)=>b.box.width*b.box.height-a.box.width*a.box.height);
  }finally{input.width=input.height=1;}
}

export async function detectFacesOriginal(canvas,{signal,onProgress,tiled=true}={}){
  checkAbort(signal);const sessions=await loadEngine(message=>onProgress?.(0,0,message));
  return serialize(async()=>{
    const candidates=await findCandidates(canvas,sessions,{signal,onProgress,tiled});const faces=[];
    for(let i=0;i<candidates.length;i++){checkAbort(signal);faces.push(await describeOriginal(canvas,candidates[i],sessions));onProgress?.(i+1,candidates.length,`元画像から特徴抽出 ${i+1}/${candidates.length}`);await tick();}
    checkAbort(signal);return faces;
  });
}

/** A manual selection still needs one actual detected face, not a guessed embedding. */
export async function extractRegion(source,region,{signal}={}){
  if(!region||![region.x,region.y,region.width,region.height].every(Number.isFinite)||region.width<16||region.height<16)throw new Error('登録する顔全体を少し大きく囲んでください。');
  const left=Math.max(0,region.x),top=Math.max(0,region.y),right=Math.min(source.width,region.x+region.width),bottom=Math.min(source.height,region.y+region.height);
  if(right-left<16||bottom-top<16)throw new Error('顔の範囲が画像の外側です。');
  const sessions=await loadEngine();
  return serialize(async()=>{
    for(const padding of [.12,.35,.65,1]){
      checkAbort(signal);const width=right-left,height=bottom-top;
      const x=Math.max(0,Math.floor(left-width*padding)),y=Math.max(0,Math.floor(top-height*padding));
      const cropRight=Math.min(source.width,Math.ceil(right+width*padding)),cropBottom=Math.min(source.height,Math.ceil(bottom+height*padding));
      const crop=canvas2D(cropRight-x,cropBottom-y);context2D(crop).drawImage(source,x,y,crop.width,crop.height,0,0,crop.width,crop.height);
      let faces;
      try{faces=await findCandidates(crop,sessions,{signal,tiled:false});}finally{crop.width=crop.height=1;}
      const valid=faces.map(face=>({...face,box:{...face.box,x:face.box.x+x,y:face.box.y+y},landmarks:face.landmarks.map(([u,v])=>[u+x,v+y])}))
        .filter(face=>{const cx=face.box.x+face.box.width/2,cy=face.box.y+face.box.height/2;return cx>=left&&cx<=right&&cy>=top&&cy<=bottom;});
      if(valid.length>1)throw new Error('範囲に複数の顔があります。1人の顔だけを囲んでください。');
      if(valid.length===1){checkAbort(signal);return describeOriginal(source,valid[0],sessions);}
    }
    throw new Error('この範囲で顔を確認できませんでした。囲み直すか別の写真を選んでください。');
  });
}
