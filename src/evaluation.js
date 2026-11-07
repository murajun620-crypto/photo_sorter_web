/**
 * Local, labelled comparison of two independent face engines.
 * This module evaluates supplied annotations; it never trains or uploads data.
 */
export const OTHER_PERSON = '__other__';
export const UNCERTAIN_PERSON = '__uncertain__';
const DIMENSION = 128;
const IOU_THRESHOLD = .3;

function fail(message) { throw new Error(message); }
function engineName(engine) {
  if (engine !== 'old' && engine !== 'new') fail('比較する顔認識方式が正しくありません。');
  return engine;
}
function vector(value) {
  if (!value || value.length !== DIMENSION || !Array.from(value).every(Number.isFinite)) {
    fail('顔の特徴量は、有限の数値128個で指定してください。');
  }
  return value;
}
function rectangle(value) {
  if (!value || ![value.x,value.y,value.width,value.height].every(Number.isFinite) || value.width <= 0 || value.height <= 0) {
    fail('顔の四角の位置・大きさが正しくありません。');
  }
  return value;
}
function profileIds(profiles) {
  if (!Array.isArray(profiles) || !profiles.length) fail('評価する人物を登録してください。');
  const ids = profiles.map(value => typeof value === 'string' ? value : value?.id);
  if (ids.some(id => typeof id !== 'string' || !id || id === OTHER_PERSON || id === UNCERTAIN_PERSON) || new Set(ids).size !== ids.length) {
    fail('人物の識別情報が重複しているか、正しくありません。');
  }
  return ids;
}

function validateInputs(samples, profiles) {
  const ids = profileIds(profiles), labels = new Set([...ids,OTHER_PERSON,UNCERTAIN_PERSON]);
  if (!Array.isArray(samples)) fail('比較する写真を指定してください。');
  const sampleIds = new Set(), referenceGroups = new Set(), testGroups = new Set();
  const engineIds={old:new Set(),new:new Set()};
  const normalized = samples.map(sample => {
    if (!sample || typeof sample.id !== 'string' || !sample.id || sampleIds.has(sample.id)) fail('写真の識別情報が重複しているか、正しくありません。');
    sampleIds.add(sample.id);
    if (sample.role !== 'reference' && sample.role !== 'test') fail('写真を参照用または評価用に分けてください。');
    const sourceGroup = sample.sourceGroup ?? sample.id;
    if (typeof sourceGroup !== 'string' || !sourceGroup) fail('元の写真を識別する情報がありません。');
    (sample.role === 'reference' ? referenceGroups : testGroups).add(sourceGroup);
    if (sample.role === 'test' && sample.reviewed !== true) fail('評価用写真の顔をすべて確認し、確認済みにしてください。');
    if (!Array.isArray(sample.truths)) fail('写真の正解となる顔を指定してください。');
    const truthIds = new Set();
    for (const truth of sample.truths) {
      if (!truth || !labels.has(truth.label)) fail('正解の人物が登録されていません。');
      rectangle(truth.box);
      if (truth.id != null) {
        if (typeof truth.id !== 'string' || !truth.id || truthIds.has(truth.id)) fail('正解の顔の識別情報が重複しています。');
        truthIds.add(truth.id);
      }
      for (const engine of ['old','new']) if (truth[`${engine}Descriptor`] != null) {
        vector(truth[`${engine}Descriptor`]);
        const featureId=truth[`${engine}DescriptorEngineId`];
        if(featureId!=null&&featureId!==sample[`${engine}EngineId`])fail('参照した顔のモデル・前処理が写真と一致しません。再解析してください。');
      }
    }
    for (const engine of ['old','new']) {
      const modelId=sample[`${engine}EngineId`];
      if(modelId!=null){
        if(typeof modelId!=='string'||!modelId)fail('特徴量の方式・モデル識別子が正しくありません。');
        engineIds[engine].add(modelId);
      }
      const faces = sample[`${engine}Faces`] ?? [];
      if (!Array.isArray(faces)) fail('検出した顔の情報が正しくありません。');
      for (const face of faces) {
        rectangle(face?.box); vector(face?.descriptor);
        if (face.engine != null && face.engine !== engine) fail('異なる顔認識方式の特徴量を混ぜることはできません。');
        if(face.engineId!=null&&face.engineId!==modelId)fail('写真と顔の特徴量のモデル識別子が一致しません。再解析してください。');
      }
    }
    return {...sample,sourceGroup};
  });
  for (const group of referenceGroups) if (testGroups.has(group)) fail('同じ元写真が参照用と評価用の両方に含まれています。別の写真で評価してください。');
  for(const engine of ['old','new']){
    if(engineIds[engine].size>1)fail('同じ方式に異なるモデル・前処理の特徴量が混ざっています。全写真を同じ方式で再解析してください。');
    if(engineIds[engine].size&&normalized.some(sample=>sample[`${engine}EngineId`]==null))fail('一部の写真にモデル識別子がありません。全写真を同じ方式で再解析してください。');
  }
  if(engineIds.old.size&&engineIds.new.size&&[...engineIds.old][0]===[...engineIds.new][0])fail('旧方式と新方式のモデル識別子を分けてください。');
  if (!normalized.some(sample => sample.role === 'test')) fail('参照用とは別の、確認済みの評価写真が必要です。');
  const referenceSources = Object.fromEntries(ids.map(id => [id,new Set()]));
  for (const sample of normalized.filter(sample => sample.role === 'reference')) {
    for (const truth of sample.truths) if (referenceSources[truth.label]) referenceSources[truth.label].add(sample.sourceGroup);
  }
  for (const id of ids) if (!referenceSources[id].size) fail(`人物 ${id} の参照用写真がありません。`);
  return {samples:normalized,ids,referenceSources,engineIds:Object.fromEntries(['old','new'].map(engine=>[engine,[...engineIds[engine]][0]??null]))};
}

/** A tagged reference bank prevents equal-length vectors crossing engines. */
export function prepareReferenceBanks(samples, profiles) {
  const ids = profileIds(profiles);
  const banks = Object.fromEntries(['old','new'].map(engine => {
    const modelIds=[...new Set((samples||[]).map(sample=>sample?.[`${engine}EngineId`]).filter(value=>value!=null))];
    if(modelIds.length>1||modelIds.some(value=>typeof value!=='string'||!value))fail('参照データのモデル識別子が一致しません。');
    return [engine,{engine,modelId:modelIds[0]??null,dimension:DIMENSION,byPerson:Object.fromEntries(ids.map(id => [id,[]]))}];
  }));
  if(banks.old.modelId&&banks.new.modelId&&banks.old.modelId===banks.new.modelId)fail('旧方式と新方式のモデル識別子を分けてください。');
  for (const sample of samples || []) if (sample?.role === 'reference') {
    for (const truth of sample.truths || []) if (ids.includes(truth.label)) {
      for (const engine of ['old','new']) {
        const feature = truth[`${engine}Descriptor`];
        if (feature != null) banks[engine].byPerson[truth.label].push(Float32Array.from(vector(feature)));
      }
    }
  }
  return banks;
}

function cosine(a,b) {
  let dot=0, aa=0, bb=0;
  for (let i=0;i<DIMENSION;i++) { dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i]; }
  if (aa <= 1e-20 || bb <= 1e-20) fail('新方式の顔特徴量が空です。写真から再解析してください。');
  return Math.max(-1,Math.min(1,dot/Math.sqrt(aa*bb)));
}
function euclidean(a,b) { let sum=0;for(let i=0;i<DIMENSION;i++)sum+=(a[i]-b[i])**2;return Math.sqrt(sum); }

/** Scores are distance for old, cosine similarity for new; never probabilities. */
export function predictFace(engine, descriptor, bank, {threshold,ambiguityMargin=.05,modelId}={}) {
  engineName(engine); vector(descriptor);
  if (!bank || bank.engine !== engine || bank.dimension !== DIMENSION || !bank.byPerson) fail('異なる顔認識方式の参照データを混ぜることはできません。');
  if(modelId!=null&&modelId!==bank.modelId)fail('顔と参照データのモデル・前処理が一致しません。再解析してください。');
  const limit=threshold ?? (engine==='old'?.52:.363);
  if (!Number.isFinite(limit) || !Number.isFinite(ambiguityMargin) || ambiguityMargin<0 || (engine==='old'?limit<0:limit< -1||limit>1)) fail('評価しきい値が正しくありません。');
  const candidates=[];
  for (const [personId,features] of Object.entries(bank.byPerson)) {
    if (!Array.isArray(features)) fail('顔の参照データが正しくありません。');
    if (!features.length) continue;
    const scores=features.map(feature => engine==='old'?euclidean(descriptor,vector(feature)):cosine(descriptor,vector(feature)));
    candidates.push({personId,score:engine==='old'?Math.min(...scores):Math.max(...scores)});
  }
  candidates.sort((a,b)=>engine==='old'?a.score-b.score:b.score-a.score);
  const best=candidates[0], second=candidates[1];
  const margin=second?(engine==='old'?second.score-best.score:best.score-second.score):null;
  const result={personId:null,status:'rejected',score:best?.score??null,candidates,margin};
  if (!best || (engine==='old'?best.score>limit:best.score<limit)) return result;
  if (second && (margin<=1e-12 || margin+1e-12<ambiguityMargin)) return {...result,status:'ambiguous'};
  return {...result,personId:best.personId,status:'matched'};
}

export function boxIoU(a,b) {
  rectangle(a);rectangle(b);
  const width=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x));
  const height=Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
  const intersection=width*height;
  return intersection/(a.width*a.height+b.width*b.height-intersection);
}

/** Maximum-IoU greedy one-to-one matching; identity never influences geometry. */
function matchGeometry(faces,truths) {
  const pairs=[];
  for(let faceIndex=0;faceIndex<faces.length;faceIndex++)for(let truthIndex=0;truthIndex<truths.length;truthIndex++){
    const iou=boxIoU(faces[faceIndex].box,truths[truthIndex].box);
    if(iou>=IOU_THRESHOLD)pairs.push({faceIndex,truthIndex,iou});
  }
  pairs.sort((a,b)=>b.iou-a.iou||a.faceIndex-b.faceIndex||a.truthIndex-b.truthIndex);
  const usedFaces=new Set(),usedTruths=new Set(),matches=[];
  for(const pair of pairs)if(!usedFaces.has(pair.faceIndex)&&!usedTruths.has(pair.truthIndex)){
    usedFaces.add(pair.faceIndex);usedTruths.add(pair.truthIndex);matches.push(pair);
  }
  return {matches,byFace:new Map(matches.map(pair=>[pair.faceIndex,pair])),byTruth:new Map(matches.map(pair=>[pair.truthIndex,pair]))};
}

const countMetrics=()=>({targetFaces:0,detectedTargetFaces:0,correctKnownFaces:0,acceptedPredictions:0,wrongPredictions:0,rejectedFaces:0});
const rate=(numerator,denominator)=>denominator?numerator/denominator:null;
function rates(metrics){return {...metrics,precision:rate(metrics.correctKnownFaces,metrics.acceptedPredictions),recall:rate(metrics.correctKnownFaces,metrics.targetFaces),
  detectionRecall:rate(metrics.detectedTargetFaces,metrics.targetFaces),missedDetections:metrics.targetFaces-metrics.detectedTargetFaces};}

function evaluateOne(engine,samples,ids,bank,options){
  const totals=countMetrics(),byPerson=Object.fromEntries(ids.map(id=>[id,{...countMetrics(),truthPhotos:0,exportedPhotos:0,correctFolderPhotos:0,wrongFolderPhotos:0,missedPhotos:0}]));
  const confusion=Object.fromEntries([...ids,OTHER_PERSON].map(id=>[id,Object.fromEntries([...ids,'__rejected__','__missed__'].map(other=>[other,0]))]));
  const sampleResults=[];let excludedUncertainFaces=0,excludedUncertainPhotos=0,detectedFaces=0;
  for(const sample of samples){
    const truths=sample.truths,faces=sample[`${engine}Faces`]??[];
    const predictions=faces.map(face=>predictFace(engine,face.descriptor,bank,options));
    const geometry=matchGeometry(faces,truths),truthSet=new Set(),predictionSet=new Set();
    const uncertain=truths.some(truth=>truth.label===UNCERTAIN_PERSON);
    if(uncertain)excludedUncertainPhotos++;
    detectedFaces+=faces.length;
    for(let truthIndex=0;truthIndex<truths.length;truthIndex++){
      const truth=truths[truthIndex];
      if(truth.label===UNCERTAIN_PERSON)continue;
      if(ids.includes(truth.label)){
        totals.targetFaces++;byPerson[truth.label].targetFaces++;truthSet.add(truth.label);
        if(geometry.byTruth.has(truthIndex)){totals.detectedTargetFaces++;byPerson[truth.label].detectedTargetFaces++;}
      }
      if(!geometry.byTruth.has(truthIndex))confusion[truth.label].__missed__++;
    }
    const diagnostics=[];
    for(let faceIndex=0;faceIndex<faces.length;faceIndex++){
      const prediction=predictions[faceIndex],pair=geometry.byFace.get(faceIndex),truth=pair?truths[pair.truthIndex]:null;
      if(truth?.label===UNCERTAIN_PERSON){excludedUncertainFaces++;diagnostics.push({faceIndex,truthId:truth.id??null,truthLabel:truth.label,ignored:true,prediction});continue;}
      if(prediction.personId){
        totals.acceptedPredictions++;byPerson[prediction.personId].acceptedPredictions++;predictionSet.add(prediction.personId);
        if(truth?.label===prediction.personId){totals.correctKnownFaces++;byPerson[prediction.personId].correctKnownFaces++;}
        else{totals.wrongPredictions++;byPerson[prediction.personId].wrongPredictions++;}
      }else{
        totals.rejectedFaces++;
        if(truth&&ids.includes(truth.label))byPerson[truth.label].rejectedFaces++;
      }
      confusion[truth?.label??OTHER_PERSON][prediction.personId??'__rejected__']++;
      diagnostics.push({faceIndex,truthId:truth?.id??null,truthLabel:truth?.label??OTHER_PERSON,unmatched:!pair,ignored:false,iou:pair?.iou??0,prediction});
    }
    if(!uncertain)for(const id of ids){
      const expected=truthSet.has(id),exported=predictionSet.has(id),person=byPerson[id];
      if(expected)person.truthPhotos++;
      if(exported)person.exportedPhotos++;
      if(expected&&exported)person.correctFolderPhotos++;
      if(!expected&&exported)person.wrongFolderPhotos++;
      if(expected&&!exported)person.missedPhotos++;
    }
    sampleResults.push({id:sample.id,sourceGroup:sample.sourceGroup,truthPeople:[...truthSet],predictedPeople:[...predictionSet],folderEvaluationExcluded:uncertain,
      detections:diagnostics,missedTruths:truths.map((truth,index)=>({truth,index})).filter(({truth,index})=>truth.label!==UNCERTAIN_PERSON&&!geometry.byTruth.has(index)).map(({truth,index})=>({truthId:truth.id??null,truthIndex:index,label:truth.label}))});
  }
  for(const id of ids)byPerson[id]={...rates(byPerson[id]),folderPrecision:rate(byPerson[id].correctFolderPhotos,byPerson[id].exportedPhotos),folderRecall:rate(byPerson[id].correctFolderPhotos,byPerson[id].truthPhotos)};
  return {engine,modelId:bank.modelId,threshold:options.threshold,ambiguityMargin:options.ambiguityMargin,metrics:{...rates(totals),detectedFaces,excludedUncertainFaces,excludedUncertainPhotos},
    byPerson,confusion,sampleResults,missingReferencePeople:ids.filter(id=>!bank.byPerson[id].length)};
}

export function evaluateEngines(samples,profiles,{oldThreshold=.52,newThreshold=.363,ambiguityMargin=.05}={}){
  const prepared=validateInputs(samples,profiles),banks=prepareReferenceBanks(prepared.samples,profiles),warnings=[];
  const reference=prepared.samples.filter(sample=>sample.role==='reference'),test=prepared.samples.filter(sample=>sample.role==='test');
  const testSources=Object.fromEntries(prepared.ids.map(id=>[id,new Set()]));
  for(const engine of ['old','new'])if(!prepared.engineIds[engine])warnings.push({code:'MISSING_ENGINE_ID',engine,count:0,message:'特徴量のモデル識別子がありません。精度比較の前に同一方式で再解析してください。'});
  for(const sample of test)for(const truth of sample.truths)if(testSources[truth.label])testSources[truth.label].add(sample.sourceGroup);
  for(const id of prepared.ids){
    if(prepared.referenceSources[id].size<3)warnings.push({code:'LOW_REFERENCE_COUNT',personId:id,count:prepared.referenceSources[id].size,message:'参照用写真が3枚未満です。角度や表情の違う写真で比較してください。'});
    if(testSources[id].size<10)warnings.push({code:'LOW_TEST_COUNT',personId:id,count:testSources[id].size,message:'独立した評価用写真が10枚未満です。精度が安定しているとは判断できません。'});
  }
  const old=evaluateOne('old',test,prepared.ids,banks.old,{threshold:oldThreshold,ambiguityMargin});
  const newer=evaluateOne('new',test,prepared.ids,banks.new,{threshold:newThreshold,ambiguityMargin});
  for(const result of [old,newer])for(const id of result.missingReferencePeople)warnings.push({code:'MISSING_ENGINE_REFERENCE',engine:result.engine,personId:id,count:0,message:'この方式で読み取れた参照特徴量がなく、この人物を確定できません。'});
  if(old.metrics.excludedUncertainPhotos)warnings.push({code:'UNCERTAIN_GROUND_TRUTH',count:old.metrics.excludedUncertainPhotos,message:'人物が不確かな写真はフォルダ精度の集計から除いています。'});
  return {schema:1,persons:prepared.ids,referencePhotos:reference.length,testPhotos:test.length,referenceSources:Object.fromEntries(prepared.ids.map(id=>[id,prepared.referenceSources[id].size])),
    testSources:Object.fromEntries(prepared.ids.map(id=>[id,testSources[id].size])),references:banks,old,new:newer,warnings};
}

/** Explicit allow-list: raw diagnostics, labels, IDs, names and vectors cannot leak. */
export function anonymizeResults(result){
  if(!result||result.schema!==1||!Array.isArray(result.persons))fail('匿名化する評価結果が正しくありません。');
  const labels=new Map(result.persons.map((id,index)=>[id,`person${index+1}`]));
  const anonymous=id=>labels.get(id)??(id===OTHER_PERSON?'other':id==='__rejected__'?'rejected':id==='__missed__'?'missed':'unknown');
  const metricKeys=['targetFaces','detectedTargetFaces','correctKnownFaces','acceptedPredictions','wrongPredictions','rejectedFaces','precision','recall','detectionRecall','missedDetections','detectedFaces','excludedUncertainFaces','excludedUncertainPhotos','truthPhotos','exportedPhotos','correctFolderPhotos','wrongFolderPhotos','missedPhotos','folderPrecision','folderRecall'];
  const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
  const numbers=value=>Object.fromEntries(metricKeys.filter(key=>key in (value||{})).map(key=>[key,number(value[key])]));
  function engine(source){
    return {threshold:number(source.threshold),ambiguityMargin:number(source.ambiguityMargin),metrics:numbers(source.metrics),
      byPerson:Object.fromEntries(result.persons.map(id=>[anonymous(id),{...numbers(source.byPerson[id]),referenceSources:number(result.referenceSources[id]),testSources:number(result.testSources[id])}])),
      confusion:Object.fromEntries(Object.entries(source.confusion).map(([truth,row])=>[anonymous(truth),Object.fromEntries(Object.entries(row).map(([prediction,count])=>[anonymous(prediction),number(count)]))])),
      missingReferencePeople:(source.missingReferencePeople||[]).map(anonymous)};
  }
  const warningCodes=new Set(['LOW_REFERENCE_COUNT','LOW_TEST_COUNT','MISSING_ENGINE_REFERENCE','UNCERTAIN_GROUND_TRUTH','MISSING_ENGINE_ID']);
  return {schema:1,persons:result.persons.length,referencePhotos:number(result.referencePhotos),testPhotos:number(result.testPhotos),old:engine(result.old),new:engine(result.new),
    warnings:(result.warnings||[]).map(warning=>({code:warningCodes.has(warning.code)?warning.code:'OTHER_WARNING',...(['old','new'].includes(warning.engine)?{engine:warning.engine}:{}),...(warning.personId?{person:anonymous(warning.personId)}:{}),...(Number.isFinite(warning.count)?{count:warning.count}:{})}))};
}
