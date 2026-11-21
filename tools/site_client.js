/* ================= САЙТ: работа с сервером ================= */
async function api(path,opt={}){
  const o={method:opt.method||'GET',credentials:'same-origin',headers:{'X-Requested-With':'dd'}};
  if(opt.body!==undefined){o.headers['Content-Type']='application/json';o.body=JSON.stringify(opt.body)}
  let r; try{r=await fetch('/api'+path,o)}catch(e){const err=new Error('Нет связи с сервером');err.status=0;throw err}
  let j=null; try{j=await r.json()}catch(e){}
  if(!r.ok){const err=new Error((j&&j.error)||('Ошибка '+r.status));err.status=r.status;throw err}
  return j;
}
function sessionLost(){toast('Сессия завершена','Войдите заново',{icon:'lock',tone:'err'});setTimeout(()=>location.reload(),1200)}
let saveT=null;
save=()=>{clearTimeout(saveT);saveT=setTimeout(()=>{if(!S)return;const {reqs,...rest}=S;api('/state',{method:'PUT',body:rest}).catch(e=>{if(e.status===401)sessionLost();else toast('Не удалось сохранить','Проверьте подключение, попробуем ещё раз',{icon:'alert',tone:'err'})})},350)};
function loadS(){}
window.SRV_NEWS=[];
async function refreshReqs(){S.reqs=await api('/requests');renderOffice()}
async function createReq(t,purpose){
  try{const r=await api('/requests',{method:'POST',body:{t,purpose:purpose||''}});S.reqs.unshift(r);renderOffice();return r}
  catch(e){if(e.status===401)sessionLost();else toast('Заявка не отправлена',e.message,{icon:'alert',tone:'err'});return null}
}
async function startSession(me,anim){
  me.reqs=[]; me.certs=me.certs||[];
  USERS[me.login]=me; U=me; swapData(); setWeek(0,true);
  try{
    const [st,rq,nw]=await Promise.all([api('/state'),api('/requests'),api('/news')]);
    S=Object.assign(DEF(),st||{}); S.reqs=rq||[]; window.SRV_NEWS=nw||[];
  }catch(e){if(e.status===401){showLogin();return}S=Object.assign(DEF(),{});S.reqs=[];toast('Часть данных не загрузилась',e.message,{icon:'alert',tone:'err'})}
  rbSem=4; newsCat='all'; setGTab('cur'); clubMode=null; clubQ=''; clubCat='all'; if($('#clubSearch'))$('#clubSearch').value=''; openNews=null; selDay=TODAY;
  renderAll(); aiReset();
  const upd=S.reqs.filter(r=>r.upd);
  if(upd.length){setTimeout(()=>upd.forEach((r,k)=>setTimeout(()=>toast(r.st==='no'?'Заявка отклонена':r.st==='ok'?'Заявка готова':'Заявка принята в работу',`${r.t}${r.purpose?' '+r.purpose:''} · ${r.no}`,{icon:r.st==='no'?'x':'check',tone:r.st==='no'?'err':undefined}),k*400)),anim?1500:400);api('/requests/seen',{method:'POST'}).catch(()=>{})}
  const done=()=>{document.body.classList.remove('locked');$('#login').hidden=true;$('#boot').classList.remove('on');current=null;show((location.hash||'#home').slice(1))};
  if(!anim){done();return}
  $('#boot').classList.add('on'); $('#login').hidden=true;
  setTimeout(()=>{done();toast(`Добро пожаловать, ${U.first}!`,`Последний вход: ${U.lastIn}`,{icon:'shield'})},700);
}
async function doLogout(){try{await api('/logout',{method:'POST'})}catch(e){} try{history.replaceState(null,'','#home')}catch(e){} location.reload()}
function logout(){aiOpen(false);doLogout()}
['#logoutBtn','#logoutRail','#staffOut'].forEach(sel=>{const n=$(sel);if(!n)return;const c=n.cloneNode(true);n.replaceWith(c);c.addEventListener('click',sel==='#staffOut'?doLogout:logout)});

/* --- вход --- */
$('#lgForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const li=$('#lgLogin'), pi=$('#lgPass'), l=li.value.trim().toLowerCase(), p=pi.value;
  li.classList.toggle('bad',!l); pi.classList.toggle('bad',!p);
  if(!l||!p)return lgErr(!l&&!p?'Введите логин и пароль.':!l?'Введите логин.':'Введите пароль.');
  const b=$('#lgBtn'); b.disabled=true; b.innerHTML='<span class="spin"></span>Проверяем…';
  try{
    const me=await api('/login',{method:'POST',body:{login:l,password:p,remember:$('#lgRemember').checked}});
    try{history.replaceState(null,'','#home')}catch(x){}
    if(me.role==='staff'){STAFF.dekanat=me;startStaff(true)} else await startSession(me,true);
  }catch(err){
    b.disabled=false; b.innerHTML=ic('lock',17)+'Войти';
    if(err.status===401){pi.value='';pi.classList.add('bad');pi.focus();lgErr('Неверный логин или пароль. Проверьте раскладку и Caps Lock.')}
    else lgErr(err.message);
  }
});

/* --- кабинет сотрудника: данные с сервера --- */
let X_REQS=[], X_NEWS=[];
async function staffLoad(){try{[X_REQS,X_NEWS]=await Promise.all([api('/staff/requests'),api('/staff/news')])}catch(e){if(e.status===401)return sessionLost();toast('Не удалось загрузить данные',e.message,{icon:'alert',tone:'err'})}renderStaff()}
function allReqs(){return X_REQS.map(r=>({...r,src:r.login?r.login:'x',i:r.id}))}
loadN=()=>X_NEWS.map(n=>({...n,i:n.id}));
function setReq(src,i,patch){api('/staff/requests/'+i,{method:'PATCH',body:{st:patch.st,note:(patch.note||'').replace(/^Причина: /,'')}}).then(staffLoad).catch(e=>{toast('Не удалось изменить статус',e.message,{icon:'alert',tone:'err'});staffLoad()})}
const _rs=renderStaff;
function startStaff(anim){
  document.body.classList.remove('locked'); document.body.classList.add('staff-mode'); $('#login').hidden=true; $('#staff').hidden=false; aiOpen(false);
  stTab='req'; stFilter='open'; stReject=null; renderStaff(); staffLoad();
  if(anim){$('#boot').classList.add('on');setTimeout(()=>{$('#boot').classList.remove('on');toast('Добрый день, Наталья Петровна!','Вы вошли как сотрудник деканата',{icon:'shield'})},600)}
}
['#stForm','#stPub'].forEach(sel=>{const n=$(sel),c=n.cloneNode(true);n.replaceWith(c)});
$('#stForm').addEventListener('submit',async e=>{
  e.preventDefault(); const t=$('#stT').value.trim(), p=$('#stP').value.trim();
  if(!t||!p){toast('Заполните заголовок и текст','',{icon:'alert',tone:'err'});return}
  try{await api('/staff/news',{method:'POST',body:{t,p,cat:$('#stC').value,aud:$('#stA').value}});$('#stForm').reset();await staffLoad();toast('Объявление опубликовано','Студенты увидят его в ленте новостей',{icon:'news'})}
  catch(err){toast('Не опубликовано',err.message,{icon:'alert',tone:'err'})}
});
$('#stPub').addEventListener('click',async e=>{const b=e.target.closest('[data-unpub]');if(!b)return;const n=X_NEWS[+b.dataset.unpub];if(!n)return;try{await api('/staff/news/'+n.id,{method:'DELETE'});await staffLoad();toast('Объявление снято','',{icon:'x',tone:'info'})}catch(err){toast('Не удалось снять',err.message,{icon:'alert',tone:'err'})}});

/* --- ИИ: настоящая нейросеть через сервер, если ключ настроен; иначе правила --- */
let AI_REMOTE=null; const aiHist=[];
async function aiAsk(q){
  if(!q.trim())return; aiMsg('me',esc(q));
  const t=document.createElement('div'); t.className='ai-msg bot'; t.innerHTML='<div class="ai-bubble ai-typing"><i></i><i></i><i></i></div>'; $('#aiLog').appendChild(t); $('#aiLog').scrollTop=1e6;
  let a=null; const local=/справк|волонт/i.test(q);
  if(!local&&AI_REMOTE!==false){
    try{const r=await api('/ai',{method:'POST',body:{q,history:aiHist.slice(-6)}});
      if(r&&r.text){AI_REMOTE=true;a={t:esc(r.text).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/\n/g,'<br>')};aiHist.push({role:'user',text:q},{role:'assistant',text:r.text})}
      else if(r&&r.fallback)AI_REMOTE=false;
    }catch(e){if(e.status===429)a={t:esc(e.message)}}
  }
  if(!a){await new Promise(r=>setTimeout(r,450));a=aiAnswer(q)}
  t.remove(); aiMsg('bot',a.t,a.chips,a.card);
}
