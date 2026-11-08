import {mountFaceEditor} from './face-editor.js?v=2.7.0';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const size=bytes=>Number(bytes)>=1e6?`${(bytes/1e6).toFixed(1)} MB`:`${Math.round(Number(bytes||0)/1000)} KB`;
const HOSTED=location.origin==='https://murajun620-crypto.github.io';
const UI_VERSION='2.7.0';
const DEFAULT_TEAM_ID='team-default';
const PUBLIC_VERSION_URL='https://murajun620-crypto.github.io/photo_sorter_web/version.json';
const API_BASE=HOSTED?'http://127.0.0.1:8765':location.origin;
const CONNECTION_KEY='photosorter-pc-session-v1';
const credentials=JSON.parse(localStorage.getItem(CONNECTION_KEY)||sessionStorage.getItem(CONNECTION_KEY)||'{}');
let accessToken=credentials.accessToken||'',bootstrapToken=credentials.bootstrapToken||'',authenticated=false,autoConnect=false,connecting=false;
const PLACEHOLDER='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="100%" height="100%" fill="#e9ece5"/></svg>');
const imageCache=new Map(),imageQueue=[],imagePending=new Set();let imageActive=0;
let imageController=new AbortController(),imagesPaused=false;
function saveCredentials(){localStorage.setItem(CONNECTION_KEY,JSON.stringify({accessToken,bootstrapToken}));sessionStorage.setItem(CONNECTION_KEY,JSON.stringify({accessToken,bootstrapToken}));}
function apiURL(path){if(!path.startsWith('/api/'))throw Error('接続先の指定が不正です。');return API_BASE+path;}
function authHeaders(projectId=data.currentProject?.id){return {...(accessToken?{Authorization:'Bearer '+accessToken}:{}),...(projectId?{'X-PhotoSorter-Project':projectId}:{})};}
async function privateBlob(kind,id,projectId=data.currentProject?.id){
  const response=await fetch(apiURL(`/api/${kind}/${encodeURIComponent(id)}`),{headers:authHeaders(projectId),credentials:'omit',cache:'no-store',signal:AbortSignal.any([AbortSignal.timeout(20000),imageController.signal])});
  if(!response.ok)throw Error('写真を表示できません。PCとの接続と元の写真を確認してください。');return response.blob();
}
function media(kind,id){
  const key=(data.currentProject?.id||'')+':'+kind+':'+id;
  if(imageCache.has(key))return imageCache.get(key);
  if(authenticated&&!imagesPaused&&!imagePending.has(key)){imagePending.add(key);imageQueue.push({key,kind,id,projectId:data.currentProject?.id});queueMicrotask(pumpImages);}
  return PLACEHOLDER;
}
function privateImage(kind,id,alt,loading='eager'){return `<img data-private-media="${esc((data.currentProject?.id||'')+':'+kind+':'+id)}" src="${media(kind,id)}" alt="${esc(alt)}" loading="${loading}">`;}
async function pumpImages(){
  if(imagesPaused)return;
  while(imageActive<4&&imageQueue.length){
    const item=imageQueue.shift();imageActive++;
    (async()=>{
      try{
        const url=URL.createObjectURL(await privateBlob(item.kind,item.id,item.projectId));imageCache.set(item.key,url);
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
let checkingUpdate=false;
let activeGame='',uniformEnroll=null;
let sharedKit='';const timeLoads=new Set();
const perPage=48;
const UNCLASSIFIED='__unclassified__';
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
    const incoming=await api('/api/state'),wasRunning=Boolean(data.job?.running),previousProject=data.currentProject?.id;
    data=incoming.state||incoming;
    data.people ||= [];data.photos ||= [];data.events ||= [];data.settings ||= {};data.engine ||= {};data.job ||= {};
    data.jerseyGames ||= [];data.jerseyUniforms ||= [];data.jerseyRoster ||= [];
    data.sharedUniforms ||= [];data.jerseyGameKits ||= [];
    data.sharedRoster ||= [];
    data.sharedTeams ||= [];
    data.jerseySetup ||= [];
    if(previousProject&&previousProject!==data.currentProject?.id)resetProjectView();
    connected=true;$('connection-notice').hidden=true;
    if(!data.people.some(person=>person.id===currentPerson))currentPerson=data.people[0]?.id||'';
    render();
    if(wasRunning&&!data.job.running){
      const job=data.job,key=`${job.id||''}:${job.type}:${job.message}:${job.error}:${JSON.stringify(job.result||{})}`;
      if(lastJobKey!==key){
        lastJobKey=key;
        if(job.error&&job.type!=='folder')toast(job.error,true);
        else if(job.cancelled)toast('処理を中止しました。完了した内容はPCに保存されています。');
        else if(job.type==='export')showExportResult(job.result);
        else if(job.type==='infer')showInferredGames(job.result);
        else if(job.type==='analyze'&&job.result?.warnings?.length)showAnalysisNotice(job.result);
        else if(job.type!=='folder')toast((job.result?.message||'処理が完了し、PCに保存しました。')+(job.result?.errors?.length?` ${job.result.errors.length}件は処理できませんでした。`:''),Boolean(job.result?.errors?.length));
      }
      if(activePhotoId&&$('dialog').open)void renderPhotoDetail(activePhotoId);
    }
  }catch(error){connectionError(error.message);}
  finally{refreshing=false;schedulePoll();const key=data.currentProject?.id;if(connected&&data.needsPhotoTimes>0&&!busy()&&key&&!timeLoads.has(key)){timeLoads.add(key);queueMicrotask(()=>void perform(()=>api('/api/photos/times',{}),{message:null}));}}
}

async function refreshFresh(){while(refreshing)await new Promise(resolve=>setTimeout(resolve,20));await refresh();}
async function waitJob(){
  await refreshFresh();
  while(data.job?.running){await new Promise(resolve=>setTimeout(resolve,500));await refreshFresh();if(!connected)throw new Error('PC内の処理状況を確認できません。接続後に結果を確認してください。');}
  if(data.job?.error)throw new Error(data.job.error);
  return data.job?.result||{};
}

async function perform(action,{message='PCに保存しました。',refreshDetail=false,projectSwitch=false}={}){
  if(busy())return;
  if(projectSwitch){imagesPaused=true;clearProjectMedia();}
  pending++;updateControls();$('save-status').textContent='PCで処理しています…';
  try{
    const result=await action();
    await refreshFresh();
    if(message&&!data.job.running)toast(message);
    if(refreshDetail&&activePhotoId&&$('dialog').open)await renderPhotoDetail(activePhotoId);
    return result;
  }catch(error){toast(error.message,true);}
  finally{pending--;if(projectSwitch){imagesPaused=false;render();}updateControls();if(connected)$('save-status').textContent=data.job.running?'処理中・完了分を保存':'PCに保存済み';}
}

function updateControls(){
  const disabled=!connected||busy();
  $('check-update').disabled=checkingUpdate||busy();
  document.querySelectorAll('[data-mutates],#choose-source,#empty-import,#enter-source,#scan-button,#recognize-jerseys,#add-person,#choose-face-photo,#add-event,#export-folder,#select-visible,#clear-visible,#compress,#target-size,#target-unit,#export-mode,#save-project,#new-project,#open-project,#add-jersey-game,#jersey-game,#assign-jersey-game,#own-uniform,#opponent-uniform,#add-jersey-number,#edit-game-team-roster').forEach(node=>node.disabled=disabled);
  $('own-uniform').disabled=disabled||!sharedKit||!data.photos.length;
  $('opponent-uniform').disabled=disabled||!activeGame||!data.photos.length;
  for(const id of ['infer-jersey-games','refresh-photo-times','photo-sort','shared-kit-select','rename-shared-kit','rename-jersey-game','game-registration'])$(id).disabled=disabled;
  $('infer-jersey-games').disabled=disabled||!data.photos.length;$('refresh-photo-times').disabled=disabled||!data.photos.length;
  $('rename-jersey-game').disabled=disabled||!activeGame;$('rename-shared-kit').disabled=disabled||!sharedKit;
  $('game-kit-types').disabled=disabled||!activeGame;
  $('assign-jersey-game').disabled=disabled||!activeGame||!filtered().length;
  $('add-jersey-number').disabled=disabled||!data.people.length;
  $('add-game-number').disabled=disabled||!activeGame||!data.people.length;
  $('use-common-roster').disabled=disabled||!activeGame;
  for(const id of ['roster-team','add-roster-team','rename-roster-team'])$(id).disabled=disabled;
  $('game-roster-team').disabled=disabled||!activeGame;
  $('edit-game-team-roster').disabled=disabled||!activeGame;
  document.querySelectorAll('#photo-form input,#photo-form select,#event-form input,#person-form input,#path-form input').forEach(node=>node.disabled=disabled);
  document.querySelectorAll('[data-close]').forEach(node=>node.disabled=pending>0);
  $('scan-button').disabled=disabled||!data.photos.length;
  $('choose-face-photo').disabled=disabled||!data.photos.length;
  $('export-folder').disabled=disabled||!data.photos.some(photo=>photo.selected&&!photo.error);
  $('select-visible').disabled=disabled||!visible().length;$('clear-visible').disabled=disabled||!visible().length;
  $('cancel-job').disabled=!data.job.running;
  const job=data.job||{};$('progress-dock').hidden=!job.running;
  if(job.running){
    const titles={folder:'Windowsのフォルダ選択を待っています',register:'人物と顔をPCに登録しています',initialize:'GPUを準備しています',import:'写真を読み込んでいます',times:'撮影日時を読み込んでいます',infer:'日時から試合を推定しています',analyze:'GPUで写真を解析しています',jersey:'GPUで背番号とチームを確認しています',uniform:'ユニフォームの見本を保存しています',export:'写真を出力しています'};
    $('progress-title').textContent=titles[job.type]||'PCで処理しています';$('progress-detail').textContent=job.message||'';
    if(job.type==='analyze')$('progress-title').textContent=job.phase==='jerseys'?'2/2 背番号を解析しています':job.recognizeJerseys?'1/2 全写真の顔を解析しています':'顔を解析しています';
    if(job.total>0)$('progress-bar').value=job.done/job.total*100;else $('progress-bar').removeAttribute('value');
  }
}

function filtered(){
  const person=$('person-filter').value,date=$('date-filter').value,game=$('game-filter').value;
  return chronological(data.photos.filter(photo=>(filter==='all'||filter==='selected'&&photo.selected||filter==='review'&&photo.needsReview||filter==='unanalysed'&&!photo.analyzed||filter==='blur'&&(photo.blurLabel==='blur'||photo.blurry))&&(!person||(person===UNCLASSIFIED?photo.analyzed&&!photo.error&&!photo.matchedIds?.length:photo.matchedIds?.includes(person)))&&(!date||photo.date===date)&&(!game||(game==='__unassigned__'?!photo.jerseyGameId:photo.jerseyGameId===game))),$('photo-sort').value);
}
function chronological(photos,order='asc'){
  const time=photo=>Number.isFinite(photo.sortTimestamp)?photo.sortTimestamp:Date.parse(photo.capturedAt||photo.date||'');
  return photos.slice().sort((a,b)=>{const x=time(a),y=time(b);if(Number.isFinite(x)!==Number.isFinite(y))return Number.isFinite(x)?-1:1;const diff=Number.isFinite(x)&&Number.isFinite(y)?x-y:0;return (order==='desc'?-diff:diff)||(a.relative||a.name||'').localeCompare(b.relative||b.name||'',undefined,{numeric:true})||a.id.localeCompare(b.id);});
}
function visible(){return filtered().slice(page*perPage,(page+1)*perPage);}

function renderPeople(){
  $('people-list').innerHTML=data.people.length?data.people.map(person=>`<button class="person ${person.id===currentPerson?'active':''}" data-person="${esc(person.id)}"><span class="avatar">${esc(person.name.slice(0,1))}</span><span class="person-label">${esc(person.name)}<small>登録 ${person.referenceCount??0}件 · NG ${person.negativeCount??0}件</small></span></button>`).join(''):'<p class="hint">写真から顔を登録すると、ここに人物が並びます。</p>';
  const value=$('person-filter').value;
  $('person-filter').innerHTML=`<option value="">すべての人物</option><option value="${UNCLASSIFIED}">人物未分類</option>`+data.people.map(person=>`<option value="${esc(person.id)}">${esc(person.name)}</option>`).join('');
  $('person-filter').value=value===UNCLASSIFIED||data.people.some(person=>person.id===value)?value:'';
}

function renderJerseys(){
  const games=data.jerseyGames||[];
  const teams=data.sharedTeams||[],teamId=data.settings.rosterTeamId||DEFAULT_TEAM_ID,team=teams.find(t=>t.id===teamId);
  const teamOptions=teams.map(t=>`<option value="${esc(t.id)}">${esc(t.name)}（${t.memberCount}人）</option>`).join('');
  $('roster-team').innerHTML=teamOptions;$('roster-team').value=teamId;
  $('roster-team-status').textContent=`${team?.name||'選んだチーム'}の背番号と人物をPCへ自動保存します。別試合・別プロジェクトでも、このチームを選ぶだけで呼び出せます。ここで選んだチームを新しい試合の初期設定に使います。`;
  const types=data.sharedUniforms||[];
  if(!types.some(type=>type.id===sharedKit))sharedKit=types[0]?.id||'';
  $('shared-kit-select').innerHTML=types.map(type=>`<option value="${esc(type.id)}">${esc(type.name)}（見本${type.sampleCount}件）</option>`).join('');$('shared-kit-select').value=sharedKit;
  const kit=types.find(type=>type.id===sharedKit);
  $('shared-kit-samples').innerHTML=kit?.sampleIds?.map((id,index)=>`<div><span>PC共通の見本 ${index+1}</span><button class="tiny-button" data-shared-remove="${esc(id)}" data-mutates>削除</button></div>`).join('')||'<p class="hint">見本を一度登録すると、別試合・別プロジェクトでも使えます。</p>';
  if(!games.some(game=>game.id===activeGame))activeGame=games[0]?.id||'';
  $('jersey-game').innerHTML=games.length?games.map(game=>`<option value="${esc(game.id)}">${esc(game.name)}${game.inferred?'（仮）':''}</option>`).join(''):'<option value="">先に試合を追加</option>';
  $('jersey-game').value=activeGame;
  const currentGame=games.find(game=>game.id===activeGame);$('game-time-summary').textContent=currentGame?.startAt?`${currentGame.inferred?'仮登録：':''}${currentGame.startAt.replace('T',' ').slice(0,19)}〜${currentGame.endAt?.replace('T',' ').slice(0,19)||''} · ${data.photos.filter(p=>p.jerseyGameId===activeGame).length}枚`:'';
  const gameTeamId=currentGame?.teamId||DEFAULT_TEAM_ID;
  $('game-roster-team').innerHTML=teamOptions;$('game-roster-team').value=gameTeamId;
  $('game-roster-status').textContent=currentGame?`${teams.find(t=>t.id===gameTeamId)?.name||'チーム不明'}の保存済み名簿を使います。`:'先に試合を登録してください。';
  $('use-common-roster').checked=currentGame?.useCommonRoster!==false;
  const mode=data.settings.gameRegistration||'auto';$('game-registration').value=mode;
  $('game-registration-hint').textContent=mode==='auto'?`撮影が${data.settings.inferGapMinutes||30}分以上空いた所で試合を仮登録します。後から名前・写真の範囲を編集できます。`:mode==='manual'?'読み込みでは試合を作りません。「＋ 試合」で登録し、写真の範囲を指定してください。':'読み込みでは試合を作りません。顔・日付・イベントで整理できます。既存の試合と割り当ては残します。';
  const common=(data.sharedRoster||[]).filter(row=>row.teamId===teamId),duplicates=new Set(common.filter(row=>common.filter(other=>other.number===row.number).length>1).map(row=>row.number));
  $('shared-roster').innerHTML=common.map(row=>`<div><span>#${esc(row.number)} → ${esc(row.personName)}${!row.available?'<small>このプロジェクトに人物登録なし</small>':duplicates.has(row.number)?'<small>同じ番号が複数名：要確認</small>':''}</span><button class="tiny-button" data-edit-common="${esc(row.id)}" data-mutates>編集</button><button class="tiny-button" data-remove-common="${esc(row.id)}" data-mutates>削除</button></div>`).join('')||'<p class="hint">一度登録すると次の試合でも使えます。</p>';
  const previous=$('game-filter').value;
  $('game-filter').innerHTML='<option value="">すべての試合</option><option value="__unassigned__">試合未設定</option>'+games.map(game=>`<option value="${esc(game.id)}">${esc(game.name)}</option>`).join('');
  $('game-filter').value=previous==='__unassigned__'||games.some(game=>game.id===previous)?previous:'';
  const samples=(data.jerseyUniforms||[]).filter(s=>s.gameId===activeGame&&s.teamId===gameTeamId),roster=(data.jerseyRoster||[]).filter(row=>row.gameId===activeGame&&row.teamId===gameTeamId);
  const selectedKits=(data.jerseyGameKits||[]).filter(item=>item.gameId===activeGame&&item.teamId===gameTeamId).map(item=>item.kitId);
  $('game-kit-options').innerHTML=types.map(type=>`<label><input type="checkbox" value="${esc(type.id)}" ${selectedKits.includes(type.id)?'checked':''} data-mutates>${esc(type.name)}（${type.sampleCount?'見本あり':'未登録'}）</label>`).join('');
  $('jersey-samples').innerHTML=samples.map((sample,index)=>`<div><span>${sample.side==='own'?'この試合の味方':'相手'}の見本 ${index+1}</span>${sample.side==='own'?`<button class="tiny-button" data-promote-sample="${esc(sample.id)}" data-mutates>共通へ</button>`:''}<button class="tiny-button" data-remove-sample="${esc(sample.id)}" data-mutates>削除</button></div>`).join('');
  $('jersey-roster').innerHTML=roster.map(row=>`<div><span>#${esc(row.number)} → ${esc(getPerson(row.personId)?.name||'人物不明')}</span><button class="tiny-button" data-edit-number="${esc(row.id)}" data-mutates>編集</button><button class="tiny-button" data-remove-number="${esc(row.id)}" data-mutates>削除</button></div>`).join('')||'<p class="hint">試合だけの変更はありません。</p>';
  const ready=data.engine.jersey?.ready;
  const setup=data.jerseySetup.find(s=>s.gameId===activeGame),missingLabels={team:'チーム',own:'味方のユニフォーム',opponent:'相手の見本',roster:'名簿の背番号と人物'};
  $('jersey-status').textContent=!ready?(data.engine.jersey?.error||'背番号認識の準備を待っています。'):!activeGame?'先に試合を登録してください。':setup?.missing?.length?setup.missing.map(key=>missingLabels[key]).join('・')+'を設定してください。':'設定完了。「写真を解析」で顔 → 背番号の順に認識します。';
}

function goToSetup(step){
  if(step==='source')return void pickSource();
  const target={games:'games-settings',team:'team-settings',opponent:'opponent-settings',analyze:'analysis-controls'}[step];if(!target)return;
  if(step==='team'&&data.jerseySetup.find(s=>s.gameId===activeGame)?.missing?.includes('own'))$('uniform-library').open=true;
  $(target).scrollIntoView({behavior:'smooth',block:'start'});
}
document.querySelectorAll('[data-setup-step]').forEach(button=>button.onclick=()=>goToSetup(button.dataset.setupStep));

function renderWorkflow(){
  const count=data.photos.length,on=$('recognize-jerseys').checked,used=(data.jerseySetup||[]).filter(s=>s.photoCount>0),unassigned=data.photos.filter(p=>!p.jerseyGameId).length,ready=used.filter(s=>s.ready),teamReady=used.filter(s=>!s.missing.some(k=>['team','own','roster'].includes(k))).length,opponentReady=used.filter(s=>!s.missing.includes('opponent')).length;
  $('flow-source').textContent=count?`${count}枚`:'未読み込み';$('flow-games').textContent=on?(data.jerseyGames.length?`${data.jerseyGames.length}試合${unassigned?'・未設定'+unassigned+'枚':''}`:'未登録'):'任意';
  $('flow-team').textContent=on?(used.length?`${teamReady}/${used.length}試合 設定済み`:'未設定'):'任意';$('flow-opponent').textContent=on?(used.length?`${opponentReady}/${used.length}試合 設定済み`:'未設定'):'任意';
  const complete={source:count>0,games:on?data.jerseyGames.length>0&&!unassigned:true,team:on?used.length>0&&teamReady===used.length:true,opponent:on?used.length>0&&opponentReady===used.length:true,analyze:false};
  document.querySelectorAll('[data-flow-step]').forEach(node=>node.classList.toggle('complete',complete[node.dataset.flowStep]));
  const targetCount=ready.reduce((n,s)=>n+s.photoCount,0);
  $('analysis-plan').textContent=!count?'フォルダを読み込んで始めます。':!on?`読み込んだ全${count}枚の顔を解析します。`:`読み込んだ全${count}枚の顔 → 試合を設定した写真の背番号を解析します。${!data.jerseyGames.length?'背番号認識には試合の登録が必要です。':`${targetCount}枚は背番号の設定済み${used.length>ready.length?'・未設定の試合があります':''}${unassigned?'・試合未設定 '+unassigned+'枚':''}。`}`;
}

function showAnalysisNotice(result){
  showDialog(`<div class="dialog-body"><h2>解析結果</h2><p>${esc(result.message)}</p><ul class="analysis-warnings">${result.warnings.map(item=>`<li>${esc(item.message)}</li>`).join('')}</ul>${result.errors?.length?`<p>${result.errors.length}件は写真を読み込めませんでした。写真のエラー表示を確認してください。</p>`:''}<p>設定後にもう一度「写真を解析」を押すと、解析済みの顔を使って背番号を確認できます。</p></div>${dialogActions('<button type="button" id="analysis-setup" class="primary-button">設定を確認する</button>')}`);
  $('analysis-setup').onclick=()=>{const first=result.warnings[0],setup=data.jerseySetup.find(s=>s.gameId===first.gameId);if(setup)activeGame=setup.gameId;closeDialog();renderJerseys();updateControls();goToSetup(['no_games','unassigned'].includes(first.code)?'games':setup?.missing.includes('opponent')&&!setup.missing.some(k=>['team','own','roster'].includes(k))?'opponent':'team');};
}

function editJerseyGame(existing=null){
  if(busy())return;
  const photos=chronological(data.photos,'asc'),members=photos.filter(p=>p.jerseyGameId===existing?.id),options=photos.map((photo,index)=>`<option value="${index}">${esc(photo.captureDisplay||photo.date)} · ${esc(photo.relative||photo.name)}</option>`).join('');
  showDialog(`<form id="jersey-game-form"><div class="dialog-body"><h2>${existing?'試合を編集':'試合を追加'}</h2><p>名前と写真の範囲を手動で直せます。保存した名前・割り当ては再推定で保持します。</p><label class="dialog-field">試合名<input id="jersey-game-name" required maxlength="80" value="${esc(existing?.name||'')}" placeholder="例：11月8日 午前の試合"></label>${photos.length?`<label class="check-line"><input id="edit-game-range" type="checkbox">写真の範囲も設定し直す</label><fieldset id="edit-game-range-fields" class="jersey-kit-types" disabled><label class="dialog-field">開始の写真<select id="edit-game-start">${options}</select></label><label class="dialog-field">終了の写真<select id="edit-game-end">${options}</select></label><p id="edit-game-count" class="hint"></p></fieldset><p class="hint">プロジェクト全体の撮影日時順です。範囲外のこの試合の写真は割り当てを解除します。範囲内の別試合の写真は移動します。移動・解除した写真の背番号OK／NGは外れます。</p>`:''}</div><div class="dialog-actions">${existing?'<button type="button" id="delete-jersey-game" class="text-button danger" data-mutates>この試合を削除</button>':''}<button type="button" class="outline-button" data-close>閉じる</button><button type="submit" class="primary-button" data-mutates>保存</button></div></form>`);
  if(photos.length){
    $('edit-game-start').value=String(members.length?photos.indexOf(members[0]):0);$('edit-game-end').value=String(members.length?photos.indexOf(members.at(-1)):photos.length-1);
    const count=()=>{const start=Number($('edit-game-start').value),end=Number($('edit-game-end').value);$('edit-game-count').textContent=`割り当てる写真：${Math.max(0,end-start+1)}枚（現在この試合は${members.length}枚）`;};
    $('edit-game-range').onchange=()=>{$('edit-game-range-fields').disabled=!$('edit-game-range').checked;};$('edit-game-start').onchange=count;$('edit-game-end').onchange=count;count();
  }
  $('jersey-game-form').onsubmit=async event=>{event.preventDefault();const name=$('jersey-game-name').value.trim(),body={name,...(existing?{id:existing.id}:{})};if($('edit-game-range')?.checked){const start=Number($('edit-game-start').value),end=Number($('edit-game-end').value);if(start>end)return toast('開始と終了の順番を確認してください。',true);body.photoIds=photos.slice(start,end+1).map(p=>p.id);}const result=await perform(()=>api('/api/jersey/games',body),{message:'試合を保存しました。'});if(result){activeGame=result.game.id;closeDialog();renderJerseys();updateControls();}};
  if(existing)$('delete-jersey-game').onclick=()=>{
    showDialog(`<div class="dialog-body"><h2>「${esc(existing.name)}」を削除しますか？</h2><p>${members.length}枚の試合割り当てを解除し、この試合だけの見本・番号表・背番号OK／NGを削除します。写真本体・顔の登録・PC保存のチーム名簿と4種類は残ります。</p></div>${dialogActions('<button type="button" id="confirm-delete-game" class="primary-button" data-mutates>この試合を削除する</button>')}`);
    $('confirm-delete-game').onclick=async()=>{const result=await perform(()=>api('/api/jersey/games',{id:existing.id,delete:true}),{message:'試合を削除しました。写真の割り当ては解除済みです。'});if(result)closeDialog();};
  };
}

function assignJerseyRange(){
  if(busy()||!activeGame)return;
  const photos=chronological(filtered(),'asc');
  if(!photos.length)return;
  const options=photos.map((photo,index)=>`<option value="${index}">${esc(photo.date)} · ${esc(photo.relative||photo.name)}</option>`).join('');
  showDialog(`<form id="jersey-range-form"><div class="dialog-body"><h2>写真を試合に割り当て</h2><p>現在の表示条件に合うすべての写真を、撮影日時順に並べています。開始〜終了の連続範囲を設定します。同じフォルダに別の試合があっても、この範囲だけが対象です。</p><label class="dialog-field">試合<select id="range-game"><option value="">試合の割り当てを解除</option>${(data.jerseyGames||[]).map(game=>`<option value="${esc(game.id)}" ${game.id===activeGame?'selected':''}>${esc(game.name)}</option>`).join('')}</select></label><label class="dialog-field">開始の写真<select id="range-start">${options}</select></label><label class="dialog-field">終了の写真<select id="range-end">${options}</select></label><p id="range-count" class="hint"></p></div>${dialogActions('<button type="submit" class="primary-button" data-mutates>この範囲に試合を設定</button>')}</form>`);
  $('range-end').value=String(photos.length-1);
  const range=()=>{const start=Number($('range-start').value),end=Number($('range-end').value);return start<=end?photos.slice(start,end+1):[];};
  const count=()=>$('range-count').textContent=`対象：${range().length}枚。既に試合が付いている写真は、この設定に変更します。`;
  $('range-start').onchange=count;$('range-end').onchange=count;count();
  $('jersey-range-form').onsubmit=async event=>{event.preventDefault();const ids=range().map(photo=>photo.id),gameId=$('range-game').value;if(!ids.length)return toast('開始と終了の順番を確認してください。',true);const result=await perform(()=>api('/api/jersey/assign',{ids,gameId}),{message:`${ids.length}枚の試合を保存しました。`});if(result)closeDialog();};
}

function addJerseyNumber(scope='common',existing=null){
  if(busy()||scope==='game'&&!activeGame)return;const gameId=activeGame,teamId=scope==='common'?(data.settings.rosterTeamId||DEFAULT_TEAM_ID):data.jerseyGames.find(g=>g.id===gameId)?.teamId;
  showDialog(`<form id="jersey-number-form"><div class="dialog-body"><h2>${existing?'背番号の登録を編集':'背番号と人物を登録'}</h2><p>${scope==='common'?'選んだチームの名簿をPCへ保存します。新しい試合・プロジェクトでも使います。':esc(data.jerseyGames.find(g=>g.id===gameId)?.name)+' だけの変更です。保存したチーム名簿は変えません。'}</p>${scope==='common'?`<label class="dialog-field">保存するチーム<select id="roster-entry-team">${data.sharedTeams.map(t=>`<option value="${esc(t.id)}" ${t.id===(existing?.teamId||teamId)?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label>`:''}<label class="dialog-field">背番号<input id="jersey-number" inputmode="numeric" pattern="[0-9]{1,3}" maxlength="3" required value="${esc(existing?.number||'')}"></label><label class="dialog-field">人物<select id="jersey-person" required>${existing&&!getPerson(existing.personId)?'<option value="" selected disabled>このプロジェクトの人物を選択</option>':''}${data.people.map(p=>`<option value="${esc(p.id)}" ${p.id===existing?.personId?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><p class="hint">番号と味方ユニフォームの両方で確認します。同じチーム内の同じ番号に複数人がいる場合は自動確定しません。別チームの同じ番号とは混ざりません。</p></div>${dialogActions('<button type="submit" class="primary-button" data-mutates>番号表に保存</button>')}</form>`);
  $('jersey-number-form').onsubmit=async event=>{event.preventDefault();const number=$('jersey-number').value,personId=$('jersey-person').value,targetTeam=scope==='common'?$('roster-entry-team').value:teamId;const result=await perform(()=>api(scope==='common'?'/api/roster':'/api/jersey/roster',{gameId,number,personId,teamId:targetTeam,...(existing?{id:existing.id,sourceTeamId:existing.teamId}:{})}),{message:scope==='common'?'チームの名簿をPCに保存しました。':'この試合・チームだけの番号変更を保存しました。'});if(result)closeDialog();};
}

function editRosterTeam(existing=null){
  if(busy())return;const selected=data.settings.rosterTeamId||DEFAULT_TEAM_ID;
  showDialog(`<form id="roster-team-form"><div class="dialog-body"><h2>${existing?'チーム名を変更':'チームをPCに保存'}</h2><p>チームごとに背番号と人物を登録して呼び出せます。学年・年度で分けることもできます。</p><label class="dialog-field">チーム名<input id="roster-team-name" maxlength="60" required value="${esc(existing?.name||'')}" placeholder="例：○○FC U-10、学校のチーム"></label>${existing?'':'<label class="check-line"><input id="copy-team-roster" type="checkbox">今表示しているチームの名簿をコピーする</label>'}</div>${dialogActions('<button type="submit" class="primary-button" data-mutates>PCに保存</button>')}</form>`);
  $('roster-team-form').onsubmit=async event=>{event.preventDefault();const name=$('roster-team-name').value,body={name,...(existing?{id:existing.id}:$('copy-team-roster').checked?{copyFrom:selected}:{})};const result=await perform(()=>api('/api/teams',body),{message:'チームをPCに保存しました。'});if(result)closeDialog();};
}

function chooseUniform(side){
  if(busy()||side==='own'&&!sharedKit||side==='opponent'&&!activeGame)return;
  uniformEnroll=side==='own'?{kitId:sharedKit,side}:{gameId:activeGame,teamId:data.jerseyGames.find(g=>g.id===activeGame)?.teamId,side};enrollMode=false;filter='all';page=0;$('person-filter').value='';$('game-filter').value='';
  document.querySelectorAll('[data-filter]').forEach(button=>button.classList.toggle('active',button.dataset.filter==='all'));
  $('uniform-notice-text').textContent=`${side==='own'?(data.sharedUniforms.find(k=>k.id===sharedKit)?.name+'（PC共通）'):data.jerseyGames.find(g=>g.id===activeGame)?.name}：${side==='own'?'味方':'相手'}のユニフォームが写った写真をクリックしてください。`;
  $('uniform-notice').hidden=false;renderGallery();$('uniform-notice').scrollIntoView({behavior:'smooth',block:'center'});
}

async function openUniformEditor(photoId,choice){
  const photo=getPhoto(photoId);if(!photo||busy())return;
  const target=choice.kitId?data.sharedUniforms.find(k=>k.id===choice.kitId)?.name:data.jerseyGames.find(g=>g.id===choice.gameId)?.name;
  showDialog(`<form id="uniform-form"><div class="dialog-body"><h2>${choice.side==='own'?'味方':'相手'}のユニフォーム見本</h2><p>${esc(target)}${choice.kitId?'（PC共通・別プロジェクトでも使えます）':''} の見本です。シャツの生地・模様を四角で囲んでください。顔・腕・芝生をできるだけ含めず、番号だけの範囲は避けてください。別配色やGKも、見本を追加できます。</p><canvas id="uniform-canvas" class="jersey-crop-canvas" aria-label="ユニフォームの範囲をドラッグで指定"></canvas><p id="uniform-region-status" class="hint">写真を読み込んでいます…</p></div>${dialogActions('<button type="submit" id="save-uniform" class="primary-button" data-mutates>この見本を保存</button>')}</form>`);
  const generation=++detailGeneration;
  try{
    const image=await loadImage(photoId);if(generation!==detailGeneration||!$('uniform-canvas'))return;
    const canvas=$('uniform-canvas'),context=canvas.getContext('2d'),scale=Math.min(1,900/image.naturalWidth,480/image.naturalHeight);
    canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));let start=null,region=null;
    const point=event=>{const r=canvas.getBoundingClientRect();return {x:Math.max(0,Math.min(image.naturalWidth,(event.clientX-r.left)*image.naturalWidth/r.width)),y:Math.max(0,Math.min(image.naturalHeight,(event.clientY-r.top)*image.naturalHeight/r.height))};};
    const paint=()=>{context.drawImage(image,0,0,canvas.width,canvas.height);if(region){context.strokeStyle='#d47b2f';context.lineWidth=3;context.strokeRect(region.x*scale,region.y*scale,region.width*scale,region.height*scale);}};
    canvas.onpointerdown=event=>{start=point(event);canvas.setPointerCapture(event.pointerId);};
    canvas.onpointermove=event=>{if(!start)return;const end=point(event);region={x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)};paint();};
    canvas.onpointerup=event=>{if(!start)return;canvas.onpointermove(event);start=null;$('uniform-region-status').textContent='囲んだシャツが正しければ見本を保存してください。';};
    canvas.onpointercancel=()=>{start=null;};paint();$('uniform-region-status').textContent='シャツの生地・模様をドラッグで囲んでください。';
    $('uniform-form').onsubmit=async event=>{event.preventDefault();if(!region||region.width<16||region.height<16)return toast('ユニフォームを少し広く囲んでください。',true);const result=await perform(()=>api(choice.kitId?'/api/uniforms/sample':'/api/jersey/sample',{photoId,gameId:choice.gameId,teamId:choice.teamId,kitId:choice.kitId,side:choice.side,region}),{message:null});if(result)closeDialog();};
  }catch(error){if($('uniform-region-status'))$('uniform-region-status').textContent=error.message;}
}

$('add-jersey-game').onclick=()=>editJerseyGame();
$('rename-jersey-game').onclick=()=>editJerseyGame(data.jerseyGames.find(game=>game.id===activeGame));
$('jersey-game').onchange=event=>{activeGame=event.target.value;renderJerseys();updateControls();};
$('assign-jersey-game').onclick=assignJerseyRange;$('add-jersey-number').onclick=()=>addJerseyNumber();$('add-game-number').onclick=()=>addJerseyNumber('game');
$('own-uniform').onclick=()=>chooseUniform('own');$('opponent-uniform').onclick=()=>chooseUniform('opponent');
$('cancel-uniform').onclick=()=>{uniformEnroll=null;$('uniform-notice').hidden=true;};
$('edit-game-team-roster').onclick=()=>void perform(async()=>{const teamId=data.jerseyGames.find(g=>g.id===activeGame)?.teamId;await api('/api/teams/select',{teamId});$('team-library').open=true;$('team-library').scrollIntoView({behavior:'smooth',block:'start'});},{message:null});
$('jersey-samples').onclick=event=>{const promoted=event.target.closest('[data-promote-sample]')?.dataset.promoteSample;if(promoted)return promoteUniform(promoted);const id=event.target.closest('[data-remove-sample]')?.dataset.removeSample;if(id)void perform(()=>api('/api/jersey/sample-delete',{id}),{message:'見本を削除しました。'});};
$('jersey-roster').onclick=event=>{const edit=event.target.closest('[data-edit-number]')?.dataset.editNumber;if(edit)return addJerseyNumber('game',data.jerseyRoster.find(row=>row.id===edit));const id=event.target.closest('[data-remove-number]')?.dataset.removeNumber;if(id)void perform(()=>api('/api/jersey/roster',{id,delete:true}),{message:'この試合の番号変更を削除しました。選んだチームの名簿を再び使います。'});};
$('shared-roster').onclick=event=>{const edit=event.target.closest('[data-edit-common]')?.dataset.editCommon;if(edit)return addJerseyNumber('common',data.sharedRoster.find(row=>row.id===edit));const id=event.target.closest('[data-remove-common]')?.dataset.removeCommon;if(id){const teamId=data.sharedRoster.find(row=>row.id===id)?.teamId;void perform(()=>api('/api/roster',{id,teamId,delete:true}),{message:'このチームの番号登録を削除しました。試合だけの設定は残ります。'});}};
$('add-roster-team').onclick=()=>editRosterTeam();$('rename-roster-team').onclick=()=>editRosterTeam(data.sharedTeams.find(t=>t.id===$('roster-team').value));
$('roster-team').onchange=event=>{const teamId=event.target.value;void perform(()=>api('/api/teams/select',{teamId}),{message:'PCからチーム名簿を呼び出しました。新しい試合でも使います。'});};
$('game-roster-team').onchange=event=>{const teamId=event.target.value;void perform(()=>api('/api/jersey/team',{gameId:activeGame,teamId}),{message:'この試合で使うチーム名簿を切り替えました。'});};
$('use-common-roster').onchange=()=>void perform(()=>api('/api/jersey/use-common-roster',{gameId:activeGame,enabled:$('use-common-roster').checked}),{message:'この試合で使う番号表を保存しました。'});
$('shared-kit-select').onchange=event=>{sharedKit=event.target.value;renderJerseys();updateControls();};
$('rename-shared-kit').onclick=()=>{
  const kit=data.sharedUniforms.find(item=>item.id===sharedKit);if(!kit||busy())return;
  showDialog(`<form id="kit-name-form"><div class="dialog-body"><h2>PC共通の種類名</h2><p>別の試合やプロジェクトにも同じ名前で表示します。</p><label class="dialog-field">名前<input id="kit-name" required maxlength="60" value="${esc(kit.name)}" placeholder="例：赤、青、白、GK用"></label></div>${dialogActions('<button type="submit" class="primary-button" data-mutates>保存</button>')}</form>`);
  $('kit-name-form').onsubmit=async event=>{event.preventDefault();const name=$('kit-name').value;const result=await perform(()=>api('/api/uniforms/rename',{kitId:kit.id,name}),{message:'PC共通の種類名を保存しました。'});if(result)closeDialog();};
};
$('shared-kit-samples').onclick=event=>{const id=event.target.closest('[data-shared-remove]')?.dataset.sharedRemove;if(id)void perform(()=>api('/api/uniforms/sample-delete',{id}),{message:'PC共通の見本を削除しました。'});};
$('game-kit-options').onchange=()=>void perform(()=>api('/api/jersey/kits',{gameId:activeGame,kitIds:[...$('game-kit-options').querySelectorAll('input:checked')].map(node=>node.value)}),{message:'この試合で使う味方の種類を保存しました。'});
function promoteUniform(id){
  showDialog(`<form id="promote-kit-form"><div class="dialog-body"><h2>この見本をPC共通へ保存</h2><p>これまでの試合の見本は残して、ほかの試合・新規プロジェクトでも使えるようにします。</p><label class="dialog-field">保存する種類<select id="promote-kit">${data.sharedUniforms.map(type=>`<option value="${esc(type.id)}" ${type.id===sharedKit?'selected':''}>${esc(type.name)}</option>`).join('')}</select></label></div>${dialogActions('<button type="submit" class="primary-button" data-mutates>共通に保存</button>')}</form>`);
  $('promote-kit-form').onsubmit=async event=>{event.preventDefault();const kitId=$('promote-kit').value;const result=await perform(()=>api('/api/uniforms/promote',{id,kitId}),{message:'見本をPC共通へ保存しました。'});if(result)closeDialog();};
}

function inferGamesDialog(){
  if(busy())return;
  showDialog(`<form id="infer-games-form"><div class="dialog-body"><h2>日時から試合を自動作成</h2><p>このプロジェクト全体の撮影日時を使い、間隔が空いた所と日付の変わり目で「試合1・試合2…」を仮登録します。後から試合名や写真の割り当てを直せます。</p><label class="dialog-field">別試合とみなす撮影間隔（分）<input id="infer-gap" type="number" min="1" max="240" required value="${Number(data.settings.inferGapMinutes)||30}"></label><label class="check-line"><input id="infer-file-times" type="checkbox" ${data.settings.inferIncludeFileTimes?'checked':''}>撮影時刻がない写真は更新日時も使う</label><label class="check-line"><input id="infer-reset" type="checkbox" checked>未設定の仮割り当てを作り直す</label><p class="hint">手動で直した写真・名前、ユニフォーム見本・番号表のある試合は保持します。撮影が途切れると同じ試合でも分かれる場合があります。</p></div>${dialogActions('<button type="submit" class="primary-button" data-mutates>自動作成・割り当て</button>')}</form>`);
  $('infer-games-form').onsubmit=async event=>{event.preventDefault();const gapMinutes=Number($('infer-gap').value),includeFileTimes=$('infer-file-times').checked,resetAuto=$('infer-reset').checked;closeDialog();await perform(async()=>{await api('/api/settings',{inferGapMinutes:gapMinutes,inferIncludeFileTimes:includeFileTimes});return api('/api/jersey/infer',{gapMinutes,includeFileTimes,resetAuto});},{message:null});};
}
function showInferredGames(result={}){
  showDialog(`<div class="dialog-body"><h2>試合の仮登録ができました</h2><p>${esc(result.message||'')}</p><div class="inferred-games">${(result.createdGames||[]).map(game=>`<div><strong>${esc(game.name)}</strong><br>${esc(game.startAt?.replace('T',' ').slice(0,19))}〜${esc(game.endAt?.replace('T',' ').slice(0,19))}<br>${Number(game.photoCount)}枚</div>`).join('')}</div><p>仮の試合名は変更できます。各試合で実際に使った味方の種類と、相手の見本と使用するチーム名簿を設定してください。</p></div>${dialogActions('')}`);
}
$('game-registration').onchange=()=>void perform(()=>api('/api/settings',{gameRegistration:$('game-registration').value}),{message:'今後の写真読み込みでの試合登録方法を保存しました。'});
$('infer-jersey-games').onclick=inferGamesDialog;
$('refresh-photo-times').onclick=()=>void perform(()=>api('/api/photos/times',{force:true}),{message:null});

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
    return `<article class="photo-card ${photo.selected?'selected':''}"><button class="photo-image" data-photo="${esc(photo.id)}" aria-label="${esc(photo.name)}を確認">${privateImage('thumb',photo.id,photo.name,'lazy')}</button><label class="card-checkbox"><input type="checkbox" data-select="${esc(photo.id)}" ${photo.selected?'checked':''} ${busy()||photo.error?'disabled':''} aria-label="${esc(photo.name)}を出力対象に"></label><div class="card-flags">${photo.needsReview?'<span class="review-badge">要確認</span>':''}${photo.blurLabel==='blur'?'<span class="blur-badge">ボケ指定</span>':''}</div><div class="card-info"><div class="card-name" title="${esc(photo.relative||photo.name)}">${esc(photo.name)}</div><div class="card-meta"><span>${esc(photo.captureClock&&photo.captureDisplay?photo.captureDisplay:(photo.date||'日付不明'))}</span><span>${photo.size?size(photo.size):`${photo.faces?.length||0}人の顔`}</span></div>${photo.jerseyGameId?`<div class="card-game">${esc(data.jerseyGames.find(game=>game.id===photo.jerseyGameId)?.name||'試合不明')}</div>`:''}<div class="card-people">${tags}</div><button class="review-link" data-photo="${esc(photo.id)}">顔を確認・修正 →</button></div></article>`;
  }).join('')||(data.photos.length?'<p class="filter-empty">この条件の写真はありません。</p>':'');
  $('empty-state').querySelector('p').textContent=data.people.some(person=>person.referenceCount>0)?'登録済みの顔とOK／NGを使えます。写真フォルダを開き、「写真を解析」を押してください。':'写真はこのPCから読み込みます。人物を登録して解析すると、友達ごとに分類できます。';
  $('empty-state').hidden=data.photos.length>0;$('visible-count').textContent=`${all.length}枚を表示対象`;
  $('unclassified-hint').hidden=$('person-filter').value!==UNCLASSIFIED;
  $('page-label').textContent=`${page+1} / ${pages}`;$('prev-page').disabled=page<=0;$('next-page').disabled=page>=pages-1;
  $('total-count').textContent=data.photos.length;$('selected-count').textContent=data.photos.filter(photo=>photo.selected&&!photo.error).length;
  $('review-count').textContent=data.photos.filter(photo=>photo.needsReview).length;$('person-count').textContent=data.people.length;
  $('enroll-notice').hidden=!enrollMode;
}

function render(){
  $('app-version').textContent=`v${UI_VERSION}`;
  $('app-version').title=`画面 v${UI_VERSION} / PC v${data.appVersion||'未接続'}`;
  const engine=data.engine,gpu=engine.gpuName||engine.device||'';
  $('gpu-status').textContent=engine.error?'GPUの確認が必要':engine.ready?`GPU · ${gpu||engine.provider||'接続済み'}`:'GPUを準備中';
  $('gpu-status').classList.toggle('error',Boolean(engine.error));$('gpu-status').title=gpu;
  $('engine-notice').hidden=!engine.error;$('engine-notice').textContent=engine.error||'';
  if(!pending)$('save-status').textContent=data.job.running?'処理中・完了分を保存':'PCに保存済み';
  $('source-name').textContent=data.sourcePath||data.settings.sourcePath||data.sourceName||(data.photos.length?'保存された写真ライブラリ':'写真フォルダを選んでください');
  $('source-meta').textContent=`${data.photos.length}枚 · 人物登録とOK／NGは次回起動時も復元します`;
  $('storage-location').textContent=data.dataDirectory?`保存先：${data.dataDirectory}`:'';
  $('capture-time-status').textContent=data.needsPhotoTimes>0?'撮影時刻を読み込んでいます。完了すると秒単位で並び替えます。':'撮影日時順です。撮影時刻がない写真はファイル更新日時や日付で表示します。';
  if(!settingsInitialized){
    $('photo-sort').value=data.settings.photoSort==='asc'?'asc':'desc';
    $('recognize-jerseys').checked=data.settings.recognizeJerseys!==false;
    const target=data.settings.targetBytes;$('compress').checked=target!==null;
    if(Number(target)>0){$('target-unit').value=target>=1e6?'MB':'KB';$('target-size').value=String(target/(target>=1e6?1e6:1000));}
    $('export-mode').value=['people','any','all'].includes(data.settings.exportMode)?data.settings.exportMode:'people';settingsInitialized=true;
  }
  renderProjects();renderPeople();renderEvents();renderJerseys();renderGallery();renderWorkflow();updateControls();
}

function closeDialog(){
  if(pending)return;
  detailGeneration++;activePhotoId=null;detailImage=null;$('dialog').close();$('dialog-content').replaceChildren();
}
function showDialog(html){
  detailGeneration++;activePhotoId=null;detailImage=null;$('dialog-content').innerHTML=html;if(!$('dialog').open)$('dialog').showModal();
}
const dialogActions=primary=>`<div class="dialog-actions"><button type="button" class="outline-button" data-close>閉じる</button>${primary||''}</div>`;

function compareVersions(left,right){
  if(!/^\d+\.\d+\.\d+$/.test(left)||!/^\d+\.\d+\.\d+$/.test(right))throw Error('バージョン情報の形式が正しくありません。');
  const a=left.split('.').map(Number),b=right.split('.').map(Number);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i]?1:-1;
  return 0;
}
async function checkForUpdate(){
  if(checkingUpdate||busy())return;
  checkingUpdate=true;$('check-update').textContent='確認中…';updateControls();
  try{
    const url=new URL(PUBLIC_VERSION_URL);url.searchParams.set('check',String(Date.now()));
    const response=await fetch(url,{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error('公開版のバージョンを取得できませんでした。');
    const latest=await response.json();
    if(typeof latest.version!=='string')throw Error('バージョン情報を読み取れませんでした。');
    if(compareVersions(latest.version,UI_VERSION)<=0){toast(`画面は最新版です（v${UI_VERSION}）。`);return;}
    showDialog(`<div class="dialog-body"><h2>新しい画面があります</h2><p>現在 v${UI_VERSION} → 最新 v${esc(latest.version)}</p><p>人物登録・OK／NG・プロジェクトはPCに保存したままです。</p><p>${HOSTED?'画面を再読み込みして更新します。PC内の認識プログラムは、このボタンでは更新しません。':'PCに同梱された画面はPCアプリと一緒に更新します。公開画面を使う場合はStart-PhotoSorter.cmdから開いてください。'}</p></div>${dialogActions(HOSTED?'<button type="button" id="apply-update" class="primary-button" data-mutates>画面を更新する</button>':'')}`);
    if($('apply-update'))$('apply-update').onclick=()=>{
      if(busy())return toast('現在の処理が終わってから画面を更新してください。',true);
      const target=new URL(location.href);target.hash='';target.searchParams.set('v',latest.version);target.searchParams.set('updated',String(Date.now()));location.replace(target.href);
    };
  }catch{toast('更新を確認できませんでした。インターネット接続を確認して再試行してください。',true);}
  finally{checkingUpdate=false;$('check-update').textContent='更新確認';updateControls();}
}
$('check-update').onclick=()=>void checkForUpdate();

function clearProjectMedia(){
  imageController.abort();imageController=new AbortController();imageQueue.length=0;imagePending.clear();
  for(const url of imageCache.values())URL.revokeObjectURL(url);imageCache.clear();
}
function resetProjectView(){
  activeGame='';uniformEnroll=null;$('game-filter').value='';$('uniform-notice').hidden=true;
  currentPerson='';filter='all';page=0;enrollMode=false;settingsInitialized=false;detailGeneration++;
  activePhotoId=null;detailImage=null;editorPhotoId=null;editor?.destroy();editor=null;
  if(editorImage){editorImage.width=editorImage.height=1;editorImage=null;}
  $('dialog').close();$('dialog-content').replaceChildren();$('face-editor-dialog').close();$('face-editor-content').replaceChildren();
  $('person-filter').value='';$('date-filter').value='';
  document.querySelectorAll('[data-filter]').forEach(button=>button.classList.toggle('active',button.dataset.filter==='all'));
  clearProjectMedia();
}
function renderProjects(){
  const project=data.currentProject;
  $('project-name').textContent=project?.name||'プロジェクト';
  $('open-project').innerHTML=(data.projects||[]).map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
  if(project)$('open-project').value=project.id;
  $('project-save-status').textContent=project?.savedAt?'保存 '+new Date(project.savedAt).toLocaleString():'変更はPCへ自動保存されます';
}
function projectDialog(kind){
  if(busy())return;
  const fresh=kind==='new';
  showDialog(`<form id="project-form"><div class="dialog-body"><h2>${fresh?'新規プロジェクト':'プロジェクトを保存'}</h2><p>${fresh?'現在の作業を保存し、人物登録・登録した顔・OK／NGを引き継ぎます。PC保存のチーム名簿とユニフォーム4種類も使えます。写真一覧・イベント・試合は空で始めます。':'写真一覧・人物登録・OK／NG・イベント・設定をPC内のプロジェクトとして保存します。'}</p><label class="dialog-field">プロジェクト名<input id="project-title" required maxlength="100" value="${esc(fresh?'新しいプロジェクト':data.currentProject?.name||'写真整理')}"></label>${fresh?registrationSelect('project-registration'):''}</div>${dialogActions(`<button type="submit" class="primary-button" data-mutates>${fresh?'作成する':'保存する'}</button>`)}</form>`);
  $('project-form').onsubmit=event=>{
    event.preventDefault();const name=$('project-title').value.trim();if(!name)return;
    const gameRegistration=fresh?$('project-registration').value:undefined;closeDialog();void perform(()=>api(fresh?'/api/projects/new':'/api/projects/save',{name,...(fresh?{gameRegistration}:{})}),{message:fresh?'新規プロジェクトを作成しました。':'プロジェクトを保存しました。',projectSwitch:fresh});
  };$('project-title').select();
}
$('save-project').onclick=()=>projectDialog('save');$('new-project').onclick=()=>projectDialog('new');
$('open-project').onchange=event=>{const id=event.target.value;if(id&&id!==data.currentProject?.id)void perform(()=>api('/api/projects/open',{id}),{message:'プロジェクトを開きました。',projectSwitch:true});};

async function pickSource(){if(!busy())await openFolder('source');}

function registrationSelect(id){
  const mode=data.settings.gameRegistration||'auto';
  return `<label class="dialog-field">写真読み込み時の試合登録<select id="${id}">${[['auto','自動：日時から試合を仮登録'],['manual','手動：試合は後で自分で登録'],['none','登録しない：顔・日付・イベントで整理']].map(([value,label])=>`<option value="${value}" ${mode===value?'selected':''}>${label}</option>`).join('')}</select></label><p class="hint">後から変更できます。「登録しない」でも既存の試合・割り当ては消えません。</p>`;
}

async function openFolder(purpose){
  if(busy())return;
  const output=purpose==='output';let generation=0,selectedPath='';
  showDialog(`<div class="dialog-body folder-browser"><h2>${output?'出力先フォルダを選ぶ':'写真フォルダを選ぶ'}</h2><p>このPC内のフォルダを開いて選びます。場所を直接入力することもできます。</p>${output?'':registrationSelect('import-game-registration')}<form id="folder-path-form" class="folder-path-row"><input id="folder-browser-path" class="path-input" aria-label="フォルダの場所" autocomplete="off"><button class="outline-button" type="submit">表示</button></form><div id="folder-drives" class="folder-drives"></div><button id="folder-parent" class="text-button" type="button">↑ ひとつ上へ</button><p id="folder-list-status" role="status">フォルダを表示しています…</p><div id="folder-list" class="folder-list"></div></div><div class="dialog-actions"><button class="outline-button" type="button" data-close>閉じる</button><button id="use-folder" class="primary-button" type="button" disabled>${output?'ここへ出力':'このフォルダを読み込む'}</button></div>`);
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
    const path=selectedPath,gameRegistration=output?undefined:$('import-game-registration').value;generation++;closeDialog();
    void perform(async()=>{
      if(!output)return api('/api/import',{path,gameRegistration});
      const settings=outputOptions();await api('/api/settings',settings);
      return api('/api/export',{path,ids:data.photos.filter(photo=>photo.selected&&!photo.error).map(photo=>photo.id),targetBytes:settings.targetBytes,groupMode:settings.exportMode,allowResize:true});
    },{message:null});
  };
  await load();
}

function enterSource(purpose='source'){
  const output=purpose==='output';
  showDialog(`<form id="path-form"><div class="dialog-body"><h2>${output?'出力先フォルダを指定':'写真フォルダを指定'}</h2><p>${output?'このPC内の出力先フォルダを指定します。':'このPC上のJPEG・PNGを読み込みます。サブフォルダも対象です。'}</p><label class="dialog-field">フォルダの場所<input id="source-path" class="path-input" required placeholder="C:\\Users\\…\\Pictures" autocomplete="off"></label>${output?'':registrationSelect('import-game-registration')}</div>${dialogActions(`<button type="submit" class="primary-button" data-mutates>${output?'出力する':'読み込む'}</button>`)}</form>`);
  $('path-form').onsubmit=event=>{
    event.preventDefault();const path=$('source-path').value.trim(),gameRegistration=output?undefined:$('import-game-registration').value;closeDialog();
    void perform(()=>output?api('/api/export',{path,...outputOptions(),groupMode:outputOptions().exportMode,ids:data.photos.filter(photo=>photo.selected&&!photo.error).map(photo=>photo.id)}):api('/api/import',{path,gameRegistration}),{message:null});
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

function drawScene(canvas,image,faces,jerseys=[]){
  const scale=Math.min(1,1100/image.naturalWidth,620/image.naturalHeight);canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
  const context=canvas.getContext('2d');context.drawImage(image,0,0,canvas.width,canvas.height);
  faces.forEach((face,index)=>{const box=face.box;if(!box)return;const x=box.x*scale,y=box.y*scale,w=box.width*scale,h=box.height*scale;context.lineWidth=3;context.strokeStyle='#d47b2f';context.strokeRect(x,y,w,h);const top=Math.max(0,y-22);context.fillStyle='#874713';context.fillRect(x,top,28,22);context.fillStyle='#fff';context.font='bold 16px sans-serif';context.fillText(String(index+1),x+6,top+17);});
  jerseys.forEach(item=>{const box=item.numberBox||item.bodyBox;if(!box)return;context.lineWidth=3;context.strokeStyle=item.status==='opponent'?'#7c8480':item.personId?'#286348':'#bd6d22';context.strokeRect(box.x*scale,box.y*scale,box.width*scale,box.height*scale);context.font='bold 15px sans-serif';context.fillStyle=context.strokeStyle;context.fillText('#'+(item.number||'?'),box.x*scale,Math.max(16,box.y*scale-5));});
}

async function openPhoto(id){
  if(uniformEnroll){const choice=uniformEnroll;uniformEnroll=null;$('uniform-notice').hidden=true;return openUniformEditor(id,choice);}
  if(enrollMode){enrollMode=false;renderGallery();return openEnrollment(id);}
  showDialog('');activePhotoId=id;await renderPhotoDetail(id);
}

async function renderPhotoDetail(id){
  const photo=getPhoto(id);if(!photo)return;
  const generation=++detailGeneration;activePhotoId=id;
  $('dialog-content').innerHTML=`<form id="photo-form"><div class="dialog-body"><h2 class="photo-detail-title">${esc(photo.name)}</h2><div class="local-photo-stage"><canvas id="photo-scene" aria-label="写真内の顔を番号付きで表示"></canvas></div><div class="local-photo-actions"><button type="button" id="register-from-photo" class="outline-button" data-mutates>顔を選んで人物を登録</button>${!(photo.faceAnalyzed??photo.analyzed)?'<button type="button" id="analyze-photo" class="primary-button" data-mutates>この写真の顔を解析</button>':''}</div><p class="detail-info">${esc(photo.relative||photo.name)}<br>${esc(photo.captureLabel||photo.dateSource||'')} ${photo.error?`<br>${esc(photo.error)}`:''}</p><h3 class="detail-heading">顔ごとに確認・修正</h3><p class="hint">合っていればOK。違っていればNG、または正しい人物名を選んでOK。修正はすぐに保存され、ほかの写真の判定にも使います。</p><div class="face-answer-list" id="face-answer-list"></div><p id="photo-answer-status" class="photo-answer-status" role="status"></p><label class="dialog-field">分類する日付<input id="photo-date" type="date" value="${validDate(photo.date)?photo.date:''}"></label><label class="dialog-field">写真の鮮明さ<select id="photo-blur"><option value="">指定しない</option><option value="sharp" ${photo.blurLabel==='sharp'?'selected':''}>鮮明な写真</option><option value="blur" ${photo.blurLabel==='blur'?'selected':''}>ボケた写真</option></select></label><details><summary>写っている人物を写真全体に手動指定</summary><p class="hint">背中姿など顔が見えない場合は、背番号などを確認して人物を指定できます。この指定は顔の学習例には追加しません。顔のOK／NGでは訂正した人物だけ更新します。</p><div class="detail-pills">${data.people.map(person=>`<label><input type="checkbox" name="photo-person" value="${esc(person.id)}" ${photo.matchedIds?.includes(person.id)?'checked':''}>${esc(person.name)}</label>`).join('')}</div></details><label class="check-line"><input type="checkbox" id="photo-selected" ${photo.selected?'checked':''}> この写真を出力対象にする</label><p class="persist-caption">人物登録・OK／NG・写真の設定は、次回起動時も復元します。</p></div>${dialogActions('<button type="submit" class="primary-button" data-mutates>写真の設定を保存して閉じる</button>')}</form>`;
  paintFaceAnswers(photo);
  const jerseyPosition=photo.jerseys?.length?$('face-answer-list').previousElementSibling.previousElementSibling:$('photo-date').closest('label');
  jerseyPosition.insertAdjacentHTML('beforebegin',`<section><h3 class="detail-heading">背番号と試合</h3><label class="dialog-field">この写真の試合<select id="photo-jersey-game"><option value="">試合未設定</option>${(data.jerseyGames||[]).map(game=>`<option value="${esc(game.id)}" ${game.id===photo.jerseyGameId?'selected':''}>${esc(game.name)}</option>`).join('')}</select></label><button id="read-photo-jersey" type="button" class="outline-button" data-mutates>この写真の背番号を読み直す</button><div id="jersey-result-list"></div></section>`);
  paintJerseyAnswers(photo);
  let peopleChanged=false,gameChanged=false,selectionChanged=false;
  $('photo-selected').onchange=()=>selectionChanged=true;
  $('photo-jersey-game').onchange=()=>{gameChanged=true;$('jersey-result-list').textContent='試合を変更しました。写真の設定を保存するか、背番号を読み直してください。';};
  $('read-photo-jersey').onclick=()=>{if(!$('photo-jersey-game').value)return toast('先にこの写真の試合を指定してください。',true);void perform(async()=>{if(gameChanged){await api('/api/photo',{id,jerseyGameId:$('photo-jersey-game').value});gameChanged=false;}return api('/api/jersey/analyze',{ids:[id],force:true});},{message:null});};
  $('jersey-result-list').onclick=async event=>{
    const button=event.target.closest('[data-jersey-decision]');if(!button||busy())return;
    if(gameChanged)return toast('先に写真の試合設定を保存してください。',true);
    const row=button.closest('[data-jersey-observation]'),decision=button.dataset.jerseyDecision,personId=row.querySelector('select').value;
    if(decision==='ok'&&!personId)return toast('この選手の人物を選んでください。',true);
    const result=await perform(async()=>{if(peopleChanged||selectionChanged){await api('/api/photo',{id,...(peopleChanged?{manualPeople:[...$('photo-form').querySelectorAll('[name=photo-person]:checked')].map(node=>node.value)}:{}),...(selectionChanged?{selected:$('photo-selected').checked}:{})});peopleChanged=false;selectionChanged=false;}return api('/api/jersey/feedback',{photoId:id,observationId:row.dataset.jerseyObservation,gameId:photo.jerseyGameId,teamId:photo.jerseyTeamId,personId,decision});},{message:'背番号の確認を保存しました。'});
    if(result&&activePhotoId===id&&$('dialog').open){const live=getPhoto(id);paintJerseyAnswers(live);$('photo-selected').checked=live.selected;$('photo-form').querySelectorAll('[name=photo-person]').forEach(node=>node.checked=live.matchedIds?.includes(node.value));updateControls();}
  };
  $('photo-form').querySelectorAll('[name=photo-person]').forEach(node=>node.onchange=()=>peopleChanged=true);
  $('register-from-photo').onclick=()=>{closeDialog();void openEnrollment(id);};
  if($('analyze-photo'))$('analyze-photo').onclick=()=>void perform(()=>api('/api/analyze',{ids:[id],recognizeJerseys:false}),{message:null});
  $('photo-form').onsubmit=async event=>{event.preventDefault();const fields={id,date:$('photo-date').value,blurLabel:$('photo-blur').value||null};if(selectionChanged)fields.selected=$('photo-selected').checked;if(fields.date&&!validDate(fields.date))return toast('日付を正しく指定してください。',true);if(peopleChanged)fields.manualPeople=[...$('photo-form').querySelectorAll('[name=photo-person]:checked')].map(node=>node.value);if(gameChanged)fields.jerseyGameId=$('photo-jersey-game').value;const result=await perform(()=>api('/api/photo',fields));if(result)closeDialog();};
  $('face-answer-list').onclick=async event=>{
    const button=event.target.closest('[data-decision]');if(!button||busy())return;
    const card=button.closest('[data-face-id]'),faceId=card.dataset.faceId,personId=card.querySelector('select').value;
    if(!personId)return toast('この顔の人物を選んでください。',true);
    const draftDate=$('photo-date').value,draftBlur=$('photo-blur').value,draftSelected=$('photo-selected').checked;
    const selectedChanged=selectionChanged,manualPeople=peopleChanged?[...$('photo-form').querySelectorAll('[name=photo-person]:checked')].map(node=>node.value):null;
    const result=await perform(async()=>{
      if(gameChanged){await api('/api/photo',{id,jerseyGameId:$('photo-jersey-game').value});gameChanged=false;}
      if(peopleChanged||selectedChanged){await api('/api/photo',{id,...(peopleChanged?{manualPeople}:{}),...(selectedChanged?{selected:draftSelected}:{})});peopleChanged=false;selectionChanged=false;}
      return api('/api/feedback',{faceId,personId,decision:button.dataset.decision});
    },{message:'訂正をPCに保存し、人物の分類に反映しました。'});
    if(result&&activePhotoId===id&&$('dialog').open){
      const live=getPhoto(id);paintFaceAnswers(live);paintJerseyAnswers(live);$('photo-answer-status').textContent='訂正を保存しました。次回もこの回答を使います。';
      $('photo-date').value=draftDate;$('photo-blur').value=draftBlur;$('photo-selected').checked=live.selected;
      $('photo-form').querySelectorAll('[name=photo-person]').forEach(node=>node.checked=live.matchedIds?.includes(node.value));updateControls();
    }
  };
  updateControls();
  try{const image=detailImage?.photoId===id?detailImage.image:await loadImage(id);if(generation!==detailGeneration||activePhotoId!==id)return;detailImage={photoId:id,image};drawScene($('photo-scene'),image,photo.faces||[],photo.jerseys||[]);}catch(error){if(generation===detailGeneration)$('photo-answer-status').textContent=error.message;}
}

function paintJerseyAnswers(photo){
  if(!$('jersey-result-list'))return;
  if(photo.jerseyError){$('jersey-result-list').innerHTML=`<p class="hint">${esc(photo.jerseyError)}</p>`;return;}
  $('jersey-result-list').innerHTML=(photo.jerseys||[]).map((item,index)=>`<article class="jersey-result ${item.status==='review'?'review':''}" data-jersey-observation="${esc(item.id)}"><strong>選手 ${index+1} · 背番号 ${esc(item.number||'読めず')} · ${item.team==='own'?'味方':item.team==='opponent'?'相手':'チーム不明'}${item.personId?' · '+esc(getPerson(item.personId)?.name||''):''}</strong><p>${esc(item.reason||'確認してください。')}</p><select aria-label="背番号の選手 ${index+1}の人物"><option value="">人物を選ぶ</option>${data.people.map(person=>`<option value="${esc(person.id)}" ${person.id===item.personId?'selected':''}>${esc(person.name)}</option>`).join('')}</select><div class="jersey-result-actions"><button type="button" class="primary-button" data-jersey-decision="ok" data-mutates>OK・本人</button><button type="button" class="outline-button" data-jersey-decision="ng" data-mutates>NG・除外</button></div></article>`).join('')||`<p class="hint">${!photo.jerseyGameId?'試合を設定すると、その試合のユニフォーム見本と番号表で判定します。':photo.jerseyScanned?'背番号を確認できませんでした。必要なら写真全体に人物を手動指定してください。':'味方・相手の見本と番号表を登録して、背番号を読み取ってください。'}</p>`;
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
    if(!(photo.faceAnalyzed??photo.analyzed)){
      pending++;updateControls();
      try{await api('/api/analyze',{ids:[id],recognizeJerseys:false});await waitJob();photo=getPhoto(id);}
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
    if(!(photo.faceAnalyzed??photo.analyzed)){
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
  showDialog(`<div class="dialog-body"><h2>フォルダから解析まで、順番に。</h2><ol class="help-list"><li><strong>フォルダを読み込む</strong>。このPCの写真だけを処理します。</li><li><strong>試合を登録</strong>。撮影日時から自動作成するか、手動で写真の範囲を設定します。読み込み時の自動登録が済んでいれば、その試合を使えます。</li><li><strong>チームと味方のユニフォームを選択</strong>。保存したチーム名簿と4種類の見本を呼び出せます。未登録なら名簿や味方の見本を追加します。</li><li><strong>相手のユニフォームを登録</strong>。この試合の相手のシャツ部分を四角で囲みます。</li><li><strong>写真を解析</strong>。読み込んだ全写真の顔を先に解析し、背番号認識がオンなら設定済みの試合の写真を続けて確認します。一覧の絞り込みに関係なく、全写真が顔認識の対象です。</li></ol><p>背番号認識は初期状態でオンです。試合がない場合は顔認識を完了し、試合登録が必要なことを表示します。通常の写真整理はチェックを外すと顔認識だけで進められます。オフにしても保存済みの背番号結果やOK／NGは保持します。</p><p>顔の初回登録は「人物の顔を登録・管理」から行えます。写真を開き、顔や番号の結果をOK／NGで直します。登録・訂正・プロジェクトはPCへ保存されます。</p><p>必要に応じて日付・イベント・容量を設定し、フォルダへ出力してください。写真は外部サービスへ送りません。</p></div>${dialogActions('')}`);
}

for(const id of ['choose-source','empty-import'])$(id).onclick=()=>void pickSource();
$('enter-source').onclick=()=>enterSource();$('add-person').onclick=addPerson;$('add-event').onclick=()=>editEvent();
$('choose-face-photo').onclick=()=>{uniformEnroll=null;$('uniform-notice').hidden=true;enrollMode=true;filter='all';page=0;$('person-filter').value='';$('date-filter').value='';document.querySelectorAll('[data-filter]').forEach(button=>button.classList.toggle('active',button.dataset.filter==='all'));renderGallery();$('gallery').scrollIntoView({behavior:'smooth',block:'start'});};
$('cancel-enroll').onclick=()=>{enrollMode=false;renderGallery();};
$('people-list').onclick=event=>{const person=event.target.closest('[data-person]');if(person){currentPerson=person.dataset.person;renderPeople();}};
$('scan-button').onclick=()=>void perform(()=>api('/api/analyze',{recognizeJerseys:$('recognize-jerseys').checked}),{message:null});
$('recognize-jerseys').onchange=event=>{const recognizeJerseys=event.target.checked;renderWorkflow();void perform(()=>api('/api/settings',{recognizeJerseys}),{message:null});};
$('event-list').onclick=event=>{const button=event.target.closest('[data-event]');if(button&&!busy())editEvent(data.events.find(item=>item.id===button.dataset.event));};
$('day-list').onclick=event=>{const add=event.target.closest('[data-day-event]');if(add&&!busy()){const day=add.dataset.dayEvent;return editEvent(data.events.find(item=>day>=item.start&&day<=item.end),day);}const day=event.target.closest('[data-day]');if(day){$('date-filter').value=day.dataset.day;page=0;renderGallery();}};
$('gallery').onclick=event=>{const button=event.target.closest('[data-photo]');if(button)void openPhoto(button.dataset.photo);};
$('gallery').onchange=event=>{const id=event.target.dataset.select;if(id){const selected=event.target.checked;void perform(()=>api('/api/photo',{id,selected}),{message:null});}};
$('photo-sort').onchange=()=>{page=0;renderGallery();void perform(()=>api('/api/settings',{photoSort:$('photo-sort').value}),{message:null});};
for(const id of ['person-filter','date-filter','game-filter'])$(id).onchange=()=>{page=0;renderGallery();updateControls();};
document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.filter;page=0;document.querySelectorAll('[data-filter]').forEach(node=>node.classList.toggle('active',node===button));renderGallery();});
for(const [id,selected] of [['select-visible',true],['clear-visible',false]])$(id).onclick=()=>void perform(async()=>{for(const photo of visible())if(!photo.error)await api('/api/photo',{id:photo.id,selected});},{message:null});
$('prev-page').onclick=()=>{page--;renderGallery();};$('next-page').onclick=()=>{page++;renderGallery();};
for(const id of ['compress','target-size','target-unit','export-mode'])$(id).onchange=()=>void saveSettings();
$('export-folder').onclick=()=>void exportFolder();
$('cancel-job').onclick=async()=>{try{await api('/api/cancel',{});await refresh();}catch(error){toast(error.message,true);}};
$('help-button').onclick=help;
$('shutdown-button').onclick=async()=>{
  if(busy())return;
  try{await api('/api/shutdown',{});clearTimeout(pollTimer);connected=false;updateControls();$('save-status').textContent='保存して終了しました';$('connection-notice').hidden=false;$('connection-notice').textContent='PC内のプログラムを終了しました。このタブを閉じてください。次のWindowsサインイン時に自動起動します。今すぐ再開する場合は起動用ファイルを使ってください。';}
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
    if(!accessToken){$('connection-message').textContent='初回だけStart-PhotoSorter.cmdから接続を登録してください。以後はPagesを開くだけで接続できます。';return;}
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
    if(!bootstrapToken&&!accessToken){$('connection-message').textContent='初回だけPC側のStart-PhotoSorter.cmdで接続を登録してください。次回からはこのページを開くだけで使えます。';return;}
    let permission='prompt';
    for(const name of ['loopback-network','local-network-access']){
      try{permission=(await navigator.permissions.query({name})).state;break;}catch{}
    }
    if(permission==='granted')await connect();
    else $('connection-message').textContent=permission==='denied'?'ブラウザのサイト設定でローカル接続を許可し、「PCに接続する」を押してください。':'「PCに接続する」を押し、ローカル接続の許可が表示されたら許可してください。写真はこのPCとの間だけで扱います。';
  }catch(error){connectionError(error.message);}
}
void start();
