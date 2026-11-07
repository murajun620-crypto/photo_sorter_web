import {loadModels, decodeImage, detectFaces, faceDistance, blurScore, compressToTarget} from './imaging.js';
import {collectPhotos, verifyUnchanged, validatedOutputParts, exportRecords, quarantineRecords, restoreQuarantine} from './filesystem.js';
import {photoDate, localDate, validDate, safeName, validateEvent, eventForDate, classifyPhoto, outputPlan} from './organize.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const uid = () => crypto.randomUUID();
const size = bytes => bytes >= 1e6 ? `${(bytes/1e6).toFixed(2)} MB` : `${Math.round(bytes/1000)} KB`;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const EVENT_KEY = `photo-sorter-events-v1:${location.pathname}`;
const state = {profiles:[], activePerson:null, events:[], records:[], source:null, sourceName:'', filter:'all', page:0, busy:false, controller:null, analyzedMode:null};
const perPage = 48;
let toastTimer;
let dialogResolve;

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
  try { return await action(state.controller.signal); }
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
  const maxDistance=Number($('distance').value), blurThreshold=Number($('blur-threshold').value);
  if (!Number.isFinite(maxDistance) || maxDistance<.1 || maxDistance>1) throw new Error('顔の距離しきい値は0.1〜1で入力してください。');
  if (!Number.isFinite(blurThreshold) || blurThreshold<0 || blurThreshold>100000) throw new Error('鮮明度のしきい値は0〜100000で入力してください。');
  return {useFaces:$('use-faces').checked,maxDistance,blurThreshold,skipBlur:$('skip-blur').checked,mode:$('export-mode').value};
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
  for (const id of ['select-visible','clear-visible','reclassify']) $(id).disabled=pending||!state.records.some(r=>r.analyzed);
  const selected=state.records.some(r=>r.selected&&!r.error);
  $('export-folder').disabled=pending||!selected||!state.source||!window.showDirectoryPicker;
  $('export-zip').disabled=pending||!selected;
  $('quarantine').disabled=pending||!state.source||!state.records.some(r=>r.blurry);
  $('restore').disabled=pending||!state.source;
  $('cancel').disabled=!pending;
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
  for (const record of state.records) { record.analyzed=false; record.selected=false; record.faces=[]; record.distances={}; record.matchedIds=[]; record.manualPeople=null; record.blurry=false; record.error=null; }
  state.analyzedMode=null;
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
    else{const profile={id:uid(),name,refs:[]};state.profiles.push(profile);state.activePerson=profile.id;invalidateAnalysis();}
    closeDialog(true);render();
  };
  if(person)$('delete-person').onclick=()=>{
    for(const ref of person.refs)URL.revokeObjectURL(ref.url);
    state.profiles=state.profiles.filter(p=>p.id!==person.id);
    if(state.activePerson===person.id)state.activePerson=state.profiles[0]?.id||null;
    invalidateAnalysis();closeDialog(true);
  };
  $('person-name').focus();
  return result;
}

function renderPeople() {
  $('people-list').innerHTML=state.profiles.length ? state.profiles.map(p=>`<div class="person ${p.id===state.activePerson?'active':''}" data-person="${p.id}" tabindex="0" role="button" aria-label="${escape(p.name)}を選択"><span class="avatar">${escape(p.name.slice(0,1))}</span><span class="person-label">${escape(p.name)}<small>顔写真 ${p.refs.length}枚</small></span><button class="tiny-button" data-edit-person="${p.id}" aria-label="${escape(p.name)}の設定">⋯</button></div>`).join('') : '<p class="hint">「＋ 追加」から人物を登録してください。</p>';
  const active=state.profiles.find(p=>p.id===state.activePerson);
  $('add-reference').textContent=active?`${active.name}の顔写真を追加`:'顔写真を追加';
  $('reference-list').innerHTML=(active?.refs||[]).map((ref,i)=>`<div class="reference"><img src="${ref.url}" alt="登録した顔 ${i+1}"><button data-remove-ref="${i}" aria-label="顔写真${i+1}を外す">×</button></div>`).join('');
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
  return URL.createObjectURL(blob);
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
        const faces=await detectFaces(decoded.canvas);
        if(signal.aborted)break;
        if(!faces.length){notify(`${file.name}: 顔が見つかりません。顔が大きく写った写真を選んでください。`,true);continue;}
        for(const face of faces)urls.push(await canvasURL(decoded.canvas,150,150,face.box));
        if(signal.aborted)break;
        const answer=dialog(`<div class="dialog-body"><h2>${escape(person.name)}の顔を選んでください</h2><p>${escape(file.name)} · 集合写真からも指定できます。</p><div class="face-grid">${urls.map((url,i)=>`<button class="face-option" data-face="${i}"><img src="${url}" alt="検出した顔 ${i+1}"><span>この顔を登録</span></button>`).join('')}</div></div>${actions('')}`);
        for(const button of $('dialog').querySelectorAll('[data-face]'))button.onclick=()=>closeDialog(Number(button.dataset.face));
        const chosen=await answer;
        if(chosen!==null&&!signal.aborted){
          const url=await canvasURL(decoded.canvas,80,80,faces[chosen].box);
          person.refs.push({descriptor:faces[chosen].descriptor,url});added++;
          renderPeople();
        }
      }catch(error){notify(`${file.name}: ${error.message}`,true);}
      finally{decoded?.close();urls.forEach(url=>URL.revokeObjectURL(url));}
    }
    if(added){invalidateAnalysis();notify(`${person.name}の顔写真を${added}枚追加しました。`);}
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

function clearRecords(){state.records.forEach(record=>{if(record.thumbnail)URL.revokeObjectURL(record.thumbnail);});state.records=[];state.page=0;state.analyzedMode=null;}

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

async function scan(){
  let opts;
  try{
    opts=options();
    if(opts.useFaces&&(!state.profiles.length||state.profiles.some(p=>!p.refs.length)))throw new Error('人物ごとに顔写真を1枚以上登録してください。人物で絞らない場合はチェックを外してください。');
  }catch(error){return notify(error.message,true);}
  await job('写真を解析しています',async signal=>{
    for(const record of state.records){record.selected=false;record.analyzed=false;record.error=null;record.blurry=false;record.faces=[];record.distances={};record.matchedIds=[];}
    if(opts.useFaces)await loadModels(text=>progress(0,0,text));
    state.analyzedMode=opts.useFaces;
    for(let i=0;i<state.records.length;i++){
      if(signal.aborted)break;
      let record=state.records[i],decoded;
      record.selected=false;record.error=null;
      try{
        const file=record.handle?await verifyUnchanged(record):record.file;
        decoded=await decodeImage(file);
        if(record.thumbnail)URL.revokeObjectURL(record.thumbnail);
        record.thumbnail=await canvasURL(decoded.canvas);
        if(!record.manualDate)Object.assign(record,await photoDate(file));
        record.width=decoded.width;record.height=decoded.height;
        const faces=opts.useFaces?await detectFaces(decoded.canvas):[];
        record.faces=faces.map(face=>({box:face.box,blur:blurScore(decoded.canvas,[face.box]),distances:Object.fromEntries(state.profiles.map(person=>[person.id,faceDistance([face.descriptor],person.refs.map(ref=>ref.descriptor))]))}));
        record.distances=Object.fromEntries(state.profiles.map(person=>[person.id,faceDistance(faces.map(face=>face.descriptor),person.refs.map(ref=>ref.descriptor))]));
        record.fullBlur=blurScore(decoded.canvas);record.analyzed=true;
        state.records[i]=classifyPhoto(record,state.profiles,opts);
      }catch(error){record.error=error.message;record.analyzed=true;record.selected=false;record.blurry=false;}
      finally{decoded?.close();}
      progress(i+1,state.records.length,record.relative);
      if(i%5===0)renderGallery();
      await tick();
    }
    notify(signal.aborted?'解析を中止しました。完了した写真は確認できます。':'解析が終わりました。人物とボケ候補を確認してください。');
  });
}

function reclassify(quiet=false){
  try{
    const opts=options();
    if(state.analyzedMode!==null&&opts.useFaces!==state.analyzedMode)throw new Error('人物で絞り込む設定が変わりました。もう一度「写真を解析」してください。');
    state.records=state.records.map(record=>record.analyzed?classifyPhoto(record,state.profiles,opts):record);
    render();if(!quiet)notify('現在の設定で出力対象を選び直しました。');
  }catch(error){notify(error.message,true);}
}

function filtered(){
  return state.records.filter(r=>(state.filter==='all'||state.filter==='selected'&&r.selected||state.filter==='blur'&&r.blurry||state.filter==='error'&&r.error)
    &&(!$('person-filter').value||r.matchedIds?.includes($('person-filter').value))&&(!$('date-filter').value||r.date===$('date-filter').value));
}

function visible(){return filtered().slice(state.page*perPage,(state.page+1)*perPage);}

function renderGallery(){
  const filteredRecords=filtered();
  state.page=Math.min(state.page,Math.max(0,Math.ceil(filteredRecords.length/perPage)-1));
  const records=visible();
  $('gallery').innerHTML=records.map(record=>`<article class="photo-card ${record.selected?'selected':''}"><button class="photo-image" data-photo="${record.id}" aria-label="${escape(record.relative)}を確認">${record.thumbnail?`<img loading="lazy" src="${record.thumbnail}" alt="${escape(record.file.name)}">`:`<span class="error-symbol">${record.error?'!':'▧'}</span>`}</button><label class="card-checkbox"><input type="checkbox" data-select="${record.id}" ${record.selected?'checked':''} ${state.busy||!record.analyzed||record.error?'disabled':''} aria-label="${escape(record.relative)}を出力対象に"></label>${record.blurry?'<span class="blur-badge">ボケ候補</span>':''}<div class="card-info"><div class="card-name" title="${escape(record.relative)}">${escape(record.file.name)}</div><div class="card-meta"><span>${escape(record.date)}</span><span>${size(record.file.size)}</span></div><div class="card-people">${record.error?'<span class="person-tag neutral">読み込みエラー</span>':!record.analyzed?'<span class="person-tag neutral">未解析</span>':record.matchedIds?.length?state.profiles.filter(p=>record.matchedIds.includes(p.id)).map(p=>`<span class="person-tag">${escape(p.name)}</span>`).join(''):`<span class="person-tag neutral">${state.analyzedMode?'人物未分類':'日付で整理'}</span>`}</div></div></article>`).join('');
  $('empty-state').hidden=!!state.records.length;
  $('pagination').hidden=filteredRecords.length<=perPage;
  $('page-label').textContent=`${state.page+1} / ${Math.max(1,Math.ceil(filteredRecords.length/perPage))}`;
  $('prev-page').disabled=state.page===0;
  $('next-page').disabled=(state.page+1)*perPage>=filteredRecords.length;
  $('result-caption').textContent=state.records.length?`${filteredRecords.length}枚を表示 · 写真をクリックして確認`:'解析した写真をここで確認できます';
  $('total-count').textContent=state.records.length;
  $('selected-count').textContent=state.records.filter(r=>r.selected).length;
  $('blur-count').textContent=state.records.filter(r=>r.blurry).length;
  updateControls();
}

function render(){
  renderPeople();renderDates();renderGallery();
  $('source-name').textContent=state.sourceName||'フォルダが選択されていません';
  $('source-meta').textContent=state.records.length?`${state.records.length}枚 · ${size(state.records.reduce((sum,r)=>sum+r.file.size,0))} · ${state.source?'ローカルフォルダに接続中':'ZIP出力モード'}`:'サブフォルダの写真もまとめて整理できます';
  $('folder-preview').textContent=$('export-mode').value==='people'&&$('use-faces').checked?'人物名 / イベントの期間と名前 / 日付 / 写真':'イベントの期間と名前 / 日付 / 写真';
  $('browser-note').hidden=!!window.showDirectoryPicker&&(!!state.source||!state.records.length);
  $('browser-note').textContent='この読み込み方法ではZIPで保存できます。フォルダへの直接出力・元写真の退避には、Chrome / Edgeで「写真フォルダを開く」を使ってください。';
}

async function photoDialog(record){
  if(state.busy)return;
  let file;
  try{file=record.handle?await verifyUnchanged(record):record.file;}catch(error){return notify(error.message,true);}
  const url=URL.createObjectURL(file);
  const done=dialog(`<form id="photo-form"><div class="dialog-body"><h2>写真を確認</h2><img class="photo-detail-image" src="${url}" alt="${escape(record.file.name)}"><div class="detail-info">${escape(record.relative)}<br>${record.width||'?'} × ${record.height||'?'} px · ${size(file.size)} · 鮮明度 ${Number.isFinite(record.sharpness)?record.sharpness.toFixed(1):'—'}<br>${escape(record.error||record.dateSource||'')}</div><label class="dialog-field">分類する日付<input type="date" id="photo-date" value="${validDate(record.date)?record.date:''}"></label><p>写っている人物を確認・修正できます。顔の数値は距離で、小さいほど近い顔です。</p><div class="detail-pills">${state.profiles.map(p=>`<label><input type="checkbox" name="photo-person" value="${p.id}" ${record.matchedIds?.includes(p.id)?'checked':''}>${escape(p.name)} <small>${record.distances?.[p.id]!=null?record.distances[p.id].toFixed(3):'—'}</small></label>`).join('')}</div><label class="check-line"><input id="photo-selected" type="checkbox" ${record.selected?'checked':''} ${record.error||!record.analyzed?'disabled':''}> この写真を出力する</label></div>${actions('<button type="submit" class="primary-button">変更を保存</button>')}</form>`);
  $('photo-form').onsubmit=e=>{
    e.preventDefault();const date=$('photo-date').value;
    if(!validDate(date))return notify('日付を正しく入力してください。',true);
    if(date!==record.date){record.date=date;record.manualDate=true;record.dateSource='手動で指定';}
    record.manualPeople=[...document.querySelectorAll('[name=photo-person]:checked')].map(v=>v.value);
    const selected=$('photo-selected').checked;
    Object.assign(record,classifyPhoto(record,state.profiles,options()));
    record.selected=selected&&!record.error&&record.analyzed;
    closeDialog();render();
  };
  await done;URL.revokeObjectURL(url);
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
      for(const record of state.records.filter(r=>removed.has(r.id)))if(record.thumbnail)URL.revokeObjectURL(record.thumbnail);
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

function help(){dialog(`<div class="dialog-body"><h2>写真の整理から、友達へのおすそわけまで。</h2><ol class="help-list"><li><strong>人物を追加</strong>して、その人の顔写真を登録。集合写真では顔をクリックします。人物ごとに数枚あると選びやすくなります。</li><li><strong>写真フォルダを開く → 写真を解析</strong>。顔の候補とボケの目安を計算します。写真をクリックして人物・日付を修正できます。</li><li><strong>イベントを登録</strong>。日帰りは1日、旅行は開始日〜終了日を指定。日付の重複するイベントは作れません。</li><li><strong>フォルダへ出力 / ZIPで保存</strong>。人物ごとに分けると、集合写真は写っている各人へコピー。各フォルダ内をイベント・日付で整理します。</li></ol><p>写真と顔の特徴量は端末内で処理し、サーバーに送信しません。顔の登録はタブを閉じると消去。イベント名と期間はこのブラウザだけに保存します。判定は目安なので、配る前に画像をご確認ください。</p><p>撮影日がない写真はファイル更新日を表示します。圧縮は指定容量以下のJPEG、1 MB = 1,000,000バイト。圧縮しない場合は元ファイルをコピーします。直接フォルダ出力と退避・復元はChrome / Edgeに対応します。</p></div>${actions('')}`);}

function listen(id,event,fn){$(id).addEventListener(event,fn);}
listen('add-person','click',()=>editPerson());
listen('people-list','click',event=>{
  if(state.busy)return;
  const edit=event.target.closest('[data-edit-person]');
  if(edit)return editPerson(state.profiles.find(p=>p.id===edit.dataset.editPerson));
  const person=event.target.closest('[data-person]');if(person){state.activePerson=person.dataset.person;renderPeople();}
});
listen('people-list','keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.target.click();}});
listen('add-reference','click',()=>$('reference-files').click());
listen('reference-files','change',async event=>{const files=[...event.target.files];event.target.value='';await addReferences(files);});
listen('reference-list','click',event=>{const button=event.target.closest('[data-remove-ref]');if(!button||state.busy)return;const person=state.profiles.find(p=>p.id===state.activePerson);URL.revokeObjectURL(person.refs[Number(button.dataset.removeRef)].url);person.refs.splice(Number(button.dataset.removeRef),1);invalidateAnalysis();});
listen('new-event','click',()=>editEvent());
listen('event-list','click',event=>{const button=event.target.closest('[data-event]');if(button)editEvent(state.events.find(e=>e.id===button.dataset.event));});
listen('day-list','click',event=>{const edit=event.target.closest('[data-day-event]');if(edit)return editEvent(eventForDate(edit.dataset.dayEvent,state.events),edit.dataset.dayEvent);const day=event.target.closest('[data-day-filter]');if(day){$('date-filter').value=day.dataset.dayFilter;state.page=0;renderGallery();}});
listen('save-events','click',()=>download(new Blob([JSON.stringify({version:1,events:state.events},null,2)],{type:'application/json'}),'PhotoSorter-events.json'));
listen('load-events','click',()=>$('event-file').click());
listen('event-file','change',async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>2e6)throw new Error('設定ファイルが大きすぎます。');const data=JSON.parse(await file.text());if(!Array.isArray(data.events)||data.events.length>2000)throw new Error('イベント設定の形式が違います。');const events=[];for(const item of data.events)events.push(validateEvent({...item,id:uid()},events));state.events=events;saveEvents();render();notify('イベント設定を読み込みました。');}catch(error){notify(error.message,true);}finally{event.target.value='';}});
for(const id of ['choose-source','empty-import'])listen(id,'click',loadSource);
listen('fallback-source','click',()=>$('source-files').click());
listen('source-files','change',async event=>{await loadFallback(event.target.files);event.target.value='';});
listen('scan-button','click',scan);
listen('reclassify','click',()=>reclassify());
listen('use-faces','change',()=>{invalidateAnalysis();render();});
listen('export-mode','change',()=>reclassify(true));
listen('skip-blur','change',()=>reclassify(true));
for(const id of ['person-filter','date-filter'])listen(id,'change',()=>{state.page=0;renderGallery();});
document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{state.filter=button.dataset.filter;state.page=0;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b===button));renderGallery();});
listen('select-visible','click',()=>{visible().filter(r=>r.analyzed&&!r.error).forEach(r=>r.selected=true);renderGallery();});
listen('clear-visible','click',()=>{visible().forEach(r=>r.selected=false);renderGallery();});
listen('gallery','change',event=>{const id=event.target.dataset.select;if(id){state.records.find(r=>r.id===id).selected=event.target.checked;renderGallery();}});
listen('gallery','click',event=>{const button=event.target.closest('[data-photo]');if(button)photoDialog(state.records.find(r=>r.id===button.dataset.photo));});
listen('prev-page','click',()=>{state.page--;renderGallery();});listen('next-page','click',()=>{state.page++;renderGallery();});
listen('export-folder','click',exportFolder);listen('export-zip','click',exportZip);
listen('quarantine','click',quarantineDialog);listen('restore','click',restore);
listen('cancel','click',()=>{state.controller?.abort();closeDialog();$('progress-detail').textContent='中止しています。完了した出力は残ります。';});
listen('help-button','click',help);
window.addEventListener('beforeunload',event=>{if(state.busy){event.preventDefault();event.returnValue='';}});
render();
