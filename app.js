import {mountFaceEditor} from './face-editor.js?v=2.1.0';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const size=bytes=>Number(bytes)>=1e6?`${(bytes/1e6).toFixed(1)} MB`:`${Math.round(Number(bytes||0)/1000)} KB`;
const HOSTED=location.origin==='https://murajun620-crypto.github.io';
const API_BASE=HOSTED?'http://127.0.0.1:8765':location.origin;
const CONNECTION_KEY='photosorter-pc-session-v1';
const credentials=JSON.parse(sessionStorage.getItem(CONNECTION_KEY)||'{}');
let accessToken=credentials.accessToken||'',bootstrapToken=credentials.bootstrapToken||'',authenticated=false,autoConnect=false,connecting=false;
const PLACEHOLDER='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="100%" height="100%" fill="#e9ece5"/></svg>');
const imageCache=new Map(),imageQueue=[],imagePending=new Set();let imageActive=0;
function saveCredentials(){sessionStorage.setItem(CONNECTION_KEY,JSON.stringify({accessToken,bootstrapToken}));}
function apiURL(path){if(!path.startsWith('/api/'))throw Error('接続先の指定が不正です。');return API_BASE+path;}
function authHeaders(){return accessToken?{Authorization:'Bearer '+accessToken}:{};}
async function privateBlob(kind,id){
  const response=await fetch(apiURL(`/api/${kind}/${encodeURIComponent(id)}`),{headers:authHeaders(),credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('写真を表示できません。PCとの接続と元の写真を確認してください。');return response.blob();
}
function media(kind,id){
  const key=kind+':'+id;
  if(imageCache.has(key))return imageCache.get(key);
  if(authenticated&&!imagePending.has(key)){imagePending.add(key);imageQueue.push({key,kind,id});queueMicrotask(pumpImages);}
  return PLACEHOLDER;
}
function privateImage(kind,id,alt,loading='eager'){return `<img data-private-media="${esc(kind+':'+id)}" src="${media(kind,id)}" alt="${esc(alt)}" loading="${loading}">`;}
async function pumpImages(){
  while(imageActive<4&&imageQueue.length){
    const item=imageQueue.shift();imageActive++;
    (async()=>{
      try{
        const url=URL.createObjectURL(await privateBlob(item.kind,item.id));imageCache.set(item.key,url);
        for(const img of document.querySelectorAll('[data-private-media]'))if(img.dataset.privateMedia===item.key)img.src=url;
        while(imageCache.size>256){const [key,value]=imageCache.entries().next().value;imageCache.delete(key);URL.revokeObjectURL(value);}
      }catch(error){for(const img of document.querySelectorAll('[data-private-media]'))if(img.dataset.privateMedia===item.key)img.title=error.message;}
      finally{imagePending.delete(item.key);imageActive--;pumpImages();}
    })();
  }
}
let data={people:[],photos:[],events:[],settings:{},engine:{},job:{}};
let currentPerson='',filter='all',page=0,enrollMode=false,pending=0,connected=false,pollTimer,refreshing=false;
let activePhotoId=null,detailGeneration=0,detailImage=null,editor=null,editorImage=null,editorPhotoId=null,toastTimer,lastJobKey='',settingsInitialized=false;
const perPage=48;
const busy=()=>pending>0||Boolean(data.job?.running);
const getPhoto=id=>data.photos.find(photo=>photo.id===id);
const getPerson=id=>data.people.find(person=>person.id===id);
const names=ids=>(ids||[]).map(id=>getPerson(id)?.name).filter(Boolean);
const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&!Number.isNaN(Date.parse(`${value}T12:00:00`));

async function api(path,body){
  const response=await fetch(apiURL(path),{method:body===undefined?'GET':'POST',credentials:HOSTED?'omit':'same-origin',cache:'no-store',
    signal:body===undefined||['/api/folder','/api/cancel'].includes(path)?AbortSignal.timeout(15000):undefined,headers:body===undefined?authHeaders():{...authHeaders(),'Content-Type':'application/json','X-PhotoSorter-Local':'1'},body:body===undefined?undefined:JSON.stringify(body)});
  let result;try{result=await response.json();}catch{throw new Error('PC内のプログラムから応答を読み取れませんでした。');}
  if(!response.ok||result.ok===false)throw new Error(result.error||result.message||(response.status===401?'起動用ファイルからアプリを開き直してください。':'処理を完了できませんでした。'));
  if(body!==undefined&&result.job)data.job={...result.job,running:true};
  return result;
}

function toast(message,error=false){
  clearTimeout(toastTimer);$('toast').textContent=message;$('toast').className=`toast${error?' error':''}`;$('toast').hidden=false;
  toastTimer=setTimeout(()=>$('toast').hidden=true,error?12000:6500);
}

function connectionError(message){
  connected=false;autoConnect=false;authenticated=false;$('connect-panel').hidden=false;$('connection-message').textContent=message;$('connection-notice').hidden=false;$('connection-notice').textContent=`PC内のプログラムに接続できません。起動用ファイルから開き直してください。 ${message}`;
  $('save-status').textContent='PCへの接続を確認してください';updateControls();
}

function schedulePoll(){clearTimeout(pollTimer);if(!autoConnect)return;pollTimer=setTimeout(()=>void refresh(),data.job?.running?900:5000);}

async function refresh(){
  if(refreshing||!autoConnect)return;
  refreshing=true;
  try{
    const incoming=await api('/api/state'),wasRunning=Boolean(data.job?.running);
    data=incoming.state||incoming;
    data.people ||= [];data.photos ||= [];data.events ||= [];data.settings ||= {};data.engine ||= {};data.job ||= {};
    connected=true;$('connection-notice').hidden=true;
    if(!data.people.some(person=>person.id===currentPerson))currentPerson=data.people[0]?.id||'';
    render();
    if(wasRunning&&!data.job.running){
      const job=data.job,key=`${job.type}:${job.message}:${job.error}:${JSON.stringify(job.result||{})}`;
      if(lastJobKey!==key){
        lastJobKey=key;
        if(job.error&&job.type!=='folder')toast(job.error,true);
        else if(job.cancelled)toast('処理を中止しました。完了した内容はPCに保存されています。');
        else if(job.type==='export')showExportResult(job.result);
        else if(job.type!=='folder')toast((job.result?.message||'処理が完了し、PCに保存しました。')+(job.result?.errors?.length?` ${job.result.errors.length}件は処理できませんでした。`:''),Boolean(job.result?.errors?.length));
      }
      if(activePhotoId&&$('dialog').open)void renderPhotoDetail(activePhotoId);
    }
  }catch(error){connectionError(error.message);}
  finally{refreshing=false;schedulePoll();}
}

async function refreshFresh(){while(refreshing)await new Promise(resolve=>setTimeout(resolve,20));await refresh();}
async function waitJob(){
  await refreshFresh();
  while(data.job?.running){await new Promise(resolve=>setTimeout(resolve,500));await refreshFresh();if(!connected)throw new Error('PC内の処理状況を確認できません。接続後に結果を確認してください。');}
  if(data.job?.error)throw new Error(data.job.error);
  return data.job?.result||{};
}

async function perform(action,{message='PCに保存しました。',refreshDetail=false}={}){
  if(busy())return;
  pending++;updateControls();$('save-status').textContent='PCで処理しています…';
  try{
    const result=await action();
    await refreshFresh();
    if(message&&!data.job.running)toast(message);
    if(refreshDetail&&activePhotoId&&$('dialog').open)await renderPhotoDetail(activePhotoId);
    return result;
  }catch(error){toast(error.message,true);}
  finally{pending--;updateControls();if(connected)$('save-status').textContent=data.job.running?'処理中・完了分を保存':'PCに保存済み';}
}

function updateControls(){
  const disabled=!connected||busy();
  document.querySelectorAll('[data-mutates],#choose-source,#empty-import,#enter-source,#scan-button,#add-person,#choose-face-photo,#add-event,#export-folder,#select-visible,#clear-visible,#compress,#target-size,#target-unit,#export-mode').forEach(node=>node.disabled=disabled);
  document.querySelectorAll('#photo-form input,#photo-form select,#event-form input,#person-form input,#path-form input').forEach(node=>node.disabled=disabled);
  document.querySelectorAll('[data-close]').forEach(node=>node.disabled=pending>0);
  $('scan-button').disabled=disabled||!data.photos.length;
  $('choose-face-photo').disabled=disabled||!data.photos.length;
  $('export-folder').disabled=disabled||!data.photos.some(photo=>photo.selected&&!photo.error);
  $('select-visible').disabled=disabled||!visible().length;$('clear-visible').disabled=disabled||!visible().length;
  $('cancel-job').disabled=!data.job.running;
  const job=data.job||{};$('progress-dock').hidden=!job.running;
  if(job.running){
    const titles={folder:'Windowsのフォルダ選択を待っています',register:'人物と顔をPCに登録しています',initialize:'GPUを準備しています',import:'写真を読み込んでいます',analyze:'GPUで写真を解析しています',export:'写真を出力しています'};
    $('progress-title').textContent=titles[job.type]||'PCで処理しています';$('progress-detail').textContent=job.message||'';
    if(job.total>0)$('progress-bar').value=job.done/job.total*100;else $('progress-bar').removeAttribute('value');
  }
}

function filtered(){
  const person=$('person-filter').value,date=$('date-filter').value;
  return data.photos.filter(photo=>(filter==='all'||filter==='selected'&&photo.selected||filter==='review'&&photo.needsReview||filter==='unanalysed'&&!photo.analyzed||filter==='blur'&&(photo.blurLabel==='blur'||photo.blurry))&&(!person||photo.matchedIds?.includes(person))&&(!date||photo.date===date));
}
function visible(){return filtered().slice(page*perPage,(page+1)*perPage);}

function renderPeople(){
  $('people-list').innerHTML=data.people.length?data.people.map(person=>`<button class="person ${person.id===currentPerson?'active':''}" data-person="${esc(person.id)}"><span class="avatar">${esc(person.name.slice(0,1))}</span><span class="person-label">${esc(person.name)}<small>登録 ${person.referenceCount??0}件 · NG ${person.negativeCount??0}件</small></span></button>`).join(''):'<p class="hint">写真から顔を登録すると、ここに人物が並びます。</p>';
  const value=$('person-filter').value;
  $('person-filter').innerHTML='<option value="">すべての人物</option>'+data.people.map(person=>`<option value="${esc(person.id)}">${esc(person.name)}</option>`).join('');
  $('person-filter').value=data.people.some(person=>person.id===value)?value:'';
}

function renderEvents(){
  $('event-list').innerHTML=data.events.length?data.events.map(event=>`<div class="event-chip"><div><strong>${esc(event.name)}</strong><small>${esc(event.start)}${event.end!==event.start?` 〜 ${esc(event.end)}`:''}</small></div><button class="tiny-button" data-event="${esc(event.id)}" data-mutates>編集</button></div>`).join(''):'<p class="hint">イベントを追加すると、期間内の写真をまとめて出力できます。</p>';
  const days=[...new Set(data.photos.map(photo=>photo.date).filter(Boolean))].sort(),value=$('date-filter').value;
  $('date-filter').innerHTML='<option value="">すべての日付</option>'+days.map(day=>`<option value="${esc(day)}">${esc(day)}</option>`).join('');$('date-filter').value=days.includes(value)?value:'';
  $('day-list').innerHTML=days.map(day=>{const count=data.photos.filter(photo=>photo.date===day).length,event=data.events.find(item=>day>=item.start&&day<=item.end);return `<div class="day-row"><button data-day="${esc(day)}">${esc(day)} <span>(${count}枚)</span></button><button class="tiny-button" data-day-event="${esc(day)}" data-mutates>${event?esc(event.name):'＋ 名前を付ける'}</button></div>`;}).join('');
}

function renderGallery(){
  const all=filtered(),pages=Math.max(1,Math.ceil(all.length/perPage));page=Math.min(page,pages-1);
  $('gallery').innerHTML=visible().map(photo=>{
    const people=names(photo.matchedIds),tags=people.length?people.map(name=>`<span class="person-tag">${esc(name)}</span>`).join(''):`<span class="person-tag neutral">${photo.error?'読み込みエラー':!photo.analyzed?'未解析':'人物未分類'}</span>`;
    return `<article class="photo-card ${photo.selected?'selected':''}"><button class="photo-image" data-photo="${esc(photo.id)}" aria-label="${esc(photo.name)}を確認">${privateImage('thumb',photo.id,photo.name,'lazy')}</button><label class="card-checkbox"><input type="checkbox" data-select="${esc(photo.id)}" ${photo.selected?'checked':''} ${busy()||photo.error?'disabled':''} aria-label="${esc(photo.name)}を出力対象に"></label><div class="card-flags">${photo.needsReview?'<span class="review-badge">要確認</span>':''}${photo.blurLabel==='blur'?'<span class="blur-badge">ボケ指定</span>':''}</div><div class="card-info"><div class="card-name" title="${esc(photo.relative||photo.name)}">${esc(photo.name)}</div><div class="card-meta"><span>${esc(photo.date||'日付不明')}</span><span>${photo.size?size(photo.size):`${photo.faces?.length||0}人の顔`}</span></div><div class="card-people">${tags}</div><button class="review-link" data-photo="${esc(photo.id)}">顔を確認・修正 →</button></div></article>`;
  }).join('')||(data.photos.length?'<p class="filter-empty">この条件の写真はありません。</p>':'');
  $('empty-state').hidden=data.photos.length>0;$('visible-count').textContent=`${all.length}枚を表示対象`;
  $('page-label').textContent=`${page+1} / ${pages}`;$('prev-page').disabled=page<=0;$('next-page').disabled=page>=pages-1;
  $('total-count').textContent=data.photos.length;$('selected-count').textContent=data.photos.filter(photo=>photo.selected&&!photo.error).length;
  $('review-count').textContent=data.photos.filter(photo=>photo.needsReview).length;$('person-count').textContent=data.people.length;
  $('enroll-notice').hidden=!enrollMode;
}

function render(){
  $('app-version').textContent=`v${data.appVersion||'2.1.0'}`;
  const engine=data.engine,gpu=engine.gpuName||engine.device||'';
  $('gpu-status').textContent=engine.error?'GPUの確認が必要':engine.ready?`GPU · ${gpu||engine.provider||'接続済み'}`:'GPUを準備中';
  $('gpu-status').classList.toggle('error',Boolean(engine.error));$('gpu-status').title=gpu;
  $('engine-notice').hidden=!engine.error;$('engine-notice').textContent=engine.error||'';
  if(!pending)$('save-status').textContent=data.job.running?'処理中・完了分を保存':'PCに保存済み';
  $('source-name').textContent=data.sourcePath||data.settings.sourcePath||data.sourceName||(data.photos.length?'保存された写真ライブラリ':'写真フォルダを選んでください');
  $('source-meta').textContent=`${data.photos.length}枚 · 人物登録とOK／NGは次回起動時も復元します`;
  $('storage-location').textContent=data.dataDirectory?`保存先：${data.dataDirectory}`:'';
  if(!settingsInitialized){
    const target=data.settings.targetBytes;$('compress').checked=target!==null;
    if(Number(target)>0){$('target-unit').value=target>=1e6?'MB':'KB';$('target-size').value=String(target/(target>=1e6?1e6:1000));}
    $('export-mode').value=['people','any','all'].includes(data.settings.exportMode)?data.settings.exportMode:'people';settingsInitialized=true;
  }
  renderPeople();renderEvents();renderGallery();updateControls();
}

function closeDialog(){
  if(pending)return;
  detailGeneration++;activePhotoId=null;detailImage=null;$('dialog').close();$('dialog-content').replaceChildren();
}
function showDialog(html){
  detailGeneration++;activePhotoId=null;detailImage=null;$('dialog-content').innerHTML=html;if(!$('dialog').open)$('dialog').showModal();
}
const dialogActions=primary=>`<div class="dialog-actions"><button type="button" class="outline-button" data-close>閉じる</button>${primary||''}</div>`;

async function pickSource(){if(!busy())await openFolder('source');}

async function openFolder(purpose){
  if(busy())return;
  const output=purpose==='output';let generation=0,selectedPath='';
  showDialog(`<div class="dialog-body folder-browser"><h2>${output?'出力先フォルダを選ぶ':'写真フォルダを選ぶ'}</h2><p>このPC内のフォルダを開いて選びます。場所を直接入力することもできます。</p><form id="folder-path-form" class="folder-path-row"><input id="folder-browser-path" class="path-input" aria-label="フォルダの場所" autocomplete="off"><button class="outline-button" type="submit">表示</button></form><div id="folder-drives" class="folder-drives"></div><button id="folder-parent" class="text-button" type="button">↑ ひとつ上へ</button><p id="folder-list-status" role="status">フォルダを表示しています…</p><div id="folder-list" class="folder-list"></div></div><div class="dialog-actions"><button class="outline-button" type="button" data-close>閉じる</button><button id="use-folder" class="primary-button" type="button" disabled>${output?'ここへ出力':'このフォルダを読み込む'}</button></div>`);
  const container=$('folder-list'),pathInput=$('folder-browser-path'),status=$('folder-list-status'),use=$('use-folder');
  async function load(path){
    const task=++generation;status.textContent='フォルダを表示しています…';container.replaceChildren();use.disabled=true;
    try{
      const result=await api('/api/folders'+(path?'?path='+encodeURIComponent(path):''));
      if(task!==generation||!container.isConnected)return;
      selectedPath=result.path;pathInput.value=result.path;use.disabled=false;
      $('folder-parent').disabled=!result.parent;$('folder-parent').onclick=()=>void load(result.parent);
      $('folder-drives').innerHTML=result.drives.map(drive=>`<button type="button" class="outline-button" data-folder-path="${esc(drive.path)}">${esc(drive.name)}</button>`).join('');
      container.innerHTML=result.folders.map(folder=>`<button type="button" class="folder-entry" data-folder-path="${esc(folder.path)}"><span>▱</span> ${esc(folder.name)} <span>›</span></button>`).join('');
      status.textContent=result.folders.length?`${result.folders.length}個のサブフォルダ。下のボタンで現在のフォルダを選べます。`:'サブフォルダはありません。下のボタンでこのフォルダを選べます。';
    }catch(error){if(task===generation&&container.isConnected){status.textContent=error.message+' 場所を入力して「表示」を押すか、閉じて別のフォルダを選んでください。';use.disabled=true;}}
  }
  function navigate(event){const button=event.target.closest('[data-folder-path]');if(button)void load(button.dataset.folderPath);}
  $('folder-drives').onclick=navigate;container.onclick=navigate;
  $('folder-path-form').onsubmit=event=>{event.preventDefault();void load(pathInput.value.trim());};
  pathInput.oninput=()=>{use.disabled=pathInput.value.trim()!==selectedPath;};
  use.onclick=()=>{
    const path=selectedPath;generation++;closeDialog();
    void perform(async()=>{
      if(!output)return api('/api/import',{path});
      const settings=outputOptions();await api('/api/settings',settings);
      return api('/api/export',{path,ids:data.photos.filter(photo=>photo.selected&&!photo.error).map(photo=>photo.id),targetBytes:settings.targetBytes,groupMode:settings.exportMode,allowResize:true});
    },{message:null});
  };
  await load();
}

function enterSource(purpose='source'){
  const output=purpose==='output';
  showDialog(`<form id="path-form"><div class="dialog-body"><h2>${output?'出力先フォルダを指定':'写真フォルダを指定'}</h2><p>${output?'このPC内の出力先フォルダを指定します。':'このPC上のJPEG・PNGを読み込みます。サブフォルダも対象です。'}</p><label class="dialog-field">フォルダの場所<input id="source-path" class="path-input" required placeholder="C:\\Users\\…\\Pictures" autocomplete="off"></label></div>${dialogActions(`<button type="submit" class="primary-button" data-mutates>${output?'出力する':'読み込む'}</button>`)}</form>`);
  $('path-form').onsubmit=event=>{
    event.preventDefault();const path=$('source-path').value.trim();closeDialog();
    void perform(()=>output?api('/api/export',{path,...outputOptions(),groupMode:outputOptions().exportMode,ids:data.photos.filter(photo=>photo.selected&&!photo.error).map(photo=>photo.id)}):api('/api/import',{path}),{message:null});
  };$('source-path').focus();
}

function addPerson(){
  showDialog(`<form id="person-form"><div class="dialog-body"><h2>人物の名前を追加</h2><p>追加後、写真を開いてその人の顔を登録してください。</p><label class="dialog-field">名前<input id="person-name" required maxlength="60" placeholder="例：はると"></label></div>${dialogActions('<button type="submit" class="primary-button" data-mutates>名前を保存</button>')}</form>`);
  $('person-form').onsubmit=async event=>{event.preventDefault();const name=$('person-name').value.trim();closeDialog();const result=await perform(()=>api('/api/people',{name}));if(result)currentPerson=result.person?.id||data.people.find(person=>person.name===name)?.id||currentPerson;renderPeople();};$('person-name').focus();
}

function editEvent(existing=null,day=''){
  const start=existing?.start||day||data.photos.find(photo=>validDate(photo.date))?.date||new Date().toISOString().slice(0,10),end=existing?.end||start;
  showDialog(`<form id="event-form"><div class="dialog-body"><h2>${existing?'イベントを編集':'イベントを追加'}</h2><label class="dialog-field">イベント名<input id="event-name" required maxlength="70" value="${esc(existing?.name||'')}" placeholder="例：夏休みの家族旅行"></label><div class="date-pair"><label class="dialog-field">開始日<input type="date" id="event-start" value="${start}" required></label><label class="dialog-field">終了日<input type="date" id="event-end" value="${end}" required></label></div><p class="hint">1日だけの場合は開始日と終了日を同じ日にします。</p></div><div class="dialog-actions">${existing?'<button type="button" id="delete-event" class="text-button danger" data-mutates>このイベントを削除</button>':''}<button type="button" class="outline-button" data-close>閉じる</button><button type="submit" class="primary-button" data-mutates>保存</button></div></form>`);
  $('event-form').onsubmit=async event=>{event.preventDefault();const value={id:existing?.id,name:$('event-name').value.trim(),start:$('event-start').value,end:$('event-end').value};if(value.start>value.end)return toast('終了日は開始日以降にしてください。',true);const result=await perform(()=>api('/api/events',value));if(result)closeDialog();};
  if($('delete-event'))$('delete-event').onclick=async()=>{const result=await perform(()=>api('/api/events',{id:existing.id,delete:true}));if(result)closeDialog();};
}

async function loadImage(id){
  const url=URL.createObjectURL(await privateBlob('image',id));
  try{return await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('写真を表示できません。'));image.src=url;});}
  finally{URL.revokeObjectURL(url);}
}

function drawScene(canvas,image,faces){
  const scale=Math.min(1,1100/image.naturalWidth,620/image.naturalHeight);canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
  const context=canvas.getContext('2d');context.drawImage(image,0,0,canvas.width,canvas.height);
  faces.forEach((face,index)=>{const box=face.box;if(!box)return;const x=box.x*scale,y=box.y*scale,w=box.width*scale,h=box.height*scale;context.lineWidth=3;context.strokeStyle='#d47b2f';context.strokeRect(x,y,w,h);const top=Math.max(0,y-22);context.fillStyle='#874713';context.fillRect(x,top,28,22);context.fillStyle='#fff';context.font='bold 16px sans-serif';context.fillText(String(index+1),x+6,top+17);});
}

async function openPhoto(id){
  if(enrollMode){enrollMode=false;renderGallery();return openEnrollment(id);}
  showDialog('');activePhotoId=id;await renderPhotoDetail(id);
}

async function renderPhotoDetail(id){
  const photo=getPhoto(id);if(!photo)return;
  const generation=++detailGeneration;activePhotoId=id;
  $('dialog-content').innerHTML=`<form id="photo-form"><div class="dialog-body"><h2 class="photo-detail-title">${esc(photo.name)}</h2><div class="local-photo-stage"><canvas id="photo-scene" aria-label="写真内の顔を番号付きで表示"></canvas></div><div class="local-photo-actions"><button type="button" id="register-from-photo" class="outline-button" data-mutates>顔を選んで人物を登録</button>${!photo.analyzed?'<button type="button" id="analyze-photo" class="primary-button" data-mutates>この写真を解析</button>':''}</div><p class="detail-info">${esc(photo.relative||photo.name)}<br>${esc(photo.dateSource||'')} ${photo.error?`<br>${esc(photo.error)}`:''}</p><h3 class="detail-heading">顔ごとに確認・修正</h3><p class="hint">合っていればOK。違っていればNG、または正しい人物名を選んでOK。修正はすぐに保存され、ほかの写真の判定にも使います。</p><div class="face-answer-list" id="face-answer-list"></div><p id="photo-answer-status" class="photo-answer-status" role="status"></p><label class="dialog-field">分類する日付<input id="photo-date" type="date" value="${validDate(photo.date)?photo.date:''}"></label><label class="dialog-field">写真の鮮明さ<select id="photo-blur"><option value="">指定しない</option><option value="sharp" ${photo.blurLabel==='sharp'?'selected':''}>鮮明な写真</option><option value="blur" ${photo.blurLabel==='blur'?'selected':''}>ボケた写真</option></select></label><details><summary>写っている人物を写真全体に手動指定</summary><p class="hint">顔が見つからない人物にも使えます。顔のOK／NGでは訂正した人物だけ更新します。</p><div class="detail-pills">${data.people.map(person=>`<label><input type="checkbox" name="photo-person" value="${esc(person.id)}" ${photo.matchedIds?.includes(person.id)?'checked':''}>${esc(person.name)}</label>`).join('')}</div></details><label class="check-line"><input type="checkbox" id="photo-selected" ${photo.selected?'checked':''}> この写真を出力対象にする</label><p class="persist-caption">人物登録・OK／NG・写真の設定は、次回起動時も復元します。</p></div>${dialogActions('<button type="submit" class="primary-button" data-mutates>写真の設定を保存して閉じる</button>')}</form>`;
  paintFaceAnswers(photo);
  let peopleChanged=false;
  $('photo-form').querySelectorAll('[name=photo-person]').forEach(node=>node.onchange=()=>peopleChanged=true);
  $('register-from-photo').onclick=()=>{closeDialog();void openEnrollment(id);};
  if($('analyze-photo'))$('analyze-photo').onclick=()=>void perform(()=>api('/api/analyze',{ids:[id]}),{message:null});
  $('photo-form').onsubmit=async event=>{event.preventDefault();const fields={id,date:$('photo-date').value,selected:$('photo-selected').checked,blurLabel:$('photo-blur').value||null};if(fields.date&&!validDate(fields.date))return toast('日付を正しく指定してください。',true);if(peopleChanged)fields.manualPeople=[...$('photo-form').querySelectorAll('[name=photo-person]:checked')].map(node=>node.value);const result=await perform(()=>api('/api/photo',fields));if(result)closeDialog();};
  $('face-answer-list').onclick=async event=>{
    const button=event.target.closest('[data-decision]');if(!button||busy())return;
    const card=button.closest('[data-face-id]'),faceId=card.dataset.faceId,personId=card.querySelector('select').value;
    if(!personId)return toast('この顔の人物を選んでください。',true);
    const draftDate=$('photo-date').value,draftBlur=$('photo-blur').value,draftSelected=$('photo-selected').checked;
    const selectedChanged=draftSelected!==Boolean(getPhoto(id)?.selected),manualPeople=peopleChanged?[...$('photo-form').querySelectorAll('[name=photo-person]:checked')].map(node=>node.value):null;
    const result=await perform(async()=>{
      if(peopleChanged||selectedChanged){await api('/api/photo',{id,...(peopleChanged?{manualPeople}:{}),...(selectedChanged?{selected:draftSelected}:{})});peopleChanged=false;}
      return api('/api/feedback',{faceId,personId,decision:button.dataset.decision});
    },{message:'訂正をPCに保存し、人物の分類に反映しました。'});
    if(result&&activePhotoId===id&&$('dialog').open){
      const live=getPhoto(id);paintFaceAnswers(live);$('photo-answer-status').textContent='訂正を保存しました。次回もこの回答を使います。';
      $('photo-date').value=draftDate;$('photo-blur').value=draftBlur;$('photo-selected').checked=live.selected;
      $('photo-form').querySelectorAll('[name=photo-person]').forEach(node=>node.checked=live.matchedIds?.includes(node.value));updateControls();
    }
  };
  updateControls();
  try{const image=detailImage?.photoId===id?detailImage.image:await loadImage(id);if(generation!==detailGeneration||activePhotoId!==id)return;detailImage={photoId:id,image};drawScene($('photo-scene'),image,photo.faces||[]);}catch(error){if(generation===detailGeneration)$('photo-answer-status').textContent=error.message;}
}

function paintFaceAnswers(photo){
  if(!$('face-answer-list'))return;
  $('face-answer-list').innerHTML=photo.faces?.length?photo.faces.map((face,index)=>{
    const matched=getPerson(face.personId),choice=face.personId||face.candidateIds?.[0]||currentPerson;
    const feedback=Object.entries(face.feedback||{}).map(([id,decision])=>getPerson(id)?`${getPerson(id).name}：${decision==='ok'?'OK・本人':'NG・別人'}`:'').filter(Boolean).join(' / ');
    return `<article class="face-answer" data-face-id="${esc(face.id)}">${privateImage('face',face.id,`顔 ${index+1}`)}<div class="face-answer-body"><strong>顔 ${index+1} · ${matched?esc(matched.name):'未確定'}</strong><p class="face-answer-label">${matched?'この人物として分類しています。':face.candidateIds?.length?'候補を確認してください。':'名前を選んで登録できます。'}</p><select aria-label="顔 ${index+1}の人物"><option value="">人物を選ぶ</option>${data.people.map(person=>`<option value="${esc(person.id)}" ${person.id===choice?'selected':''}>${esc(person.name)}</option>`).join('')}</select><div class="face-answer-actions"><button type="button" class="primary-button" data-decision="ok" data-mutates>OK・本人</button><button type="button" class="outline-button danger" data-decision="ng" data-mutates>NG・別人</button></div><p class="saved-answer">${esc(feedback||'未確認')}</p></div></article>`;
  }).join(''):`<p class="face-empty">${photo.analyzed?'顔が見つかりませんでした。「顔を選んで人物を登録」から手動で囲めます。':'「この写真を解析」で顔を探すか、「顔を選んで人物を登録」から囲んで指定してください。'}</p>`;
}

async function openEnrollment(id){
  if(busy())return;
  let photo=getPhoto(id);if(!photo)return;
  closeDialog();editorPhotoId=id;$('face-editor-content').innerHTML='<div class="face-editor"><h2>写真を読み込んでいます…</h2></div>';$('face-editor-dialog').showModal();
  try{
    if(!photo.analyzed){
      pending++;updateControls();
      try{await api('/api/analyze',{ids:[id]});await waitJob();photo=getPhoto(id);}
      finally{pending--;updateControls();}
    }
    const image=await loadImage(id);if(editorPhotoId!==id||!$('face-editor-dialog').open)return;
    const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0);editorImage=canvas;
    $('face-editor-content').replaceChildren();
    editor=mountFaceEditor({container:$('face-editor-content'),canvas,faces:photo.faces||[],profiles:data.people,activePersonId:currentPerson,
      onClose:closeEnrollment,onError:error=>toast(error.message,true),
      async onRegister({personId,name,face,region}){
        if(data.job.running)throw new Error('解析が終わってから登録してください。');
        pending++;updateControls();$('save-status').textContent='人物をPCに保存しています…';
        try{
          const result=await api('/api/register',{photoId:id,personId:personId||undefined,name:personId?undefined:name,faceId:face?.id,region:face?.id?undefined:region});
          const completed=await waitJob();const savedPerson=completed.personId||completed.person?.id||result.personId||result.person?.id||personId||data.people.find(person=>person.name===name)?.id;currentPerson=savedPerson||currentPerson;
          return {profiles:data.people,personId:savedPerson,message:'顔を登録してPCに保存しました。別の人物も続けて登録できます。'};
        }finally{pending--;updateControls();$('save-status').textContent='PCに保存済み';}
      }});
    if(!photo.analyzed){
      const note=document.createElement('p');note.className='hint';note.textContent='まだ解析していない写真です。顔を手動で囲んで登録できます。自動検出する場合は一度閉じて「この写真を解析」を押してください。';$('face-editor-content').prepend(note);
    }
  }catch(error){if($('face-editor-dialog').open)$('face-editor-content').innerHTML=`<div class="dialog-body"><h2>写真を表示できません</h2><p>${esc(error.message)}</p><button class="outline-button" id="close-enroll-error">閉じる</button></div>`;if($('close-enroll-error'))$('close-enroll-error').onclick=closeEnrollment;}
}

function closeEnrollment(){
  if(pending)return;
  editorPhotoId=null;editor?.destroy();editor=null;if(editorImage){editorImage.width=editorImage.height=1;editorImage=null;}$('face-editor-content').replaceChildren();$('face-editor-dialog').close();
}

function outputOptions(){
  let targetBytes=null;
  if($('compress').checked){targetBytes=Math.floor(Number($('target-size').value)*($('target-unit').value==='MB'?1e6:1000));if(!Number.isSafeInteger(targetBytes)||targetBytes<10000||targetBytes>1e9)throw new Error('1枚の容量は10 KB〜1000 MBで指定してください。');}
  return {targetBytes,exportMode:$('export-mode').value,allowResize:true};
}
async function saveSettings(){
  let settings;try{settings=outputOptions();}catch(error){return toast(error.message,true);}
  await perform(()=>api('/api/settings',settings),{message:null});
}
async function exportFolder(){if(!busy())await openFolder('output');}

function showExportResult(result={}){
  if(activePhotoId||$('face-editor-dialog').open){toast('出力が完了しました。選んだ保存先フォルダを確認してください。');return;}
  showDialog(`<div class="dialog-body"><h2>写真を出力しました</h2><p>${Number(result.count??result.exported??result.written??result.files?.length??0)}枚を保存しました。</p>${result.path||result.folder?`<p class="local-result-path">${esc(result.path||result.folder)}</p>`:''}${result.errors?.length?`<h3>保存できなかった写真</h3><ul class="job-errors">${result.errors.map(error=>`<li>${esc(typeof error==='string'?error:error.message||JSON.stringify(error))}</li>`).join('')}</ul>`:''}<p class="hint">元の写真は変更していません。</p></div>${dialogActions('')}`);
}

function help(){
  showDialog(`<div class="dialog-body"><h2>写真を選び、その場で判定を直す。</h2><ol class="help-list"><li><strong>写真フォルダを開く</strong>。このPCの写真を読み込みます。</li><li>写真を開き、<strong>顔を選んで人物を登録</strong>。未解析の写真は<strong>この写真を解析</strong>で顔を探せます。顔が見つからなければ四角で囲んで指定します。</li><li><strong>写真を解析</strong>でまとめて人物を分類します。写真を開き、顔ごとの<strong>OK・本人／NG・別人</strong>で修正します。正しい名前を選んでOKにすると、その人へ訂正できます。</li><li>必要に応じて日付・イベント・容量を設定し、<strong>フォルダへ出力</strong>します。集合写真は各人のフォルダにコピーします。</li></ol><p>人物登録・OK／NG・イベントはPCに自動保存し、次回起動時も復元します。ブラウザの画面を閉じても登録は残ります。写真と顔の解析結果を外部サービスへ送信しません。</p><p>GPUが利用できない場合は画面に理由を表示します。認識のための機械学習処理はPC内のプログラムで行います。</p><p class="status-details">${esc(data.engine.gpuName||'')}<br>${esc(data.engine.provider||'')}<br>${esc(data.engine.engineId||'')}</p></div>${dialogActions('')}`);
}

for(const id of ['choose-source','empty-import'])$(id).onclick=()=>void pickSource();
$('enter-source').onclick=()=>enterSource();$('add-person').onclick=addPerson;$('add-event').onclick=()=>editEvent();
$('choose-face-photo').onclick=()=>{enrollMode=true;filter='all';page=0;$('person-filter').value='';$('date-filter').value='';document.querySelectorAll('[data-filter]').forEach(button=>button.classList.toggle('active',button.dataset.filter==='all'));renderGallery();$('gallery').scrollIntoView({behavior:'smooth',block:'start'});};
$('cancel-enroll').onclick=()=>{enrollMode=false;renderGallery();};
$('people-list').onclick=event=>{const person=event.target.closest('[data-person]');if(person){currentPerson=person.dataset.person;renderPeople();}};
$('scan-button').onclick=()=>void perform(()=>api('/api/analyze',{}),{message:null});
$('event-list').onclick=event=>{const button=event.target.closest('[data-event]');if(button&&!busy())editEvent(data.events.find(item=>item.id===button.dataset.event));};
$('day-list').onclick=event=>{const add=event.target.closest('[data-day-event]');if(add&&!busy()){const day=add.dataset.dayEvent;return editEvent(data.events.find(item=>day>=item.start&&day<=item.end),day);}const day=event.target.closest('[data-day]');if(day){$('date-filter').value=day.dataset.day;page=0;renderGallery();}};
$('gallery').onclick=event=>{const button=event.target.closest('[data-photo]');if(button)void openPhoto(button.dataset.photo);};
$('gallery').onchange=event=>{const id=event.target.dataset.select;if(id){const selected=event.target.checked;void perform(()=>api('/api/photo',{id,selected}),{message:null});}};
for(const id of ['person-filter','date-filter'])$(id).onchange=()=>{page=0;renderGallery();};
document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.filter;page=0;document.querySelectorAll('[data-filter]').forEach(node=>node.classList.toggle('active',node===button));renderGallery();});
for(const [id,selected] of [['select-visible',true],['clear-visible',false]])$(id).onclick=()=>void perform(async()=>{for(const photo of visible())if(!photo.error)await api('/api/photo',{id:photo.id,selected});},{message:null});
$('prev-page').onclick=()=>{page--;renderGallery();};$('next-page').onclick=()=>{page++;renderGallery();};
for(const id of ['compress','target-size','target-unit','export-mode'])$(id).onchange=()=>void saveSettings();
$('export-folder').onclick=()=>void exportFolder();
$('cancel-job').onclick=async()=>{try{await api('/api/cancel',{});await refresh();}catch(error){toast(error.message,true);}};
$('help-button').onclick=help;
$('shutdown-button').onclick=async()=>{
  if(busy())return;
  try{await api('/api/shutdown',{});clearTimeout(pollTimer);connected=false;updateControls();$('save-status').textContent='保存して終了しました';$('connection-notice').hidden=false;$('connection-notice').textContent='PC内のプログラムを終了しました。このタブを閉じてください。次回は起動用ファイルから開くと人物登録とOK／NGが復元します。';}
  catch(error){toast(error.message,true);}
};
$('dialog').onclick=event=>{if(event.target.closest('[data-close]'))closeDialog();};
$('dialog').addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
$('face-editor-dialog').addEventListener('cancel',event=>{event.preventDefault();closeEnrollment();});
window.addEventListener('beforeunload',event=>{if(pending){event.preventDefault();event.returnValue='';}});

async function connect(){
  if(connecting)return;connecting=true;$('connect-pc').disabled=true;
  $('connection-message').textContent='PC内の認識プログラムに接続しています…';
  try{
    if(bootstrapToken){const session=await api('/api/session',{token:bootstrapToken});accessToken=session.accessToken;bootstrapToken='';saveCredentials();}
    if(!accessToken){$('connection-message').textContent='PC側のStart-PhotoSorter.cmdを起動してください。認証付きでこの画面が開きます。';return;}
    authenticated=true;autoConnect=true;await refresh();
    if(connected){$('connect-panel').hidden=true;$('connection-notice').hidden=true;}
  }catch(error){connectionError('接続できません。PC側を起動し、ブラウザのローカル接続を許可してから再試行してください。 '+error.message);}
  finally{connecting=false;$('connect-pc').disabled=false;}
}
$('connect-pc').onclick=()=>void connect();
async function start(){
  try{
    const fragment=new URLSearchParams(location.hash.slice(1)),token=fragment.get('token');
    history.replaceState(null,'',location.pathname+location.search);
    if(token){bootstrapToken=token;accessToken='';saveCredentials();}
    if(!HOSTED){await connect();return;}
    $('connect-panel').hidden=false;
    if(!bootstrapToken&&!accessToken){$('connection-message').textContent='PC側のStart-PhotoSorter.cmdを起動すると、この画面に接続できます。';return;}
    let permission='prompt';
    for(const name of ['loopback-network','local-network-access']){
      try{permission=(await navigator.permissions.query({name})).state;break;}catch{}
    }
    if(permission==='granted')await connect();
    else $('connection-message').textContent=permission==='denied'?'ブラウザのサイト設定でローカル接続を許可し、「PCに接続する」を押してください。':'「PCに接続する」を押し、ローカル接続の許可が表示されたら許可してください。写真はこのPCとの間だけで扱います。';
  }catch(error){connectionError(error.message);}
}
void start();
