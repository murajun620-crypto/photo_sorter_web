import {decodeImage, faceDistance, blurScore, compressToTarget} from './imaging.js?v=1.1.0';
import {collectPhotos, verifyUnchanged, validatedOutputParts, exportRecords, quarantineRecords, restoreQuarantine} from './filesystem.js?v=1.1.0';
import {photoDate, localDate, validDate, safeName, validateEvent, eventForDate, classifyPhoto, outputPlan} from './organize.js?v=1.1.0';
import {createThumbnailQueue} from './thumbnails.js?v=1.1.0';
import {CURRENT_VERSION, installUpdates} from './updates.js?v=1.1.0';
import {mountFaceEditor} from './face-editor.js?v=1.1.0';
import {ENGINE_ID,loadModels,detectFaces,descriptorFromRegion,migrateSnapshot,mergeRegisteredFaces} from './recognition.js?v=1.1.0';
import {deriveCalibrations,reviewBlur} from './blur-calibration.js?v=1.1.0';
import {collectFeedbackCandidates,applyFaceFeedback,recomputeFaceDistances} from './feedback.js?v=1.1.0';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const uid = () => crypto.randomUUID();
const size = bytes => bytes >= 1e6 ? `${(bytes/1e6).toFixed(2)} MB` : `${Math.round(bytes/1000)} KB`;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const EVENT_KEY = `photo-sorter-events-v1:${location.pathname}`;
const state = {profiles:[], activePerson:null, events:[], records:[], source:null, sourceName:'', filter:'all', page:0, busy:false, controller:null, analyzedMode:null,pickFacePhoto:false};
const perPage = 48;
let toastTimer;
let dialogResolve;
let updatingApp = false;
let blurCalibrations=new Map();
const imageBlobs = new Map();
const thumbnails = createThumbnailQueue({
  getRecords:()=>state.records,
  getVisibleRecords:visible,
  isPaused:()=>state.busy,
  async makeThumbnail(record){
    let decoded;
    try{
      const file=record.handle?await verifyUnchanged(record):record.file;
      decoded=await decodeImage(file);
      const url=await canvasURL(decoded.canvas);
      return {url,blob:imageBlobs.get(url)};
    }finally{decoded?.close();}
  },
  publish(record,{url,blob}){record.thumbnail=url;record.thumbnailBlob=blob;delete record.thumbnailError;patchThumbnail(record);},
  onError(record,error){record.thumbnailError=error.message||'プレビューを表示できません';patchThumbnail(record);},
  revoke:releaseImageURL,
});

function imageURL(blob){const url=URL.createObjectURL(blob);imageBlobs.set(url,blob);return url;}
function releaseImageURL(url){if(url){URL.revokeObjectURL(url);imageBlobs.delete(url);}}
function patchThumbnail(record){
  const button=$('gallery').querySelector(`[data-photo="${record.id}"]`);
  if(!button)return;
  if(record.thumbnail){const img=document.createElement('img');img.loading='lazy';img.src=record.thumbnail;img.alt=record.file.name;button.replaceChildren(img);}
  else{const label=document.createElement('span');label.className='thumbnail-placeholder';label.textContent='プレビュー不可';label.title=record.thumbnailError;button.replaceChildren(label);}
}

try {
  const saved = JSON.parse(localStorage.getItem(EVENT_KEY) || '[]');
  if (Array.isArray(saved) && saved.length <= 2000) {
    for (const event of saved) state.events.push(validateEvent({...event,id:uid()}, state.events));
  }
} catch { state.events = []; }

function notify(text, error=false) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').className = `toast${error ? ' error' : ''}`;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => $('toast').hidden = true, error ? 12000 : 6500);
}

function progress(done,total,text) {
  $('progress-detail').textContent = text || '';
  if (total) $('progress-bar').value = done / total * 100;
  else $('progress-bar').removeAttribute('value');
}

async function job(title, action) {
  if (state.busy) return;
  state.busy = true;
  state.controller = new AbortController();
  $('progress-title').textContent = title;
  progress(0,0,'');
  $('progress-dock').hidden = false;
  updateControls();
  try { await thumbnails.waitForIdle();return await action(state.controller.signal); }
  catch (error) { if (error.name !== 'AbortError') notify(error.message || String(error),true); }
  finally {
    state.busy = false;
    state.controller = null;
    $('progress-dock').hidden = true;
    updateControls();
    render();
  }
}

function options() {
  const maxDistance=Number($('distance').value), ambiguityMargin=Number($('ambiguity-margin').value);
  if (!Number.isFinite(maxDistance) || maxDistance<.1 || maxDistance>2) throw new Error('顔の距離しきい値は0.1〜2で入力してください。');
  if(!Number.isFinite(ambiguityMargin)||ambiguityMargin<0||ambiguityMargin>.3)throw new Error('候補の差は0〜0.3で入力してください。');
  return {useFaces:$('use-faces').checked,maxDistance,ambiguityMargin,blurThreshold:0,skipBlur:false,mode:$('export-mode').value};
}

function classifyRecords(){
  const opts=options();
  const base=state.records.map(record=>record.analyzed?classifyPhoto(record,state.profiles,opts):record);
  blurCalibrations=deriveCalibrations(base);
  const enabled=$('skip-blur').checked;
  state.records=base.map(record=>{
    if(!record.analyzed||record.error)return record;
    const quality=reviewBlur(record,blurCalibrations,{enabled});
    return {...record,...quality,faceNeedsReview:record.needsReview,needsReview:record.needsReview||quality.blurUncertain,
      selected:typeof record.manualSelected==='boolean'?record.manualSelected:record.selected&&!(enabled&&quality.blurry)};
  });
}

function compressionOptions() {
  let targetBytes = null;
  if ($('compress').checked) {
    targetBytes = Math.floor(Number($('target-size').value) * ($('target-unit').value === 'MB' ? 1e6 : 1000));
    if (!Number.isSafeInteger(targetBytes) || targetBytes<10000 || targetBytes>1e9) throw new Error('上限容量は10 KB〜1000 MBで指定してください。');
  }
  return {targetBytes,allowResize:$('allow-resize').checked};
}

function updateControls() {
  const pending = state.busy;
  for (const element of document.querySelectorAll('.sidebar button,.sidebar input,.sidebar select,.sidebar summary,.intro button,.source-bar button,.selection-actions button,.filters select,.tabs button,.export-panel button,.export-panel input,.export-panel select,.cleanup-row button')) {
    if ('disabled' in element) element.disabled=pending;
  }
  $('scan-button').disabled=pending||!state.records.length;
  $('add-reference').disabled=pending||!state.profiles.length;
  $('choose-face-photo').disabled=pending||!state.records.length;
  $('start-feedback').disabled=pending||!state.records.length||!state.profiles.some(p=>p.id===state.activePerson&&p.refs.length);
  $('enable-blur-calibration').disabled=pending||![...blurCalibrations.values()].some(c=>c.ready);
  for (const id of ['select-visible','clear-visible','reclassify']) $(id).disabled=pending||!state.records.some(r=>r.analyzed);
  const selected=state.records.some(r=>r.selected&&!r.error);
  $('export-folder').disabled=pending||!selected||!state.source||!window.showDirectoryPicker;
  $('export-zip').disabled=pending||!selected;
  $('quarantine').disabled=pending||!state.source||!state.records.some(r=>r.blurry);
  $('restore').disabled=pending||!state.source;
  $('cancel').disabled=!pending;
  $('check-update').disabled=pending;
}

function closeDialog(value=null) {
  $('dialog').close();
  if (dialogResolve) { const resolve=dialogResolve; dialogResolve=null; resolve(value); }
}

function dialog(content) {
  closeDialog();
  $('dialog-content').innerHTML=content;
  $('dialog').showModal();
  return new Promise(resolve=>dialogResolve=resolve);
}

const actions = (primary, extra='') => `<div class="dialog-actions">${extra}<button class="outline-button" type="button" data-close>閉じる</button>${primary || ''}</div>`;
$('dialog').addEventListener('cancel',()=>{ if(dialogResolve){const resolve=dialogResolve;dialogResolve=null;resolve(null);} });
$('dialog').addEventListener('click',event=>{if(event.target.closest('[data-close]'))closeDialog();});

function invalidateAnalysis() {
  for(const record of state.records){if(!record.featuresReady){record.analyzed=false;record.selected=false;record.faces=[];record.matchedIds=[];record.needsReview=false;}}
  recomputeFaceDistances(state.records,state.profiles);
  classifyRecords();
  state.filter='all';state.page=0;$('person-filter').value='';
  document.querySelectorAll('[data-filter]').forEach(button=>button.classList.toggle('active',button.dataset.filter==='all'));
  render();
}

async function editPerson(person=null) {
  if(state.busy)return;
  const result=dialog(`<form id="person-form"><div class="dialog-body"><h2>${person?'人物名を変更':'人物を追加'}</h2><p>出力フォルダの名前になります。お子さんやお友達を一人ずつ登録してください。</p><label class="dialog-field">名前<input id="person-name" maxlength="60" required value="${escape(person?.name||'')}" placeholder="例：はると"></label></div>${actions('<button class="primary-button" type="submit">保存</button>',person?'<button class="text-button danger" id="delete-person" type="button">この人物を外す</button>':'')}</form>`);
  $('person-form').onsubmit=event=>{
    event.preventDefault();
    const name=$('person-name').value.trim();
    if(!name)return;
    if(state.profiles.some(p=>p.id!==person?.id && safeName(p.name).toLocaleLowerCase()===safeName(name).toLocaleLowerCase()))return notify('フォルダ名が重複します。別の人物名にしてください。',true);
    if(person)person.name=name;
    else{const profile={id:uid(),name,engineId:ENGINE_ID,refs:[]};state.profiles.push(profile);state.activePerson=profile.id;invalidateAnalysis();}
    closeDialog(true);render();
  };
  if(person)$('delete-person').onclick=()=>{
    for(const ref of [...person.refs,...(person.pendingRefs||[])])releaseImageURL(ref.url);
    state.profiles=state.profiles.filter(p=>p.id!==person.id);
    if(state.activePerson===person.id)state.activePerson=state.profiles[0]?.id||null;
    invalidateAnalysis();closeDialog(true);
  };
  $('person-name').focus();
  return result;
}

function renderPeople() {
  $('people-list').innerHTML=state.profiles.length ? state.profiles.map(p=>`<div class="person ${p.id===state.activePerson?'active':''}" data-person="${p.id}" tabindex="0" role="button" aria-label="${escape(p.name)}を選択"><span class="avatar">${escape(p.name.slice(0,1))}</span><span class="person-label">${escape(p.name)}<small>顔写真 ${p.refs.length}枚${p.pendingRefs?.length?' · 更新後の再登録が必要':''}${p.refs.length<3?' · まず3〜5枚':''}${p.negatives?.length?` · NG ${p.negatives.length}件`:''}</small></span><button class="tiny-button" data-edit-person="${p.id}" aria-label="${escape(p.name)}の設定">⋯</button></div>`).join('') : '<p class="hint">写真を開き、写っている顔を選んで人物を登録できます。</p>';
  const active=state.profiles.find(p=>p.id===state.activePerson);
  $('add-reference').textContent=active?`${active.name}：別の写真から追加`:'別の写真ファイルから追加';
  $('reference-list').innerHTML=(active?.pendingRefs?.length?'<p class="hint">旧方式の登録例です。元の写真を開いて顔を登録し直してください。</p>'+active.pendingRefs.filter(ref=>ref.url).map(ref=>`<div class="reference pending-reference"><img src="${ref.url}" alt="旧方式の登録例・再登録が必要"></div>`).join(''):'')+(active?.refs||[]).map((ref,i)=>`<div class="reference"><img src="${ref.url}" alt="登録した顔 ${i+1}"><button data-remove-ref="${i}" aria-label="顔写真${i+1}を外す">×</button></div>`).join('');
  const filter=$('person-filter').value;
  $('person-filter').innerHTML='<option value="">すべての人物</option>'+state.profiles.map(p=>`<option value="${p.id}">${escape(p.name)}</option>`).join('');
  $('person-filter').value=state.profiles.some(p=>p.id===filter)?filter:'';
}

async function canvasURL(canvas,width=280,height=200,crop=null) {
  const output=document.createElement('canvas');
  const sw=crop?.width||canvas.width,sh=crop?.height||canvas.height;
  const scale=Math.min(width/sw,height/sh,1);
  output.width=Math.max(1,Math.round(sw*scale));output.height=Math.max(1,Math.round(sh*scale));
  output.getContext('2d').drawImage(canvas,crop?.x||0,crop?.y||0,sw,sh,0,0,output.width,output.height);
  const blob=await new Promise(resolve=>output.toBlob(resolve,'image/jpeg',.82));
  output.width=output.height=1;
  if(!blob)throw new Error('サムネイルを作成できません。');
  return imageURL(blob);
}

async function addReferences(files) {
  const person=state.profiles.find(p=>p.id===state.activePerson);
  if(!person)return;
  if(files.length>20)return notify('一度に追加できるのは20枚までです。',true);
  await job('顔写真を登録',async signal=>{
    await loadModels(text=>progress(0,0,text));
    let added=0;
    for(const file of files){
      if(signal.aborted)break;
      let decoded;const urls=[];
      try{
        progress(0,0,file.name);
        decoded=await decodeImage(file);
        const faces=await detectFaces(decoded.canvas,{signal,onProgress:progress});
        if(signal.aborted)break;
        if(!faces.length){notify(`${file.name}: 顔が見つかりません。顔が大きく写った写真を選んでください。`,true);continue;}
        for(const face of faces)urls.push(await canvasURL(decoded.canvas,150,150,face.box));
        if(signal.aborted)break;
        const answer=dialog(`<div class="dialog-body"><h2>${escape(person.name)}の顔を選んでください</h2><p>${escape(file.name)} · 集合写真からも指定できます。</p><div class="face-grid">${urls.map((url,i)=>`<button class="face-option" data-face="${i}"><img src="${url}" alt="検出した顔 ${i+1}"><span>この顔を登録</span></button>`).join('')}</div></div>${actions('')}`);
        for(const button of $('dialog').querySelectorAll('[data-face]'))button.onclick=()=>closeDialog(Number(button.dataset.face));
        const chosen=await answer;
        if(chosen!==null&&!signal.aborted){
          const url=await canvasURL(decoded.canvas,80,80,faces[chosen].box);
          person.refs.push({descriptor:faces[chosen].descriptor,engineId:ENGINE_ID,url});for(const ref of person.pendingRefs||[])releaseImageURL(ref.url);person.pendingRefs=[];added++;
          renderPeople();
        }
      }catch(error){notify(`${file.name}: ${error.message}`,true);}
      finally{decoded?.close();urls.forEach(releaseImageURL);}
    }
    if(added){invalidateAnalysis();notify(`${person.name}の顔写真を${added}枚追加しました。`);}
  });
}

async function registerPeopleFromPhoto(record){
  if(state.busy)return;
  state.pickFacePhoto=false;
  render();
  await job('写真から人物を登録',async signal=>{
    let decoded,editor,detection,finish;
    let active=true,added=0;
    const editorDialog=$('face-editor-dialog');
    const abortError=()=>new DOMException('登録を中止しました。','AbortError');
    const closed=new Promise(resolve=>finish=()=>{if(!active)return;active=false;if(editorDialog.open)editorDialog.close();resolve();});
    const cancel=event=>{event.preventDefault();finish();};
    const profileOptions=()=>state.profiles.map(({id,name})=>({id,name}));
    signal.addEventListener('abort',finish);
    editorDialog.addEventListener('cancel',cancel);
    editorDialog.addEventListener('close',finish);
    try{
      await loadModels(text=>progress(0,0,text));
      if(signal.aborted)return;
      const file=record.handle?await verifyUnchanged(record):record.file;
      decoded=await decodeImage(file);
      if(signal.aborted)return;
      editor=mountFaceEditor({container:$('face-editor-content'),canvas:decoded.canvas,faces:[],profiles:profileOptions(),activePersonId:state.activePerson,
        onClose:finish,onError:error=>notify(error?.message||String(error),true),
        async onRegister({personId,name,face,region}){
          if(!active||signal.aborted)throw abortError();
          let person=personId?state.profiles.find(p=>p.id===personId):null;
          if(personId&&!person)throw new Error('登録先の人物を選び直してください。');
          const newName=String(name||'').trim().slice(0,60);
          if(!person){
            if(!newName)throw new Error('新しい人物の名前を入力してください。');
            if(state.profiles.some(p=>safeName(p.name).toLocaleLowerCase()===safeName(newName).toLocaleLowerCase()))throw new Error('同じ名前の人物が登録済みです。登録先からその人物を選んでください。');
          }
          const selected=face?.descriptor?face:await descriptorFromRegion(decoded.canvas,region,{signal});
          if(!active||signal.aborted)throw abortError();
          const distance=person?faceDistance([selected.descriptor],person.refs.map(ref=>ref.descriptor)):null;
          if(distance!==null&&distance<1e-6)return {profiles:profileOptions(),personId:person.id,message:'この顔はすでに登録されています。別の顔を選んでください。'};
          const url=await canvasURL(decoded.canvas,80,80,selected.box);
          if(!active||signal.aborted){releaseImageURL(url);throw abortError();}
          if(!person){person={id:uid(),name:newName,engineId:ENGINE_ID,refs:[]};state.profiles.push(person);}
          person.refs.push({descriptor:Float32Array.from(selected.descriptor),engineId:ENGINE_ID,url,sourceRecordId:record.id,box:{...selected.box}});
          for(const ref of person.pendingRefs||[])releaseImageURL(ref.url);person.pendingRefs=[];
          const live=state.records.find(r=>r.id===record.id);
          if(live){
            const registered={id:uid(),box:{...selected.box},landmarks:selected.landmarks,descriptor:Float32Array.from(selected.descriptor),engineId:ENGINE_ID,feedback:{[person.id]:'ok'}};
            live.registeredFaces=mergeRegisteredFaces([], [...(live.registeredFaces||[]),registered]);
            if(live.facesDetected){live.faces=mergeRegisteredFaces(live.faces,live.registeredFaces).map(f=>({...f,blur:blurScore(decoded.canvas,[f.box])}));live.engineId=ENGINE_ID;}
          }
          state.activePerson=person.id;added++;
          invalidateAnalysis();
          return {profiles:profileOptions(),personId:person.id,message:`${person.name}に顔写真を登録しました。次の顔も続けて登録できます。`};
        },
      });
      editor.setStatus('顔を検出しています。見つからない顔は「顔を囲んで指定」で選べます。');
      editorDialog.showModal();
      progress(0,0,record.relative);
      detection=detectFaces(decoded.canvas,{signal,onProgress:progress}).then(faces=>{
        if(active){editor.setFaces(faces);editor.setStatus(faces.length?`${faces.length}人の顔が見つかりました。枠を選び、登録先を指定してください。`:'顔が見つかりませんでした。「顔を囲んで指定」で1人の顔を囲んでください。');}
      }).catch(error=>{if(active)editor.setStatus(error.message,true);});
      await closed;
    }finally{
      active=false;
      if(editorDialog.open)editorDialog.close();
      signal.removeEventListener('abort',finish);
      editorDialog.removeEventListener('cancel',cancel);
      editorDialog.removeEventListener('close',finish);
      await detection;
      editor?.destroy();decoded?.close();$('face-editor-content').replaceChildren();
    }
    if(added)notify(`${added}件の顔を登録しました。「写真を解析」で人物を選別できます。`);
  });
}

function saveEvents(){
  try{localStorage.setItem(EVENT_KEY,JSON.stringify(state.events));}
  catch{notify('イベントの自動保存ができません。設定を書き出してください。',true);}
}

async function editEvent(event=null,date='') {
  if(state.busy)return;
  const start=event?.start||date||state.records.find(r=>validDate(r.date))?.date||localDate(new Date());
  dialog(`<form id="event-form"><div class="dialog-body"><h2>${event?'イベントを編集':'イベントを登録'}</h2><p>1日なら開始日と終了日を同じ日に。旅行は期間を指定すると、日付をまたいでひとつにまとめられます。</p><label class="dialog-field">イベント名<input id="event-name" maxlength="60" required placeholder="例：北海道旅行" value="${escape(event?.name||'')}"></label><div class="date-pair"><label class="dialog-field">開始日<input id="event-start" type="date" required value="${start}"></label><label class="dialog-field">終了日<input id="event-end" type="date" required value="${event?.end||start}"></label></div></div>${actions('<button class="primary-button" type="submit">イベントを保存</button>',event?'<button id="delete-event" class="text-button danger" type="button">イベントを解除</button>':'')}</form>`);
  $('event-form').onsubmit=e=>{
    e.preventDefault();
    try{
      const next=validateEvent({id:event?.id||uid(),name:$('event-name').value,start:$('event-start').value,end:$('event-end').value},state.events);
      state.events=state.events.filter(v=>v.id!==next.id).concat(next).sort((a,b)=>a.start.localeCompare(b.start));
      saveEvents();closeDialog();render();
    }catch(error){notify(error.message,true);}
  };
  if(event)$('delete-event').onclick=()=>{state.events=state.events.filter(v=>v.id!==event.id);saveEvents();closeDialog();render();};
  $('event-name').focus();
}

function renderDates() {
  $('event-list').innerHTML=state.events.map(event=>`<div class="event-chip"><div>${escape(event.name)}<small>${event.start}${event.end!==event.start?` → ${event.end}`:''}</small></div><button data-event="${event.id}" aria-label="${escape(event.name)}を編集">✎</button></div>`).join('');
  const dates=new Map();
  for(const record of state.records)dates.set(record.date,(dates.get(record.date)||0)+1);
  const days=[...dates.keys()].sort();
  $('day-list').innerHTML=days.length?days.map(date=>`<div class="day-row"><button data-day-filter="${escape(date)}">${escape(date)} <span>(${dates.get(date)}枚)</span></button><button class="tiny-button" data-day-event="${escape(date)}">${escape(eventForDate(date,state.events)?.name||'＋ 名前を付ける')}</button></div>`).join(''):'<span class="muted">写真を読み込むと日付が並びます</span>';
  const current=$('date-filter').value;
  $('date-filter').innerHTML='<option value="">すべての日付</option>'+days.map(date=>`<option>${escape(date)}</option>`).join('');
  $('date-filter').value=days.includes(current)?current:'';
  $('day-count').textContent=dates.size;
}

function clearRecords(){thumbnails.reset();state.records.forEach(record=>releaseImageURL(record.thumbnail));state.records=[];state.page=0;state.analyzedMode=null;state.pickFacePhoto=false;blurCalibrations=new Map();$('skip-blur').checked=false;}

async function loadSource(){
  if(state.busy)return;
  if(!window.showDirectoryPicker){$('source-files').click();return;}
  let handle;
  try{handle=await window.showDirectoryPicker({id:'photosorter-source',mode:'read'});}
  catch(error){if(error.name!=='AbortError')notify('フォルダを開けません。「ファイル選択で開く」も利用できます。',true);return;}
  await job('写真フォルダを読み込み',async signal=>{
    const records=await collectPhotos(handle,{signal,onProgress:progress});
    clearRecords();state.source=handle;state.sourceName=handle.name;
    state.records=records.map(r=>({...r,date:localDate(r.file.lastModified),dateSource:'ファイル更新日（解析前）',selected:false,analyzed:false,faces:[],distances:{},matchedIds:[]}));
    notify(`${records.length}枚を読み込みました。「写真を解析」で撮影日と人物を確認できます。`);
  });
}

async function loadFallback(files){
  clearRecords();state.source=null;
  const supported=[...files].filter(file=>/\.(jpe?g|png)$/i.test(file.name)&&!file.webkitRelativePath.split('/').some(p=>p==='_PhotoSorter_退避'||p==='_PhotoSorter_出力'));
  state.sourceName=supported[0]?.webkitRelativePath.split('/')[0]||'選択した写真';
  state.records=supported.map(file=>{
    const parts=file.webkitRelativePath?file.webkitRelativePath.split('/').slice(1):[file.name];
    return {id:uid(),file,parts,relative:parts.join('/'),signature:{size:file.size,lastModified:file.lastModified},date:localDate(file.lastModified),dateSource:'ファイル更新日（解析前）',selected:false,analyzed:false,faces:[],distances:{},matchedIds:[]};
  }).sort((a,b)=>a.relative.localeCompare(b.relative,'ja'));
  render();
  notify(`${state.records.length}枚を読み込みました。出力はZIPで保存できます。`);
}

async function scan({trial=false,onlyIds=null}={}){
  let opts;
  try{
    opts=options();
    if(opts.useFaces&&(!state.profiles.length||!trial&&state.profiles.some(p=>!p.refs.length)))throw new Error('人物ごとに顔写真を1枚以上登録してください。人物で絞らない場合はチェックを外してください。');
  }catch(error){return notify(error.message,true);}
  await job(trial?'12枚を試し判定しています':'写真を解析しています',async signal=>{
    const pending=state.records.filter(record=>!record.error&&(!record.analyzed||!record.featuresReady||opts.useFaces&&!record.facesDetected));
    const samples=trial?Array.from({length:Math.min(12,pending.length)},(_,i)=>pending[Math.floor(i*pending.length/Math.min(12,pending.length))]):onlyIds?state.records.filter(r=>onlyIds.includes(r.id)):state.records;
    if(!trial)for(const record of samples){record.selected=false;record.analyzed=false;record.error=null;record.blurry=false;record.matchedIds=[];record.needsReview=false;}
    if(opts.useFaces)await loadModels(text=>progress(0,0,text));
    state.analyzedMode=opts.useFaces;
    for(let i=0;i<samples.length;i++){
      if(signal.aborted)break;
      let record=state.records.find(r=>r.id===samples[i].id),decoded;
      record.selected=false;record.error=null;
      try{
        const file=record.handle?await verifyUnchanged(record):record.file;
        if(record.featuresReady&&(!opts.useFaces||record.facesDetected&&record.engineId===ENGINE_ID)){
          record.analyzed=true;recomputeFaceDistances([record],state.profiles);progress(i+1,samples.length,record.relative);await tick();continue;
        }
        decoded=await decodeImage(file);
        if(!record.thumbnail){record.thumbnail=await canvasURL(decoded.canvas);record.thumbnailBlob=imageBlobs.get(record.thumbnail);}
        delete record.thumbnailError;
        if(!record.manualDate)Object.assign(record,await photoDate(file));
        record.width=decoded.width;record.height=decoded.height;
        const faces=opts.useFaces?mergeRegisteredFaces(await detectFaces(decoded.canvas,{signal,onProgress:progress}),record.registeredFaces||[]):[];
        record.faces=faces.map(face=>({...face,engineId:ENGINE_ID,descriptor:Float32Array.from(face.descriptor),blur:blurScore(decoded.canvas,[face.box])}));
        record.fullBlur=blurScore(decoded.canvas);record.analyzed=true;record.featuresReady=true;record.facesDetected=opts.useFaces;record.engineId=ENGINE_ID;
        recomputeFaceDistances([record],state.profiles);
      }catch(error){if(error.name==='AbortError'){record.analyzed=false;record.selected=false;break;}record.error=error.message;record.analyzed=true;record.selected=false;record.blurry=false;}
      finally{decoded?.close();}
      progress(i+1,samples.length,record.relative);
      if(i%5===0){classifyRecords();renderGallery();}
      await tick();
    }
    classifyRecords();
    notify(signal.aborted?'解析を中止しました。完了した写真は確認できます。':'解析が終わりました。人物とボケ候補を確認してください。');
  });
}

function reclassify(quiet=false){
  try{
    const opts=options();
    if(state.analyzedMode!==null&&opts.useFaces!==state.analyzedMode)throw new Error('人物で絞り込む設定が変わりました。もう一度「写真を解析」してください。');
    if(!quiet)for(const record of state.records)delete record.manualSelected;
    classifyRecords();
    render();if(!quiet)notify('現在の設定で出力対象を選び直しました。');
  }catch(error){notify(error.message,true);}
}

async function refreshFeedbackScores(){
  for(let i=0;i<state.records.length;i+=100){recomputeFaceDistances(state.records.slice(i,i+100),state.profiles);await tick();}
  classifyRecords();
}

async function startFaceFeedback(){
  const person=state.profiles.find(p=>p.id===state.activePerson);
  if(state.busy||!person?.refs.length)return;
  if(!$('use-faces').checked){$('use-faces').checked=true;state.analyzedMode=null;}
  const feedbackOptions={...options(),reviewAnswered:$('review-feedback-answers').checked};
  let candidates=collectFeedbackCandidates(state.records,person,feedbackOptions);
  if(!candidates.length&&!feedbackOptions.reviewAnswered&&state.records.some(r=>!r.error&&(!r.analyzed||!r.featuresReady||!r.facesDetected))){
    await scan({trial:true});
    candidates=collectFeedbackCandidates(state.records,person,feedbackOptions);
  }
  if(!candidates.length)return notify('確認できる顔の候補がありません。別の写真を試し判定するか、顔を囲んで登録してください。');
  await job(`${person.name}のOK／NG調整`,async signal=>{
    const skipped=new Set();let ok=0,ng=0;
    for(let step=0;step<12&&!signal.aborted;step++){
      const candidate=collectFeedbackCandidates(state.records,person,{...feedbackOptions,limit:Math.max(20,state.records.length*5)}).find(c=>!skipped.has(c.key));
      if(!candidate)break;
      const record=state.records.find(r=>r.id===candidate.recordId),face=record.faces[candidate.faceIndex];
      let decoded;const urls=[];
      try{
        const file=record.handle?await verifyUnchanged(record):record.file;
        decoded=await decodeImage(file);
        const cropURL=await canvasURL(decoded.canvas,220,220,face.box);urls.push(cropURL);
        const display=document.createElement('canvas');
        const scale=Math.min(1,850/decoded.width,380/decoded.height);
        display.width=Math.max(1,Math.round(decoded.width*scale));display.height=Math.max(1,Math.round(decoded.height*scale));
        const context=display.getContext('2d');context.drawImage(decoded.canvas,0,0,display.width,display.height);
        context.strokeStyle='#db782a';context.lineWidth=4;context.strokeRect(face.box.x*scale,face.box.y*scale,face.box.width*scale,face.box.height*scale);
        const sceneURL=await canvasURL(display,850,380);urls.push(sceneURL);display.width=display.height=1;
        const answer=dialog(`<div class="dialog-body feedback-question" data-relative="${escape(record.relative)}"><h2>この顔は ${escape(person.name)} さんですか？</h2><p>${step+1} / 最大12件 · 集合写真ではオレンジの枠の顔だけを確認します。</p><img class="feedback-scene" src="${sceneURL}" alt="対象の顔を四角で示した写真"><div class="feedback-face-row"><img src="${cropURL}" alt="確認する顔"><div><strong>${escape(person.name)}</strong><p>${escape(record.relative)}</p><p>OKは本人の追加例、NGはこの人ではない例として、解析済みの写真へ反映します。残りにも全体解析で適用します。</p></div></div></div><div class="dialog-actions"><button type="button" class="outline-button" data-close>終了</button><button type="button" class="outline-button" id="feedback-skip">わからない・次へ</button><button type="button" class="outline-button danger" id="feedback-ng">NG・別人</button><button type="button" class="primary-button" id="feedback-ok">OK・本人</button></div>`);
        $('feedback-ok').onclick=()=>closeDialog('ok');$('feedback-ng').onclick=()=>closeDialog('ng');$('feedback-skip').onclick=()=>closeDialog('skip');
        const decision=await answer;
        if(decision===null||signal.aborted)break;
        if(decision==='skip'){skipped.add(candidate.key);continue;}
        await correctFace(record.id,candidate.faceIndex,person.id,decision,decoded.canvas);
        if(decision==='ok')ok++;else ng++;
        skipped.add(candidate.key);
        progress(step+1,12,'判定を全体に反映しています…');
        render();
      }catch(error){notify(error.message,true);skipped.add(candidate.key);}
      finally{decoded?.close();urls.forEach(releaseImageURL);}
    }
    notify(`OK ${ok}件 / NG ${ng}件を反映しました。もう一度「OK／NGで判定を調整」で続きを確認できます。`);
  });
}

function filtered(){
  return state.records.filter(r=>(state.filter==='all'||state.filter==='selected'&&r.selected||state.filter==='review'&&r.needsReview||state.filter==='blur'&&r.blurry||state.filter==='error'&&r.error)
    &&(!$('person-filter').value||r.matchedIds?.includes($('person-filter').value))&&(!$('date-filter').value||r.date===$('date-filter').value));
}

function visible(){return filtered().slice(state.page*perPage,(state.page+1)*perPage);}

function reviewNote(record){
  const reasons={'no-face':'顔を検出できず','ambiguous':'人物候補が近い','near':'しきい値付近の人物候補','feedback':'NGの例にも近い顔'};
  return reasons[record.reviewReason]||(record.blurUncertain?'ボケの基準が未調整':'');
}

function renderCard(record){
  const people=state.profiles.filter(p=>record.matchedIds?.includes(p.id));
  const candidates=state.profiles.filter(p=>record.reviewIds?.includes(p.id)&&!record.matchedIds?.includes(p.id));
  const tags=record.error?'<span class="person-tag neutral">読み込みエラー</span>':!record.analyzed?'<span class="person-tag neutral">未解析</span>':people.map(p=>`<span class="person-tag">${escape(p.name)}</span>`).join('')+candidates.map(p=>`<span class="person-tag candidate">候補：${escape(p.name)}</span>`).join('')||`<span class="person-tag neutral">${state.analyzedMode?'人物未分類':'日付で整理'}</span>`;
  return `<article class="photo-card ${record.selected?'selected':''}"><button class="photo-image" data-photo="${record.id}" aria-label="${escape(record.relative)}を確認">${record.thumbnail?`<img loading="lazy" src="${record.thumbnail}" alt="${escape(record.file.name)}">`:`<span class="thumbnail-placeholder" title="${escape(record.thumbnailError||'')}">${record.error?'読み込みエラー':record.thumbnailError?'プレビュー不可':'プレビュー準備中'}</span>`}</button><label class="card-checkbox"><input type="checkbox" data-select="${record.id}" ${record.selected?'checked':''} ${state.busy||!record.analyzed||record.error?'disabled':''} aria-label="${escape(record.relative)}を出力対象に"></label><div class="card-flags">${record.needsReview?'<span class="review-badge">要確認</span>':''}${record.blurry?'<span class="blur-badge">ボケ候補</span>':''}</div><div class="card-info"><div class="card-name" title="${escape(record.relative)}">${escape(record.file.name)}</div><div class="card-meta"><span>${escape(record.date)}</span><span>${size(record.file.size)}</span></div><div class="card-people">${tags}</div>${record.needsReview?`<small class="card-review-note">${escape(reviewNote(record))}</small>`:''}</div></article>`;
}

function renderGallery(){
  const filteredRecords=filtered();
  state.page=Math.min(state.page,Math.max(0,Math.ceil(filteredRecords.length/perPage)-1));
  const records=visible();
  $('gallery').innerHTML=records.map(renderCard).join('');
  $('empty-state').hidden=!!state.records.length;
  $('pagination').hidden=filteredRecords.length<=perPage;
  $('page-label').textContent=`${state.page+1} / ${Math.max(1,Math.ceil(filteredRecords.length/perPage))}`;
  $('prev-page').disabled=state.page===0;
  $('next-page').disabled=(state.page+1)*perPage>=filteredRecords.length;
  $('result-caption').textContent=state.records.length?`${filteredRecords.length}枚を表示 · 要確認 ${state.records.filter(r=>r.needsReview).length}枚`:'解析した写真をここで確認できます';
  $('total-count').textContent=state.records.length;
  $('selected-count').textContent=state.records.filter(r=>r.selected).length;
  $('blur-count').textContent=state.records.filter(r=>r.blurry).length;
  updateControls();
  thumbnails.refresh();
}

function render(){
  renderPeople();renderDates();renderGallery();
  $('source-name').textContent=state.sourceName||'フォルダが選択されていません';
  $('source-meta').textContent=state.records.length?`${state.records.length}枚 · ${size(state.records.reduce((sum,r)=>sum+r.file.size,0))} · ${state.source?'ローカルフォルダに接続中':'ZIP出力モード'}`:'サブフォルダの写真もまとめて整理できます';
  $('folder-preview').textContent=$('export-mode').value==='people'&&$('use-faces').checked?'人物名 / イベントの期間と名前 / 日付 / 写真':'イベントの期間と名前 / 日付 / 写真';
  $('browser-note').hidden=!!window.showDirectoryPicker&&(!!state.source||!state.records.length);
  $('browser-note').textContent='この読み込み方法ではZIPで保存できます。フォルダへの直接出力・元写真の退避には、Chrome / Edgeで「写真フォルダを開く」を使ってください。';
  $('face-photo-notice').hidden=!state.pickFacePhoto;
  const calibrationList=[...blurCalibrations.values()];
  const ready=calibrationList.filter(c=>c.ready).length,overlap=calibrationList.filter(c=>c.reason==='overlap').length;
  $('blur-calibration-status').textContent=`鮮明な例 ${state.records.filter(r=>r.blurLabel==='sharp').length}枚 / ボケた例 ${state.records.filter(r=>r.blurLabel==='blur').length}枚。調整済み ${ready}組${overlap?` / 分離できない ${overlap}組`:''}（撮影日・顔／全体ごと）。`;
}

/** Apply one face answer, then refresh every cached photo without running detection again. */
async function correctFace(recordId,faceIndex,personId,decision,canvas){
  const record=state.records.find(r=>r.id===recordId),face=record?.faces?.[faceIndex];
  if(!face||face.engineId!==ENGINE_ID)throw new Error('この写真を新方式で解析してください。');
  const affected=new Set([personId,...(decision==='ok'?[record.faceMatches?.[faceIndex]?.personId,...Object.keys(face.feedback||{}).filter(id=>face.feedback[id]==='ok')]:[])].filter(Boolean));
  let url=decision==='ok'?await canvasURL(canvas,80,80,face.box):null;
  let result;
  try{result=applyFaceFeedback(state.profiles,record,faceIndex,personId,decision);}catch(error){releaseImageURL(url);throw error;}
  if(result.addedReference){Object.assign(result.reference,{url,blob:imageBlobs.get(url),sourceRecordId:recordId,box:{...face.box}});}else releaseImageURL(url);
  for(const ref of result.removedReferences||[])releaseImageURL(ref.url);
  for(const registered of record.registeredFaces||[])if(registered.id===face.id)registered.feedback={...face.feedback};
  // Face corrections update only the affected names in a photo-level override.
  // Unrelated manually added people (including undetected faces) remain intact.
  if(record.manualPeople!=null){
    recomputeFaceDistances([record],state.profiles);
    const automatic=classifyPhoto({...record,manualPeople:null},state.profiles,options());
    record.manualPeople=[...new Set([...record.manualPeople.filter(id=>!affected.has(id)),...automatic.matchedIds.filter(id=>affected.has(id))])];
  }
  await refreshFeedbackScores();
  return result;
}

async function photoDialog(record){
  if(state.busy)return;
  const recordId=record.id,current=()=>state.records.find(r=>r.id===recordId);
  let file;
  try{file=record.handle?await verifyUnchanged(record):record.file;}catch(error){return notify(error.message,true);}
  const url=URL.createObjectURL(file),localURLs=[];let decoded,working=false,peopleEdited=false,selectionEdited=false;
  const done=dialog(`<form id="photo-form"><div class="dialog-body"><h2>写真を確認・修正</h2><img class="photo-detail-image" src="${url}" alt="${escape(record.file.name)}"><div class="photo-enroll-action"><button id="register-from-photo" class="outline-button" type="button">顔を選んで人物を登録</button>${!record.facesDetected?'<button id="analyze-photo" class="primary-button" type="button">この写真を解析して確認</button>':''}</div><div class="detail-info">${escape(record.relative)} · ${size(file.size)}</div><section class="photo-face-section"><h3>顔ごとに確認</h3><p class="hint">合っていればOK。違っていればNG、または正しい名前を選んでOK。修正はすぐにこの写真と解析済みの写真へ反映され、これから解析する写真の判定にも使います。</p><div id="photo-face-review"><p class="hint">顔の表示を準備しています…</p></div><p id="photo-feedback-status" class="photo-feedback-status" role="status"></p></section><label class="dialog-field">ボケ判定の基準例<select id="blur-example"><option value="">指定しない</option><option value="sharp" ${record.blurLabel==='sharp'?'selected':''}>この写真は鮮明</option><option value="blur" ${record.blurLabel==='blur'?'selected':''}>この写真はボケている</option></select></label><p class="hint">同じ撮影日の鮮明・ボケの例をそれぞれ3枚登録すると、ボケの基準を調整できます。</p><label class="dialog-field">分類する日付<input type="date" id="photo-date" value="${validDate(record.date)?record.date:''}"></label><details class="photo-manual-people"><summary>顔が見つからない人物などを写真全体に手動指定</summary><p class="hint">ここで指定した人物も出力先に使います。顔のOK／NGでは、修正した人物の指定を更新します。</p><div class="detail-pills">${state.profiles.map(p=>`<label><input type="checkbox" name="photo-person" value="${p.id}" ${record.matchedIds?.includes(p.id)?'checked':''}>${escape(p.name)}</label>`).join('')}</div></details><label class="check-line"><input id="photo-selected" type="checkbox" ${record.selected?'checked':''} ${record.error||!record.analyzed?'disabled':''}> この写真を出力する</label></div>${actions('<button type="submit" class="primary-button">日付・出力設定を保存して閉じる</button>')}</form>`);
  const form=$('photo-form'),isOpen=()=>$('dialog').open&&$('photo-form')===form;
  const cancel=event=>{if(working){event.preventDefault();event.stopImmediatePropagation();}};
  $('dialog').addEventListener('cancel',cancel,true);
  const crops=[];
  function paintFaces(){
    const live=current();if(!isOpen()||!live)return;
    $('photo-face-review').innerHTML=live.faces?.length?live.faces.map((face,i)=>{
      const match=live.faceMatches?.[i],person=state.profiles.find(p=>p.id===match?.personId);
      const selectedId=person?.id||match?.candidateIds?.[0]||state.activePerson||'';
      const answers=Object.entries(face.feedback||{}).map(([id,value])=>{const name=state.profiles.find(p=>p.id===id)?.name;return name?`${name}：${value==='ok'?'OK・本人':'NG・別人'}`:'';}).filter(Boolean).join(' / ');
      return `<article class="photo-review-face" data-review-face="${i}"><img src="${crops[i]||url}" alt="顔 ${i+1}"><div class="photo-review-fields"><strong>顔 ${i+1} · ${person?escape(person.name):'未確定'}</strong><p data-review-status>${escape(answers||'未確認')}</p><label>この顔の人物<select data-review-person="${i}" aria-label="顔 ${i+1}の人物"><option value="">人物を選ぶ</option>${state.profiles.map(p=>`<option value="${p.id}" ${p.id===selectedId?'selected':''}>${escape(p.name)}</option>`).join('')}</select></label><div class="photo-review-actions"><button type="button" class="primary-button" data-review-decision="ok">OK・本人</button><button type="button" class="outline-button danger" data-review-decision="ng">NG・別人</button></div></div></article>`;
    }).join(''):`<p class="hint">${live.facesDetected?'顔が見つかりませんでした。「顔を選んで人物を登録」から手動で囲めます。':'人物を登録して写真を解析すると、ここで顔ごとに修正できます。'}</p>`;
  }
  function persistDraft(){
    const live=current();if(!live)return;
    if(peopleEdited){live.manualPeople=[...form.querySelectorAll('[name=photo-person]:checked')].map(v=>v.value);peopleEdited=false;}
    if(selectionEdited){live.manualSelected=$('photo-selected').checked;selectionEdited=false;}
  }
  $('register-from-photo').onclick=()=>{persistDraft();closeDialog();void registerPeopleFromPhoto(current());};
  if($('analyze-photo'))$('analyze-photo').onclick=async()=>{persistDraft();closeDialog();await scan({onlyIds:[recordId]});void photoDialog(current());};
  form.querySelectorAll('[name=photo-person]').forEach(input=>input.addEventListener('change',()=>peopleEdited=true));
  $('photo-selected').addEventListener('change',()=>selectionEdited=true);
  $('photo-face-review').onclick=async event=>{
    const button=event.target.closest('[data-review-decision]');if(!button||working||!decoded)return;
    const card=button.closest('[data-review-face]'),index=Number(card.dataset.reviewFace),personId=card.querySelector('select').value;
    if(!personId)return notify('確認する人物を選んでください。',true);
    persistDraft();working=true;const controls=[...form.querySelectorAll('button,input,select')].map(node=>[node,node.disabled]);controls.forEach(([node])=>node.disabled=true);
    try{
      await job('顔の修正を反映しています',async()=>{
        await correctFace(recordId,index,personId,button.dataset.reviewDecision,decoded.canvas);
        if(!isOpen())return;
        paintFaces();const live=current();
        form.querySelectorAll('[name=photo-person]').forEach(input=>input.checked=live.matchedIds?.includes(input.value));
        $('photo-selected').checked=live.selected;
        $('photo-feedback-status').textContent='修正を反映しました。顔のOK／NGはこの画面を閉じても有効です。';
      });
    }finally{working=false;controls.forEach(([node,disabled])=>{if(node.isConnected)node.disabled=disabled;});}
  };
  form.onsubmit=e=>{
    e.preventDefault();if(working)return;
    const live=current(),date=$('photo-date').value;if(!live)return closeDialog();
    if(!validDate(date))return notify('日付を正しく入力してください。',true);
    persistDraft();if(date!==live.date){live.date=date;live.manualDate=true;live.dateSource='手動で指定';}
    live.blurLabel=$('blur-example').value||null;classifyRecords();closeDialog();render();
  };
  try{
    if(record.faces?.length){
      decoded=await decodeImage(file);
      if(isOpen()){
        const display=document.createElement('canvas'),scale=Math.min(1,1000/decoded.width,600/decoded.height);
        display.width=Math.max(1,Math.round(decoded.width*scale));display.height=Math.max(1,Math.round(decoded.height*scale));
        const context=display.getContext('2d');context.drawImage(decoded.canvas,0,0,display.width,display.height);
        for(const [i,face] of record.faces.entries()){
          const crop=await canvasURL(decoded.canvas,130,130,face.box);localURLs.push(crop);crops.push(crop);
          const x=face.box.x*scale,y=face.box.y*scale;context.strokeStyle='#d77a27';context.lineWidth=3;context.strokeRect(x,y,face.box.width*scale,face.box.height*scale);
          context.fillStyle='#87430e';context.fillRect(x,Math.max(0,y-22),28,22);context.fillStyle='#fff';context.font='bold 16px sans-serif';context.fillText(String(i+1),x+6,Math.max(17,y-5));
        }
        const annotated=await canvasURL(display,1000,600);localURLs.push(annotated);display.width=display.height=1;
        if(isOpen())form.querySelector('.photo-detail-image').src=annotated;
      }
    }
    paintFaces();await done;
  }catch(error){if(isOpen())$('photo-face-review').textContent=error.message;await done;}
  finally{decoded?.close();localURLs.forEach(releaseImageURL);URL.revokeObjectURL(url);$('dialog').removeEventListener('cancel',cancel,true);}
}

function makePlan(){
  const opts=options();
  if(state.analyzedMode!==null&&opts.useFaces!==state.analyzedMode)throw new Error('人物の設定が変わりました。写真を再解析してください。');
  const plan=outputPlan(state.records,state.profiles,state.events,opts);
  if(!plan.length)throw new Error('出力する写真を選択してください。');
  return plan;
}

function resultDialog(title,text,errors=[]){
  dialog(`<div class="dialog-body"><h2>${escape(title)}</h2><p>${escape(text).replace(/\n/g,'<br>')}</p>${errors.length?`<div class="error-list">${errors.map(e=>`${escape(e.path)}: ${escape(e.error)}`).join('<br>')}</div>`:''}</div>${actions('')}`);
}

async function exportFolder(){
  let plan,settings,output;
  try{plan=makePlan();settings=compressionOptions();output=await window.showDirectoryPicker({id:'photosorter-output',mode:'readwrite'});}
  catch(error){if(error.name!=='AbortError')notify(error.message,true);return;}
  await job('人物・イベント別に出力',async signal=>{
    const result=await exportRecords(plan,output,state.source,{...settings,signal,onProgress:progress,compressFn:(file,target,{allowResize,signal})=>compressToTarget(file,target,allowResize,{signal})});
    resultDialog(result.cancelled?'出力を中止しました':'出力しました',`${result.exported}ファイルを保存しました。\n${output.name} / ${result.folderName}\n処理結果.jsonに詳細を記録しました。`,result.errors);
  });
}

function download(blob,name){const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}

async function exportZip(){
  let plan,settings;
  try{plan=makePlan();settings=compressionOptions();}catch(error){return notify(error.message,true);}
  await job('ZIPを作成しています',async signal=>{
    const chunks=[];let zipError;
    const zip=new globalThis.fflate.Zip((error,data)=>{if(error)zipError=error;else chunks.push(data);});
    const report={version:1,createdAt:new Date().toISOString(),files:[]};
    const used=new Set();let total=0,exported=0;const errors=[];
    for(let i=0;i<plan.length;i++){
      if(signal.aborted)break;
      const record=plan[i];
      try{
        const file=record.handle?await verifyUnchanged(record):record.file;
        const blob=settings.targetBytes===null?file:(await compressToTarget(file,settings.targetBytes,settings.allowResize,{signal})).blob;
        if(record.handle)await verifyUnchanged(record);
        total+=blob.size;
        if(total>700e6)throw new Error('ZIPが700 MBを超えます。写真を分けるか、フォルダへの直接出力を使ってください。');
        const path=validatedOutputParts(record).join('/')+(settings.targetBytes===null?'':'.jpg');
        if(used.has(path.toLocaleLowerCase()))throw new Error('同じ出力名が重複しています。');
        const bytes=new Uint8Array(await blob.arrayBuffer());
        if(record.handle)await verifyUnchanged(record);
        used.add(path);
        const item=new globalThis.fflate.ZipPassThrough(path);zip.add(item);item.push(bytes,true);
        if(zipError)throw zipError;
        exported++;report.files.push({source:record.relative,target:path,bytes:blob.size,date:record.date,dateSource:record.dateSource,event:record.event,people:record.people,status:'exported'});
      }catch(error){if(error.name==='AbortError')break;errors.push({path:record.relative,error:error.message});report.files.push({source:record.relative,status:'error',error:error.message});if(total>700e6)break;}
      progress(i+1,plan.length,record.relative);await tick();
    }
    report.summary={exported,cancelled:signal.aborted,errors};
    const log=new globalThis.fflate.ZipPassThrough('処理結果.json');zip.add(log);log.push(new TextEncoder().encode(JSON.stringify(report,null,2)),true);zip.end();
    if(zipError)throw zipError;
    download(new Blob(chunks,{type:'application/zip'}),`PhotoSorter_${localDate(new Date())}.zip`);
    resultDialog(signal.aborted?'完了した分をZIPに保存':'ZIPを保存しました',`${exported}ファイルを保存しました。解凍すると人物・イベント・日付ごとのフォルダになります。`,errors);
  });
}

async function quarantineDialog(){
  const candidates=state.records.filter(r=>r.blurry&&!r.error);
  if(!candidates.length)return;
  dialog(`<form id="quarantine-form"><div class="dialog-body"><h2>ボケ候補を確認して退避</h2><p>選んだ元写真を「${escape(state.sourceName)} / _PhotoSorter_退避」へ移動します。コピーの内容を検証してから元の場所から外します。「復元」で戻せます。Windowsのごみ箱への移動ではありません。</p><div class="quarantine-list">${candidates.map(r=>`<label class="quarantine-item"><input type="checkbox" name="quarantine-photo" value="${r.id}"><img src="${r.thumbnail}" alt="${escape(r.file.name)}"><span>${escape(r.relative)}<small>鮮明度 ${r.sharpness.toFixed(1)}</small></span></label>`).join('')}</div></div>${actions('<button class="primary-button" type="submit">チェックした写真を退避</button>')}</form>`);
  $('quarantine-form').onsubmit=async event=>{
    event.preventDefault();
    const ids=[...document.querySelectorAll('[name=quarantine-photo]:checked')].map(e=>e.value);
    if(!ids.length)return notify('確認した写真にチェックを入れてください。',true);
    const records=candidates.filter(r=>ids.includes(r.id));
    if(!window.confirm(`${state.sourceName}の元写真 ${records.length}枚を退避フォルダへ移動します。実行しますか？`))return;
    try{if(await state.source.requestPermission({mode:'readwrite'})!=='granted')throw new Error('書き込みが許可されませんでした。元写真は変更していません。');}
    catch(error){return notify(error.message,true);}
    closeDialog();
    await job('ボケ候補を退避しています',async signal=>{
      const result=await quarantineRecords(records,state.source,{signal,onProgress:progress});
      const removed=new Set(result.ids);
      for(const record of state.records.filter(r=>removed.has(r.id)))releaseImageURL(record.thumbnail);
      state.records=state.records.filter(r=>!removed.has(r.id));
      resultDialog('退避の結果',`${result.quarantined}枚を退避しました。\n「退避した写真を復元」から戻せます。`,result.errors);
    });
  };
}

async function restore(){
  if(!window.confirm(`${state.sourceName}の退避フォルダから写真を元の場所へ復元します。同名の写真は上書きしません。実行しますか？`))return;
  try{if(await state.source.requestPermission({mode:'readwrite'})!=='granted')throw new Error('書き込み許可が必要です。');}
  catch(error){return notify(error.message,true);}
  await job('退避した写真を復元しています',async signal=>{
    const result=await restoreQuarantine(state.source,{signal,onProgress:progress});
    resultDialog('復元の結果',`${result.restored}枚を復元しました。\n写真フォルダを開き直して解析してください。`,result.errors);
  });
}

function help(){dialog(`<div class="dialog-body"><h2>写真を選び、その場で判定を直す。</h2><ol class="help-list"><li><strong>写真フォルダを開く</strong>。写真をクリックし、<strong>顔を選んで人物を登録</strong>から名前を付けます。集合写真でも一人ずつ選べます。検出されない顔は手動で囲めます。</li><li><strong>写真を解析</strong>。登録した人物に合わせて、出力対象と人物別の振り分け先を決めます。</li><li><strong>写真を開いて顔ごとに確認</strong>。合っていれば<strong>OK・本人</strong>、違っていれば<strong>NG・別人</strong>。正しい名前が分かれば、その名前を選んでOKにします。訂正はすぐに分類へ反映し、ほかの写真の判定例にも使います。左側のOK／NGボタンで、候補を続けて確認することもできます。</li><li><strong>日付・イベント・容量を設定</strong>。日帰り・複数日の旅行に対応します。ボケの自動除外を使う場合は、写真を開いて同じ撮影日の鮮明・ボケの例を各3枚指定します。</li><li><strong>フォルダへ出力 / ZIPで保存</strong>。集合写真は写っている各人のフォルダへコピーします。</li></ol><p>顔認識はこの端末で実行します。初回はモデル等を約51MB読み込みます。写真と顔の特徴量は送信しません。顔の登録とOK／NGはタブを閉じると消えますが、「更新して再開」では引き継ぎます。旧方式からの更新時は元写真から顔の再登録が必要です。</p><p>OK／NGは本人・別人の参照例として判定を補正します。顔認識モデル自体の再学習ではありません。判別が難しい顔は要確認に残します。撮影日がない写真はファイル更新日を代用します。圧縮する場合は指定容量以下のJPEGを作り、元写真は変更しません。</p></div>${actions('')}`);}

function listen(id,event,fn){$(id).addEventListener(event,fn);}
const savedControlIds=['use-faces','review-feedback-answers','distance','ambiguity-margin','skip-blur','compress','target-size','target-unit','allow-resize','export-mode','person-filter','date-filter'];

async function getUpdateSnapshot(){
  await thumbnails.waitForIdle();
  return {schema:1,qualityVersion:3,engineId:ENGINE_ID,profiles:state.profiles.map(person=>({...person,pendingRefs:(person.pendingRefs||[]).map(ref=>({...ref,url:undefined,blob:ref.blob||imageBlobs.get(ref.url)})),refs:person.refs.map(ref=>({...ref,url:undefined,blob:imageBlobs.get(ref.url)}))})),
    records:state.records.map(record=>({...record,thumbnail:null,thumbnailBlob:record.thumbnailBlob||imageBlobs.get(record.thumbnail)})),
    activePerson:state.activePerson,events:state.events,source:state.source,sourceName:state.sourceName,filter:state.filter,page:state.page,analyzedMode:state.analyzedMode,
    controls:Object.fromEntries(savedControlIds.map(id=>[id,$(id).type==='checkbox'?$(id).checked:$(id).value])),scrollY:window.scrollY};
}

async function applyUpdateSnapshot(snapshot){
  if(snapshot?.schema!==1||!Array.isArray(snapshot.profiles)||!Array.isArray(snapshot.records)||!Array.isArray(snapshot.events))throw new Error('一時保存データの形式が違います。');
  const migration=migrateSnapshot(snapshot);snapshot=migration.snapshot;
  const urls=[];
  let profiles,records;
  const events=[];
  const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id);
  const restoreURL=blob=>{const url=imageURL(blob);urls.push(url);return url;};
  try{
    profiles=snapshot.profiles.map(person=>{
      if(!validId(person.id)||typeof person.name!=='string'||!Array.isArray(person.refs))throw new Error('人物登録を確認できません。');
      return {...person,pendingRefs:(person.pendingRefs||[]).map(ref=>({...ref,url:ref.blob instanceof Blob?restoreURL(ref.blob):null})),refs:person.refs.map(ref=>{if(!(ref.blob instanceof Blob)||!ref.descriptor?.length)throw new Error('登録した顔写真を復元できません。');return {...ref,blob:undefined,descriptor:Float32Array.from(ref.descriptor),url:restoreURL(ref.blob)};})};
    });
    records=snapshot.records.map(record=>{
      if(!validId(record.id)||!(record.file instanceof Blob)||typeof record.file.name!=='string'||!Array.isArray(record.parts))throw new Error('読み込んだ写真を確認できません。');
      return {...record,thumbnail:record.thumbnailBlob instanceof Blob?restoreURL(record.thumbnailBlob):null};
    });
    for(const event of snapshot.events)events.push(validateEvent(event,events));
  }catch(error){urls.forEach(releaseImageURL);throw error;}
  clearRecords();
  for(const person of state.profiles)for(const ref of [...person.refs,...(person.pendingRefs||[])])releaseImageURL(ref.url);
  Object.assign(state,{profiles,records,events,source:snapshot.source||null,sourceName:String(snapshot.sourceName||''),activePerson:snapshot.activePerson,
    filter:['all','selected','review','blur','error'].includes(snapshot.filter)?snapshot.filter:'all',page:Math.max(0,Number(snapshot.page)||0),analyzedMode:snapshot.analyzedMode??null});
  for(const id of savedControlIds){if(id in (snapshot.controls||{})){if($(id).type==='checkbox')$(id).checked=!!snapshot.controls[id];else $(id).value=snapshot.controls[id];}}
  if(snapshot.qualityVersion!==3)$('skip-blur').checked=false;
  recomputeFaceDistances(state.records.filter(r=>r.featuresReady),state.profiles);classifyRecords();
  saveEvents();render();
  for(const id of ['person-filter','date-filter'])if(snapshot.controls?.[id])$(id).value=snapshot.controls[id];
  document.querySelectorAll('[data-filter]').forEach(button=>button.classList.toggle('active',button.dataset.filter===state.filter));
  renderGallery();
  requestAnimationFrame(()=>window.scrollTo(0,Math.max(0,Number(snapshot.scrollY)||0)));
  if(migration.migrated)notify('新しい顔認識方式へ更新しました。写真・人物名・イベントは復元済みです。人物の顔を元写真から登録し直し、写真を解析してください。');
}

listen('add-person','click',()=>editPerson());
listen('choose-face-photo','click',()=>{if(state.busy)return;state.pickFacePhoto=true;state.filter='all';state.page=0;$('person-filter').value='';$('date-filter').value='';document.querySelectorAll('[data-filter]').forEach(button=>button.classList.toggle('active',button.dataset.filter==='all'));render();$('gallery').scrollIntoView({behavior:'smooth',block:'center'});});
listen('cancel-face-photo','click',()=>{state.pickFacePhoto=false;render();});
listen('people-list','click',event=>{
  if(state.busy)return;
  const edit=event.target.closest('[data-edit-person]');
  if(edit)return editPerson(state.profiles.find(p=>p.id===edit.dataset.editPerson));
  const person=event.target.closest('[data-person]');if(person){state.activePerson=person.dataset.person;renderPeople();updateControls();}
});
listen('people-list','keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.target.click();}});
listen('add-reference','click',()=>$('reference-files').click());
listen('reference-files','change',async event=>{const files=[...event.target.files];event.target.value='';await addReferences(files);});
listen('reference-list','click',event=>{const button=event.target.closest('[data-remove-ref]');if(!button||state.busy)return;const person=state.profiles.find(p=>p.id===state.activePerson);releaseImageURL(person.refs[Number(button.dataset.removeRef)].url);person.refs.splice(Number(button.dataset.removeRef),1);invalidateAnalysis();});
listen('new-event','click',()=>editEvent());
listen('event-list','click',event=>{const button=event.target.closest('[data-event]');if(button)editEvent(state.events.find(e=>e.id===button.dataset.event));});
listen('day-list','click',event=>{const edit=event.target.closest('[data-day-event]');if(edit)return editEvent(eventForDate(edit.dataset.dayEvent,state.events),edit.dataset.dayEvent);const day=event.target.closest('[data-day-filter]');if(day){$('date-filter').value=day.dataset.dayFilter;state.page=0;renderGallery();}});
listen('save-events','click',()=>download(new Blob([JSON.stringify({version:1,events:state.events},null,2)],{type:'application/json'}),'PhotoSorter-events.json'));
listen('load-events','click',()=>$('event-file').click());
listen('event-file','change',async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>2e6)throw new Error('設定ファイルが大きすぎます。');const data=JSON.parse(await file.text());if(!Array.isArray(data.events)||data.events.length>2000)throw new Error('イベント設定の形式が違います。');const events=[];for(const item of data.events)events.push(validateEvent({...item,id:uid()},events));state.events=events;saveEvents();render();notify('イベント設定を読み込みました。');}catch(error){notify(error.message,true);}finally{event.target.value='';}});
for(const id of ['choose-source','empty-import'])listen(id,'click',loadSource);
listen('fallback-source','click',()=>$('source-files').click());
listen('source-files','change',async event=>{await loadFallback(event.target.files);event.target.value='';});
listen('scan-button','click',()=>scan());
listen('start-feedback','click',startFaceFeedback);
listen('enable-blur-calibration','click',()=>{$('skip-blur').checked=true;reclassify(true);});
listen('reclassify','click',()=>reclassify());
listen('use-faces','change',()=>{invalidateAnalysis();render();});
listen('export-mode','change',()=>reclassify(true));
listen('skip-blur','change',()=>reclassify(true));
for(const id of ['person-filter','date-filter'])listen(id,'change',()=>{state.page=0;renderGallery();});
document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{state.filter=button.dataset.filter;state.page=0;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b===button));renderGallery();});
listen('select-visible','click',()=>{visible().filter(r=>r.analyzed&&!r.error).forEach(r=>{r.selected=true;r.manualSelected=true;});renderGallery();});
listen('clear-visible','click',()=>{visible().filter(r=>r.analyzed&&!r.error).forEach(r=>{r.selected=false;r.manualSelected=false;});renderGallery();});
listen('gallery','change',event=>{const id=event.target.dataset.select;if(id){const record=state.records.find(r=>r.id===id);record.selected=event.target.checked;record.manualSelected=event.target.checked;renderGallery();}});
listen('gallery','click',event=>{const button=event.target.closest('[data-photo]');if(button){const record=state.records.find(r=>r.id===button.dataset.photo);if(state.pickFacePhoto)void registerPeopleFromPhoto(record);else void photoDialog(record);}});
listen('prev-page','click',()=>{state.page--;renderGallery();});listen('next-page','click',()=>{state.page++;renderGallery();});
listen('export-folder','click',exportFolder);listen('export-zip','click',exportZip);
listen('quarantine','click',quarantineDialog);listen('restore','click',restore);
listen('cancel','click',()=>{state.controller?.abort();closeDialog();$('progress-detail').textContent='中止しています。完了した出力は残ります。';});
listen('help-button','click',help);
listen('close-updates','click',()=>$('update-dialog').close());
window.addEventListener('beforeunload',event=>{if(state.busy&&!updatingApp){event.preventDefault();event.returnValue='';}});
document.querySelectorAll('[data-app-version]').forEach(element=>element.textContent=`v${CURRENT_VERSION}`);
render();
void installUpdates({
  versionElement:$('app-version'),checkButton:$('check-update'),statusElement:$('update-status'),restartButton:$('restart-update'),retryButton:$('retry-update-restore'),
  getSnapshot:getUpdateSnapshot,applySnapshot:applyUpdateSnapshot,canUpdate:()=>!state.busy&&!$('dialog').open,
  onCheck:()=>{if(!$('update-dialog').open)$('update-dialog').showModal();},
  onError:text=>{notify(text,true);if(!$('update-dialog').open)$('update-dialog').showModal();},
  onBusy:value=>{updatingApp=value;state.busy=value;updateControls();if(!value)render();},
}).catch(error=>notify(error.message,true));
