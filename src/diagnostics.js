import {decodeImage,detectFaces as detectLegacy} from './imaging.js?v=1.0.3';
import {descriptorFromRegion as extractLegacy} from './face-regions.js?v=1.0.3';
import {mountFaceEditor} from './face-editor.js?v=1.0.3';
import {ENGINE_ID,loadEngine,detectFacesOriginal,getAlignedFace,extractRegion} from './onnx-face-engine.js?v=lab1';
import {evaluateEngines,predictFace,anonymizeResults} from './evaluation.js?v=lab1';

export const OLD_ENGINE_ID='face-api-0.22.2:5d66ec95338d7fcc365ce15481b8599baf4b6e22c9a624b76d4ca821a669a659:full1280-landmarks68-v1';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>crypto.randomUUID();
const waitFrame=()=>new Promise(resolve=>setTimeout(resolve,0));
const state={samples:[],profiles:[],current:null,decoded:null,editor:null,result:null,busy:false,controller:null,activePerson:null};
const urls=new Set();let cropURLs=[];let cropGeneration=0;
const objectURL=blob=>{const url=URL.createObjectURL(blob);urls.add(url);return url;};
const release=url=>{if(url){URL.revokeObjectURL(url);urls.delete(url);}};
const current=()=>state.samples.find(s=>s.id===state.current);
const names=()=>[...state.profiles,{id:'__other__',name:'他の人（登録しない）'},{id:'__uncertain__',name:'判別不能'}];
const personName=id=>names().find(p=>p.id===id)?.name||id;
const percent=value=>Number.isFinite(value)?`${(value*100).toFixed(1)}%`:'—';
function prunePeople(){const used=new Set(state.samples.flatMap(sample=>sample.truths.map(t=>t.label)));state.profiles=state.profiles.filter(person=>used.has(person.id));}

function status(text,error=false){$('lab-status').textContent=text;$('lab-status').classList.toggle('lab-error',error);}
function controls(){
  document.querySelectorAll('#lab-files,#lab-run,#lab-clear,#lab-role,#lab-reviewed,#lab-group,#lab-box-mode,#lab-old-threshold,#lab-new-threshold,#lab-export,#lab-list button').forEach(node=>node.disabled=state.busy);
  $('lab-cancel').disabled=!state.busy;$('lab-run').disabled=state.busy||!state.samples.length;$('lab-export').disabled=state.busy||!state.result;
}
async function task(title,fn){
  if(state.busy)return;
  state.busy=true;state.controller=new AbortController();controls();status(title);$('lab-progress').removeAttribute('value');
  try{return await fn(state.controller.signal);}
  catch(error){status(error.name==='AbortError'?'中止しました。完了済みの確認内容は残ります。':error.message,true);}
  finally{state.busy=false;state.controller=null;controls();}
}
function progress(done,total,message){status(message);if(total)$('lab-progress').value=done/total*100;else $('lab-progress').removeAttribute('value');}
function invalidate(){state.result=null;$('lab-export').disabled=true;$('lab-results').innerHTML='<p class="hint">正解・用途を変更しました。比較を実行してください。</p>';}
async function thumb(canvas,max=200){
  const scale=Math.min(1,max/Math.max(canvas.width,canvas.height));const small=document.createElement('canvas');small.width=Math.max(1,Math.round(canvas.width*scale));small.height=Math.max(1,Math.round(canvas.height*scale));small.getContext('2d').drawImage(canvas,0,0,small.width,small.height);
  const blob=await new Promise(resolve=>small.toBlob(resolve,'image/jpeg',.85));small.width=small.height=1;
  if(!blob)throw new Error('画像の表示を準備できません。');return objectURL(blob);
}
async function fileHash(file){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('');}
function renderList(){
  $('lab-list').innerHTML=state.samples.map(sample=>`<button type="button" class="lab-sample ${sample.id===state.current?'active':''}" data-sample-id="${sample.id}"><img src="${sample.thumb}" alt=""><span>${esc(sample.file.name)}<small>${sample.role==='reference'?'参照用':'評価用'} · 正解 ${sample.truths.length}顔 · ${sample.reviewed?'確認済み':'未確認'}</small></span></button>`).join('');
  $('lab-count').textContent=`${state.samples.length}枚 / 参照 ${state.samples.filter(s=>s.role==='reference').length}枚 / 評価 ${state.samples.filter(s=>s.role==='test').length}枚`;
  controls();
}
function overlap(a,b){const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),right=Math.min(a.x+a.width,b.x+b.width),bottom=Math.min(a.y+a.height,b.y+b.height),intersection=Math.max(0,right-x)*Math.max(0,bottom-y);return intersection/(a.width*a.height+b.width*b.height-intersection||1);}
function renderTruths(){
  const sample=current();if(!sample)return;
  $('lab-truth-list').innerHTML=sample.truths.length?sample.truths.map(truth=>`<div class="lab-truth-row"><span>${esc(personName(truth.label))} <small>${Math.round(truth.box.width)} × ${Math.round(truth.box.height)} px</small></span><button class="text-button danger" data-remove-truth="${truth.id}">正解の枠を削除</button></div>`).join(''):'<p class="hint">正解ラベルはまだありません。見落としは手動で囲んで追加できます。</p>';
  $('lab-reviewed').checked=sample.reviewed;
  const counts=$('lab-face-details').querySelector('p');if(counts)counts.textContent=`正解 ${sample.truths.length}顔 / 新方式 ${sample.newFaces?.length??'未実行'}顔 / 旧方式 ${sample.oldFaces?.length??'未実行'}顔`;
}
function facesForView(sample){const mode=$('lab-box-mode').value;return mode==='old'?(sample.oldFaces||[]):mode==='truth'?sample.truths.map(t=>({box:t.box})):sample.newFaces||[];}
function mountEditor(){
  const sample=current();if(!sample||!state.decoded)return;
  state.editor?.destroy();$('lab-editor').replaceChildren();
  state.editor=mountFaceEditor({container:$('lab-editor'),canvas:state.decoded.canvas,faces:facesForView(sample),profiles:names(),activePersonId:state.activePerson,
    onClose:()=>{},onError:error=>status(error.message,true),
    async onRegister({personId,name,region}){
      if(state.busy)throw new Error('処理が終わってからラベルを付けてください。');
      let person=names().find(p=>p.id===personId);
      if(!person){
        const clean=String(name||'').trim().slice(0,60);if(!clean)throw new Error('人物名を入力してください。');
        person=state.profiles.find(p=>p.name===clean);
        if(!person){person={id:uid(),name:clean};state.profiles.push(person);}
      }
      const existing=sample.truths.find(t=>overlap(t.box,region)>.5);
      const truth={id:existing?.id||uid(),label:person.id,box:{...region}};
      sample.truths=sample.truths.filter(t=>t.id!==truth.id).concat(truth);sample.reviewed=false;state.activePerson=person.id;
      prunePeople();
      invalidate();renderTruths();renderList();
      return {profiles:names(),personId:person.id,message:`${person.name}を正解として記録しました。ほかの顔も確認してください。`};
    },
  });
}
async function ensureNew(sample,canvas,signal){
  if(sample.newEngineId!==ENGINE_ID||!sample.newFaces){sample.newFaces=await detectFacesOriginal(canvas,{signal,onProgress:progress});sample.newEngineId=ENGINE_ID;}
}
async function ensureOld(sample,canvas,signal){
  if(signal.aborted)throw new DOMException('中止','AbortError');
  if(sample.oldEngineId!==OLD_ENGINE_ID||!sample.oldFaces){status('旧方式で顔を検出・特徴抽出しています…');sample.oldFaces=await detectLegacy(canvas);sample.oldEngineId=OLD_ENGINE_ID;}
}
async function showPhoto(id){
  if(state.busy)return;
  await task('写真を表示しています…',async signal=>{
    state.editor?.destroy();state.editor=null;state.decoded?.close();state.decoded=null;
    state.current=id;const sample=current();if(!sample)return;
    state.decoded=await decodeImage(sample.file);
    $('lab-current').hidden=false;$('lab-placeholder').hidden=true;$('lab-name').textContent=sample.file.name;$('lab-role').value=sample.role;$('lab-group').value=sample.sourceGroup;
    await loadEngine(text=>status(text));await ensureNew(sample,state.decoded.canvas,signal);
    if($('lab-box-mode').value==='old')await ensureOld(sample,state.decoded.canvas,signal);
    mountEditor();renderTruths();renderList();await renderFaceDetails();
    status('検出枠を選んで正解の名前を付けてください。検出されない顔は手動で囲みます。');$('lab-progress').value=100;
  });
}
async function renderFaceDetails(){
  const generation=++cropGeneration;cropURLs.forEach(release);cropURLs=[];
  const sample=current();if(!sample||!state.decoded)return;
  const canvas=state.decoded.canvas;const list=document.createElement('div');list.className='lab-face-grid';
  const counts=document.createElement('p');counts.className='hint';counts.textContent=`正解 ${sample.truths.length}顔 / 新方式 ${sample.newFaces?.length??'未実行'}顔 / 旧方式 ${sample.oldFaces?.length??'未実行'}顔`;
  $('lab-face-details').replaceChildren(counts,list);
  for(const [index,face] of (sample.newFaces||[]).slice(0,30).entries()){
    const item=document.createElement('div');item.className='lab-face-item';
    if(face.landmarks){const aligned=getAlignedFace(canvas,face);const url=await thumb(aligned,112);aligned.width=aligned.height=1;if(generation!==cropGeneration){release(url);return;}cropURLs.push(url);const img=document.createElement('img');img.src=url;img.alt=`新方式の整列顔 ${index+1}`;item.append(img);}
    const sourceWidth=face.box.width,legacyWidth=sourceWidth*Math.min(1,1280/Math.max(canvas.width,canvas.height));
    const info=document.createElement('div');info.textContent=`新方式の顔 ${index+1} · 元幅 ${sourceWidth.toFixed(0)} px / 旧方式の特徴抽出時 約${legacyWidth.toFixed(1)} px`;item.append(info);
    if(state.result){const prediction=predictFace('new',face.descriptor,state.result.references.new,{threshold:Number($('lab-new-threshold').value),ambiguityMargin:.05,modelId:ENGINE_ID});const label=document.createElement('div');label.textContent=prediction.personId?`新候補：${personName(prediction.personId)} (${prediction.score.toFixed(3)})`:'新候補：保留';item.append(label);}
    list.append(item);
  }
  if(state.result)for(const [index,face] of (sample.oldFaces||[]).slice(0,30).entries()){
    const prediction=predictFace('old',face.descriptor,state.result.references.old,{threshold:Number($('lab-old-threshold').value),ambiguityMargin:.05,modelId:OLD_ENGINE_ID});
    const item=document.createElement('div');item.className='lab-face-item';item.textContent=`旧方式の顔 ${index+1} · ${prediction.personId?`候補：${personName(prediction.personId)} (${prediction.score.toFixed(3)})`:'保留'}`;list.append(item);
  }
}

async function importPhotos(files){
  let first;
  await task('写真を読み込んでいます…',async signal=>{
    const selected=[...files].filter(f=>/\.(jpe?g|png)$/i.test(f.name));
    if(selected.length+state.samples.length>35)throw new Error('診断はまず35枚以内で行ってください。');
    for(let i=0;i<selected.length;i++){
      if(signal.aborted)break;const file=selected[i];let decoded;
      progress(i,selected.length,`${file.name} · 画像を端末内で確認中`);
      try{const hash=await fileHash(file);if(state.samples.some(s=>s.id===hash))continue;decoded=await decodeImage(file);
        const sample={id:hash,sourceGroup:`sha256:${hash}`,file,thumb:await thumb(decoded.canvas),role:'test',reviewed:false,truths:[]};state.samples.push(sample);first||=sample.id;
      }finally{decoded?.close();}
      await waitFrame();
    }
    invalidate();renderList();status('読み込みました。参照用と評価用を分けて、各写真の正解を確認してください。');
  });
  if(!state.current&&first)await showPhoto(first);
}

function validateSplit(){
  const references=state.samples.filter(s=>s.role==='reference'),tests=state.samples.filter(s=>s.role==='test');
  if(!references.length||!tests.length)throw new Error('参照用と評価用をそれぞれ1枚以上指定してください。');
  const groups=new Set(references.map(s=>s.sourceGroup));
  if(tests.some(s=>groups.has(s.sourceGroup)))throw new Error('同じ写真グループが参照用と評価用に入っています。別の写真へ分けてください。');
  if(state.samples.some(s=>!s.reviewed))throw new Error('各写真の「写っている顔をすべて確認した」にチェックしてください。見落としも手動で追加します。');
  if(!state.profiles.length)throw new Error('参照用の写真に、少なくとも1人の名前を付けてください。');
  const referencePeople=new Set(references.flatMap(sample=>sample.truths.map(t=>t.label)));
  const missing=state.profiles.filter(person=>!referencePeople.has(person.id));
  if(missing.length)throw new Error(`${missing.map(person=>person.name).join('・')}の参照用写真を指定してください。登録対象でない人物は「他の人」で正解を付けます。`);
}

async function compare(){
  try{validateSplit();}catch(error){status(error.message,true);return;}
  await task('新旧方式を比較しています…',async signal=>{
    await loadEngine(text=>status(text));
    for(let i=0;i<state.samples.length;i++){
      const sample=state.samples[i];if(signal.aborted)throw new DOMException('中止','AbortError');
      let decoded;progress(i,state.samples.length,`${i+1}/${state.samples.length} · ${sample.file.name}`);
      try{
        decoded=await decodeImage(sample.file);await ensureNew(sample,decoded.canvas,signal);await ensureOld(sample,decoded.canvas,signal);
        if(sample.role==='reference')for(const truth of sample.truths){
          if(truth.label.startsWith('__'))continue;
          if(truth.newDescriptorEngineId!==ENGINE_ID){delete truth.newDescriptor;try{const face=await extractRegion(decoded.canvas,truth.box,{signal});truth.newDescriptor=Float32Array.from(face.descriptor);truth.newDescriptorEngineId=ENGINE_ID;}catch(error){if(error.name==='AbortError')throw error;truth.newError=error.message;}}
          if(truth.oldDescriptorEngineId!==OLD_ENGINE_ID){delete truth.oldDescriptor;try{const face=await extractLegacy(decoded.canvas,truth.box);truth.oldDescriptor=Float32Array.from(face.descriptor);truth.oldDescriptorEngineId=OLD_ENGINE_ID;}catch(error){truth.oldError=error.message;}}
        }
      }finally{decoded?.close();}
      await waitFrame();
    }
    const oldThreshold=Number($('lab-old-threshold').value),newThreshold=Number($('lab-new-threshold').value);
    if(!Number.isFinite(oldThreshold)||oldThreshold<=0||oldThreshold>2||!Number.isFinite(newThreshold)||newThreshold< -1||newThreshold>1)throw new Error('比較のしきい値を正しく指定してください。');
    state.result=evaluateEngines(state.samples,state.profiles,{oldThreshold,newThreshold,ambiguityMargin:.05});
    renderResults();await renderFaceDetails();status('比較を完了しました。検出漏れ、誤混入、取りこぼしを別々に確認してください。少数枚の結果だけで実用精度を保証しません。');$('lab-progress').value=100;
  });
}

function renderResults(){
  const result=state.result;if(!result)return;
  const row=(title,key,format=value=>value)=>`<tr><th>${title}</th><td>${format(result.old.metrics[key])}</td><td>${format(result.new.metrics[key])}</td></tr>`;
  $('lab-results').innerHTML=`<p class="lab-warning">参照 ${result.referencePhotos}枚 / 評価 ${result.testPhotos}枚。これはこの標本での観測値です。大量の写真や別の撮影条件で同じ精度を保証するものではありません。</p><table class="lab-results-table"><thead><tr><th>評価用写真だけで集計</th><th>旧方式</th><th>新方式（試験）</th></tr></thead><tbody>${row('対象人物の顔の数','targetFaces')}${row('見つけた対象顔','detectedTargetFaces')}${row('検出漏れ','missedDetections')}${row('正しい人物判定','correctKnownFaces')}${row('採用した人物判定','acceptedPredictions')}${row('誤った人物判定','wrongPredictions')}${row('採用判定の正解率','precision',percent)}${row('対象顔の拾い上げ率','recall',percent)}${row('顔の検出率','detectionRecall',percent)}${row('人物判定の保留数','rejectedFaces')}${row('判別不能で除いた検出顔','excludedUncertainFaces')}${row('フォルダ評価から除いた写真','excludedUncertainPhotos')}</tbody></table><h3>人物別フォルダにした場合</h3><table class="lab-results-table"><thead><tr><th>人物</th><th>旧：出力 / 誤混入 / 取りこぼし</th><th>新：出力 / 誤混入 / 取りこぼし</th></tr></thead><tbody>${state.profiles.map(person=>{const old=result.old.byPerson[person.id],next=result.new.byPerson[person.id];return `<tr><th>${esc(person.name)}</th><td>${old?.exportedPhotos??0} / ${old?.wrongFolderPhotos??0} / ${old?.missedPhotos??0}</td><td>${next?.exportedPhotos??0} / ${next?.wrongFolderPhotos??0} / ${next?.missedPhotos??0}</td></tr>`;}).join('')}</tbody></table>${result.warnings.map(w=>`<p class="lab-warning">${esc(w.message)}</p>`).join('')}<p class="lab-model-info">新方式 ${esc(ENGINE_ID)}<br>旧方式 ${esc(OLD_ENGINE_ID)}<br>同じ次元でも新旧の特徴量を混ぜず、参照写真からそれぞれ抽出しています。</p>`;
  controls();
}

$('lab-files').addEventListener('change',async event=>{const files=[...event.target.files];event.target.value='';await importPhotos(files);});
$('lab-list').addEventListener('click',event=>{const button=event.target.closest('[data-sample-id]');if(button)void showPhoto(button.dataset.sampleId);});
$('lab-role').addEventListener('change',()=>{const sample=current();if(sample){sample.role=$('lab-role').value;invalidate();renderList();}});
$('lab-group').addEventListener('change',()=>{const sample=current();if(sample){sample.sourceGroup=$('lab-group').value.trim()||`sha256:${sample.id}`;$('lab-group').value=sample.sourceGroup;invalidate();}});
$('lab-reviewed').addEventListener('change',()=>{const sample=current();if(sample){sample.reviewed=$('lab-reviewed').checked;invalidate();renderList();}});
$('lab-box-mode').addEventListener('change',async()=>{const sample=current();if(!sample)return;if($('lab-box-mode').value==='old'&&!sample.oldFaces)await task('旧方式の枠を確認しています…',signal=>ensureOld(sample,state.decoded.canvas,signal));mountEditor();await renderFaceDetails();});
$('lab-truth-list').addEventListener('click',event=>{const button=event.target.closest('[data-remove-truth]');const sample=current();if(button&&sample&&!state.busy){sample.truths=sample.truths.filter(t=>t.id!==button.dataset.removeTruth);sample.reviewed=false;prunePeople();state.editor?.setProfiles(names(),state.activePerson);invalidate();renderTruths();renderList();if($('lab-box-mode').value==='truth')mountEditor();}});
$('lab-run').addEventListener('click',compare);
$('lab-cancel').addEventListener('click',()=>state.controller?.abort());
$('lab-clear').addEventListener('click',()=>{if(state.busy)return;state.editor?.destroy();state.decoded?.close();for(const url of [...urls])release(url);Object.assign(state,{samples:[],profiles:[],current:null,decoded:null,editor:null,result:null,activePerson:null});cropURLs=[];cropGeneration++;$('lab-current').hidden=true;$('lab-placeholder').hidden=false;renderList();invalidate();status('このタブの写真と正解ラベルを消去しました。');});
for(const id of ['lab-old-threshold','lab-new-threshold'])$(id).addEventListener('change',()=>invalidate());
$('lab-export').addEventListener('click',()=>{if(!state.result)return;const aggregate=anonymizeResults(state.result);aggregate.modelIds={old:OLD_ENGINE_ID,new:ENGINE_ID};const url=objectURL(new Blob([JSON.stringify(aggregate,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='PhotoSorter-顔認識比較-集計.json';link.click();setTimeout(()=>release(url),60000);});
renderList();
