/** Pick detected faces or draw an original-image region without changing pixels. */
export function mountFaceEditor({
  container, canvas: source, faces = [], profiles = [], activePersonId = null,
  onRegister, onClose = () => {}, onError = () => {},
}) {
  if (!container || !source?.width || !source?.height) throw new Error('登録する写真を表示できません。');
  const events = new AbortController();
  const assigned = new Map();
  const manualAssignments = [];
  let candidates = [...faces];
  let people = [...profiles];
  let selected = null;
  let drawing = false;
  let drag = null;
  let busy = false;
  let destroyed = false;
  let displayWidth = 1, displayHeight = 1;

  function element(tag, {className, text, id, type, ...attributes} = {}, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    if (id) node.id = id;
    if (type) node.type = type;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    if (parent) parent.append(node);
    return node;
  }
  function listen(node, event, handler) { node.addEventListener(event, handler, {signal: events.signal}); }

  const root = element('section', {className:'face-editor'}, container);
  const heading = element('div', {className:'face-editor-heading'}, root);
  element('h2', {text:'写真から人物を登録'}, heading);
  element('p', {text:'登録する顔の四角を選んでください。同じ写真から、複数の人物を順に登録できます。'}, heading);
  const toolbar = element('div', {className:'face-editor-toolbar'}, root);
  const drawButton = element('button', {id:'draw-face', className:'outline-button', type:'button', text:'顔を囲んで指定', 'aria-pressed':'false'}, toolbar);
  const clearButton = element('button', {className:'text-button', type:'button', text:'選択を解除'}, toolbar);
  const selectionLabel = element('span', {className:'face-editor-selection', text:'顔を選択してください'}, toolbar);
  const stage = element('div', {className:'face-editor-stage'}, root);
  const display = element('canvas', {id:'face-editor-canvas', 'aria-label':'写真内の顔を選ぶ。手動指定ではドラッグして顔を囲みます。'}, stage);
  const context = display.getContext('2d');
  if (!context) { root.remove(); throw new Error('写真を表示するための領域を作れません。'); }
  const list = element('div', {className:'face-editor-faces', 'aria-label':'検出した顔'}, root);
  const controls = element('div', {className:'face-editor-controls'}, root);
  const targetLabel = element('label', {className:'face-editor-field'}, controls);
  element('span', {text:'登録先の人物'}, targetLabel);
  const target = element('select', {id:'face-target-person', 'aria-label':'登録先の人物'}, targetLabel);
  const newNameLabel = element('label', {className:'face-editor-field'}, controls);
  element('span', {text:'新しい人物の名前'}, newNameLabel);
  const newName = element('input', {id:'face-new-name', type:'text', maxlength:'60', placeholder:'例：はると', autocomplete:'off'}, newNameLabel);
  const status = element('p', {id:'face-editor-status', className:'face-editor-status', role:'status', 'aria-live':'polite'}, root);
  const footer = element('div', {className:'face-editor-actions'}, root);
  element('p', {text:'写真と顔の登録は、この端末内で処理します。'}, footer);
  const closeButton = element('button', {className:'outline-button', type:'button', text:'閉じる'}, footer);
  const registerButton = element('button', {id:'register-face', className:'primary-button', type:'button', text:'選んだ顔を登録'}, footer);

  function normalizedRegion(start, end) {
    const x0 = Math.max(0, Math.min(source.width, Math.min(start.x, end.x)));
    const y0 = Math.max(0, Math.min(source.height, Math.min(start.y, end.y)));
    const x1 = Math.max(0, Math.min(source.width, Math.max(start.x, end.x)));
    const y1 = Math.max(0, Math.min(source.height, Math.max(start.y, end.y)));
    return {x:x0, y:y0, width:x1-x0, height:y1-y0};
  }

  function originalPoint(event) {
    const rect = display.getBoundingClientRect();
    return {
      x:Math.max(0,Math.min(source.width,(event.clientX-rect.left)/rect.width*source.width)),
      y:Math.max(0,Math.min(source.height,(event.clientY-rect.top)/rect.height*source.height)),
    };
  }

  function labelBox(box, text, color, active = false) {
    const scaleX = displayWidth/source.width, scaleY = displayHeight/source.height;
    const x=box.x*scaleX, y=box.y*scaleY, width=box.width*scaleX, height=box.height*scaleY;
    context.lineWidth = active ? 3 : 2;
    context.strokeStyle = color;
    context.strokeRect(x,y,width,height);
    context.font = '600 12px sans-serif';
    const label = text.length > 18 ? `${text.slice(0,17)}…` : text;
    const labelWidth = Math.min(displayWidth,context.measureText(label).width+10);
    const labelX = Math.max(0,Math.min(x,displayWidth-labelWidth));
    const labelY = y>=21 ? y-21 : Math.min(displayHeight-21,y+2);
    context.fillStyle = color;
    context.fillRect(labelX,labelY,labelWidth,21);
    context.fillStyle = '#ffffff';
    context.fillText(label,labelX+5,labelY+15);
  }

  function paint() {
    if (destroyed) return;
    const ratio=Math.min(2,Math.max(1,globalThis.devicePixelRatio||1));
    const available = Math.max(1,Math.min(900,stage.clientWidth||900));
    const scale=Math.min(1,available/source.width,480/source.height);
    displayWidth=Math.max(1,Math.round(source.width*scale));
    displayHeight=Math.max(1,Math.round(source.height*scale));
    display.width=Math.round(displayWidth*ratio);
    display.height=Math.round(displayHeight*ratio);
    display.style.width=`${displayWidth}px`;
    display.style.height=`${displayHeight}px`;
    context.setTransform(ratio,0,0,ratio,0,0);
    context.clearRect(0,0,displayWidth,displayHeight);
    context.drawImage(source,0,0,displayWidth,displayHeight);
    candidates.forEach((face,index)=>{
      const name=assigned.get(index);
      labelBox(face.box,`${index+1}${name?` · ${name}`:''}`,selected?.index===index?'#195c3d':name?'#477c64':'#b57b28',selected?.index===index);
    });
    manualAssignments.forEach(item=>labelBox(item.region,item.name,'#477c64'));
    if(selected?.index==null&&selected?.region)labelBox(selected.region,'手動指定','#c16c32',true);
    display.classList.toggle('drawing',drawing);
  }

  function setStatus(text, error = false) {
    if(destroyed)return;
    status.textContent=text;
    status.classList.toggle('error',error);
  }

  function updateEnabled() {
    if(destroyed)return;
    const valid=selected&&selected.region.width>=16&&selected.region.height>=16;
    registerButton.disabled=busy||!valid||(!target.value&&!newName.value.trim());
    registerButton.textContent=busy?'登録しています…':'選んだ顔を登録';
    target.disabled=busy;
    newName.disabled=busy;
    drawButton.disabled=busy;
    clearButton.disabled=busy||!selected;
    newNameLabel.hidden=!!target.value;
    for(const button of list.querySelectorAll('[data-face-index]'))button.disabled=busy;
    drawButton.setAttribute('aria-pressed',String(drawing));
    drawButton.textContent=drawing?'顔全体をドラッグして囲む':'顔を囲んで指定';
    selectionLabel.textContent=selected?(selected.index==null?'手動で囲んだ顔':`選択中：顔 ${selected.index+1}`):'顔を選択してください';
  }

  function choose(index) {
    if(busy||destroyed||!candidates[index])return;
    drawing=false;drag=null;
    selected={index,face:candidates[index],region:{...candidates[index].box}};
    setStatus(`顔 ${index+1} を選択しました。登録先を確認してください。`);
    renderFaceButtons();updateEnabled();paint();
  }

  function renderFaceButtons() {
    list.replaceChildren();
    if(!candidates.length)element('span',{className:'muted',text:'顔が見つからない場合は「顔を囲んで指定」で顔全体を囲んでください。'},list);
    candidates.forEach((face,index)=>{
      const button=element('button',{type:'button',className:`face-editor-face${selected?.index===index?' active':''}`,text:`顔 ${index+1}${assigned.has(index)?` · ${assigned.get(index)}`:''}`,'aria-pressed':String(selected?.index===index)},list);
      button.dataset.faceIndex=String(index);
      button.disabled=busy;
      // Event delegation below keeps redraws from retaining detached buttons.
    });
  }

  function setProfiles(nextProfiles, activeId = target.value) {
    if(destroyed)return;
    people=[...nextProfiles];
    target.replaceChildren();
    element('option',{value:'',text:'＋ 新しい人物を登録'},target);
    for(const person of people)element('option',{value:person.id,text:person.name},target);
    target.value=people.some(person=>person.id===activeId)?activeId:'';
    updateEnabled();
  }

  function setFaces(nextFaces) {
    if(destroyed)return;
    candidates=[...nextFaces];
    if(selected?.index!=null)selected=null;
    assigned.clear();
    if(!selected)setStatus(candidates.length?`写真から ${candidates.length}人の顔を検出しました。登録する顔を選んでください。`:'顔が見つかりませんでした。「顔を囲んで指定」で顔全体を囲んでください。');
    renderFaceButtons();updateEnabled();paint();
  }

  async function register() {
    if(busy||destroyed||registerButton.disabled||!selected)return;
    const choice={...selected,region:{...selected.region}};
    const personId=target.value||null;
    const name=personId?people.find(person=>person.id===personId)?.name:newName.value.trim();
    if(!name){setStatus('人物の名前を入力してください。',true);return;}
    busy=true;updateEnabled();setStatus('顔を確認して登録しています…');
    try{
      const result=await onRegister({personId,name,face:choice.face,region:choice.region});
      if(destroyed)return;
      if(result?.profiles)setProfiles(result.profiles,result.personId||personId);
      const registeredName=result?.profiles?.find(person=>person.id===result.personId)?.name||name;
      if(choice.index==null)manualAssignments.push({region:choice.region,name:registeredName});
      else assigned.set(choice.index,registeredName);
      selected=null;newName.value='';
      setStatus(result?.message||`${registeredName}として登録しました。別の人も、登録先を変えて順に登録できます。`);
    }catch(error){
      if(!destroyed){setStatus(error.message||'顔を登録できませんでした。',true);onError(error);}
    }finally{
      busy=false;
      if(!destroyed){renderFaceButtons();updateEnabled();paint();}
    }
  }

  listen(target,'change',()=>{updateEnabled();if(!target.value)newName.focus();});
  listen(newName,'input',updateEnabled);
  listen(newName,'keydown',event=>{if(event.key==='Enter'){event.preventDefault();void register();}});
  listen(registerButton,'click',()=>void register());
  listen(closeButton,'click',()=>onClose());
  listen(list,'click',event=>{const button=event.target.closest('[data-face-index]');if(button)choose(Number(button.dataset.faceIndex));});
  listen(drawButton,'click',()=>{if(busy)return;drawing=!drawing;selected=null;drag=null;setStatus(drawing?'写真上で、目・鼻・口を含む顔全体をドラッグして囲んでください。':'検出した顔の四角を選んでください。');renderFaceButtons();updateEnabled();paint();});
  listen(clearButton,'click',()=>{if(busy)return;selected=null;drag=null;setStatus('登録する顔を選択してください。');renderFaceButtons();updateEnabled();paint();});
  listen(display,'pointerdown',event=>{
    if(busy||event.button!==0)return;
    event.preventDefault();
    const point=originalPoint(event);
    if(drawing){
      drag={start:point,pointerId:event.pointerId};
      selected={index:null,region:normalizedRegion(point,point)};
      display.setPointerCapture?.(event.pointerId);
      renderFaceButtons();updateEnabled();paint();
    }else{
      const hit=candidates.map((face,index)=>({face,index})).filter(({face})=>point.x>=face.box.x&&point.x<=face.box.x+face.box.width&&point.y>=face.box.y&&point.y<=face.box.y+face.box.height).sort((a,b)=>a.face.box.width*a.face.box.height-b.face.box.width*b.face.box.height)[0];
      if(hit)choose(hit.index);else setStatus('顔の四角を選ぶか、「顔を囲んで指定」を使ってください。');
    }
  });
  listen(display,'pointermove',event=>{if(!drag||event.pointerId!==drag.pointerId)return;event.preventDefault();selected={index:null,region:normalizedRegion(drag.start,originalPoint(event))};updateEnabled();paint();});
  listen(display,'pointerup',event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    event.preventDefault();
    selected={index:null,region:normalizedRegion(drag.start,originalPoint(event))};
    if(display.hasPointerCapture?.(event.pointerId))display.releasePointerCapture(event.pointerId);
    drag=null;
    if(selected.region.width<16||selected.region.height<16){selected=null;setStatus('顔全体が入るように、少し大きくドラッグしてください。',true);}
    else{drawing=false;setStatus('囲んだ顔を選択しました。登録先を確認して登録してください。');}
    updateEnabled();paint();
  });
  listen(display,'pointercancel',()=>{drag=null;selected=null;updateEnabled();paint();});

  const observer=typeof ResizeObserver==='function'?new ResizeObserver(paint):null;
  observer?.observe(stage);
  setProfiles(people,activePersonId);
  renderFaceButtons();updateEnabled();paint();
  setStatus(candidates.length?`写真から ${candidates.length}人の顔を検出しました。登録する顔を選んでください。`:'顔を検出中です。手動で顔を囲んで指定することもできます。');
  return {setFaces,setProfiles,setStatus,destroy(){
    if(destroyed)return;
    destroyed=true;events.abort();observer?.disconnect();drag=null;
    display.width=display.height=1;root.remove();
  }};
}
