import {ENGINE_ID,loadEngine,detectFacesOriginal,extractRegion,intersectionOverUnion} from './onnx-face-engine.js?v=1.1.0';

export {ENGINE_ID};
// SFace descriptors are unit vectors. Euclidean distance 1.10 corresponds to
// cosine similarity 0.395; legacy face-api distance thresholds are not reusable.
export const DEFAULT_MAX_DISTANCE=1.10;

export function assertCurrentFeature(feature){
  const vector=feature?.descriptor;
  if(feature?.engineId!==ENGINE_ID||vector?.length!==128||!Array.from(vector).every(Number.isFinite)){
    throw new Error('顔の認識方式が変わっています。元の写真から顔を登録し直し、写真を再解析してください。');
  }
  const norm=Array.from(vector).reduce((sum,value)=>sum+value*value,0);
  if(Math.abs(norm-1)>.002)throw new Error('顔の特徴データを確認できません。元の写真から登録・解析し直してください。');
  return feature;
}

export function loadModels(onProgress){return loadEngine(onProgress);}

export async function detectFaces(canvas,options={}){
  const faces=await detectFacesOriginal(canvas,options);
  return faces.map(assertCurrentFeature);
}

export async function descriptorFromRegion(canvas,region,options={}){
  return assertCurrentFeature(await extractRegion(canvas,region,options));
}

function sameRegisteredFace(left,right){
  const overlap=intersectionOverUnion(left.box,right.box);
  if(overlap>=.7)return true;
  if(overlap<.3)return false;
  const valid=points=>Array.isArray(points)&&points.length===5&&points.every(point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite));
  if(!valid(left.landmarks)||!valid(right.landmarks))return false;
  const squared=left.landmarks.reduce((sum,point,index)=>sum+(point[0]-right.landmarks[index][0])**2+(point[1]-right.landmarks[index][1])**2,0);
  const scale=Math.min(left.box.width,left.box.height,right.box.width,right.box.height);
  // A tighter/manual crop can change the detector's box while preserving the
  // actual eye/nose/mouth positions. Distinct neighboring faces stay separate.
  return Math.sqrt(squared/5)<.15*scale;
}

/** Explicitly registered regions survive a full-photo detector miss. */
export function mergeRegisteredFaces(detected=[],registered=[]){
  if(!Array.isArray(detected)||!Array.isArray(registered))throw new Error('顔の登録データを確認できません。');
  const copy=face=>{
    assertCurrentFeature(face);
    if(!face.box||![face.box.x,face.box.y,face.box.width,face.box.height].every(Number.isFinite)||face.box.width<=0||face.box.height<=0)throw new Error('登録した顔の範囲を確認できません。');
    return {...face,box:{...face.box},descriptor:Float32Array.from(face.descriptor),...(face.feedback?{feedback:{...face.feedback}}:{})};
  };
  const output=detected.map(copy);
  const enrolled=[];
  for(const source of registered){
    const face=copy(source);
    const repeated=enrolled.findIndex(previous=>sameRegisteredFace(face,previous));
    if(repeated<0)enrolled.push(face);else enrolled[repeated]=face;
  }
  const pairs=[];
  for(let r=0;r<enrolled.length;r++)for(let d=0;d<output.length;d++){
    const overlap=intersectionOverUnion(enrolled[r].box,output[d].box);
    if(overlap>=.3)pairs.push({r,d,overlap});
  }
  pairs.sort((a,b)=>b.overlap-a.overlap);
  const registeredUsed=new Set(),detectedUsed=new Set();
  for(const {r,d} of pairs){
    if(registeredUsed.has(r)||detectedUsed.has(d))continue;
    output[d]={...output[d],...enrolled[r],registered:true};registeredUsed.add(r);detectedUsed.add(d);
  }
  enrolled.forEach((face,index)=>{if(!registeredUsed.has(index))output.push({...face,registered:true});});
  return output;
}

function isCurrentSnapshot(snapshot){
  if(snapshot.engineId!==ENGINE_ID)return false;
  try{
    for(const profile of snapshot.profiles){
      if(profile.engineId!==ENGINE_ID)return false;
      for(const example of [...(profile.refs||[]),...(profile.negatives||[])])assertCurrentFeature(example);
    }
    for(const record of snapshot.records){
      if(record.facesDetected&&record.engineId!==ENGINE_ID)return false;
      for(const face of [...(record.faces||[]),...(record.registeredFaces||[])])assertCurrentFeature(face);
    }
    return true;
  }catch{return false;}
}

function pendingReference(ref){
  // A legacy80px preview is retained only to help the user find the person.
  // It must never be fed into the new model as if it were an original photo.
  return {id:ref?.id,blob:ref?.blob,sourceRecordId:ref?.sourceRecordId,
    box:ref?.box?{...ref.box}:undefined,source:'previous-engine'};
}

/** Preserve photos and explicit photo edits, but never reuse another model's128D cache. */
export function migrateSnapshot(snapshot){
  if(!snapshot||!Array.isArray(snapshot.profiles)||!Array.isArray(snapshot.records))throw new Error('一時保存データの形式が違います。');
  if(isCurrentSnapshot(snapshot))return {snapshot,migrated:false,needsRegistration:0};
  const profiles=snapshot.profiles.map(profile=>({...profile,engineId:ENGINE_ID,
    pendingRefs:[...(profile.pendingRefs||[]),...(profile.refs||[])].map(pendingReference),refs:[],negatives:[]}));
  const records=snapshot.records.map(record=>({...record,engineId:ENGINE_ID,
    faces:[],registeredFaces:[],distances:{},faceMatches:[],matchedIds:[],reviewIds:[],
    analyzed:false,featuresReady:false,facesDetected:false,selected:false,
    error:null,needsReview:false,faceNeedsReview:false,reviewReason:null,
    blurry:false,sharpness:null,sharpnessBasis:null}));
  return {snapshot:{...snapshot,engineId:ENGINE_ID,profiles,records,analyzedMode:null,
    controls:{...snapshot.controls,distance:String(DEFAULT_MAX_DISTANCE),'ambiguity-margin':'0.05'}},
    migrated:true,needsRegistration:profiles.filter(profile=>profile.pendingRefs.length>0).length};
}
