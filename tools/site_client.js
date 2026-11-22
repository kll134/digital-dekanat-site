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
  USERS[me.login]=me; U=me; swapData(); setWeek(LIVE_WEEK,true);
  try{
    const [st,rq,nw]=await Promise.all([api('/state'),api('/requests'),api('/news')]);
    S=Object.assign(DEF(),st||{}); S.reqs=rq||[]; window.SRV_NEWS=nw||[];
    const subs=await api('/submissions').catch(()=>[]);
    const submitted=new Map((subs||[]).map(x=>[String(x.task_id),x]));
    tasks.forEach(t=>{const sub=submitted.get(String(t.id)); if(sub){t.sent=true;t.submission=sub;}});
  }catch(e){if(e.status===401){showLogin();return}S=Object.assign(DEF(),{});S.reqs=[];toast('Часть данных не загрузилась',e.message,{icon:'alert',tone:'err'})}
  rbSem=4; newsCat='all'; setGTab('cur'); clubMode=null; clubQ=''; clubCat='all'; if($('#clubSearch'))$('#clubSearch').value=''; openNews=null; selDay=TODAY>=0?TODAY:0;
  renderAll();
  const upd=S.reqs.filter(r=>r.upd);
  if(upd.length){setTimeout(()=>upd.forEach((r,k)=>setTimeout(()=>toast(r.st==='no'?'Заявка отклонена':r.st==='ok'?'Заявка готова':'Заявка принята в работу',`${r.t}${r.purpose?' '+r.purpose:''} · ${r.no}`,{icon:r.st==='no'?'x':'check',tone:r.st==='no'?'err':undefined}),k*400)),anim?1500:400);api('/requests/seen',{method:'POST'}).catch(()=>{})}
  const done=()=>{document.body.classList.remove('locked');$('#login').hidden=true;$('#boot').classList.remove('on');current=null;show((location.hash||'#home').slice(1))};
  if(!anim){done();return}
  $('#boot').classList.add('on'); $('#login').hidden=true;
  setTimeout(()=>{done();toast(`Добро пожаловать, ${U.first}!`,`Последний вход: ${U.lastIn}`,{icon:'shield'})},700);
}
async function doLogout(){try{await api('/logout',{method:'POST'})}catch(e){} try{history.replaceState(null,'','#home')}catch(e){} location.reload()}
function logout(){doLogout()}
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

/* --- кабинет сотрудника: реальные данные и действия через API --- */
let X_REQS=[], X_NEWS=[], X_STUDENTS=[], X_STUDENT_DETAIL=null, X_STUDENT_SELECTED=null;
let staffRequestQuery='', staffStudentQuery='', lastStaffDetailMinute='';
const STAFF_STATUS={wait:['st-wait','Новая'],work:['st-auto','В работе'],ok:['st-ok','Готово'],no:['st-bad','Отклонено']};
function allReqs(){return X_REQS.map(r=>({...r,src:r.login||'x',i:r.id}))}
loadN=()=>X_NEWS.map(n=>({...n,i:n.id}));
async function staffLoad(){
  try{
    [X_REQS,X_NEWS,X_STUDENTS]=await Promise.all([api('/staff/requests'),api('/staff/news'),api('/staff/students')]);
    const aud=$('#stA');
    if(aud){const selected=aud.value||'all', groups=[...new Set(X_STUDENTS.map(x=>x.grp).filter(Boolean))];aud.innerHTML='<option value="all">Все студенты</option>'+groups.map(g=>`<option value="${esc(g)}">Группа ${esc(g)}</option>`).join('');aud.value=groups.includes(selected)?selected:'all';}
  }catch(e){if(e.status===401)return sessionLost();toast('Не удалось загрузить данные',e.message,{icon:'alert',tone:'err'});}
  renderStaff();
}
function staffInitials(name){return String(name||'').split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase()||'СД'}
function staffStatus(s){return STAFF_STATUS[s]||['','Неизвестно']}
function setReq(src,i,patch){
  return api('/staff/requests/'+i,{method:'PATCH',body:{st:patch.st,note:(patch.note||'').replace(/^Причина: /,'')}})
    .then(staffLoad).catch(e=>{toast('Не удалось изменить статус',e.message,{icon:'alert',tone:'err'});staffLoad();});
}
function staffRenderStudentDetail(){
  const host=$('#stStudentDetail');if(!host)return;
  const d=X_STUDENT_DETAIL;
  if(!d){host.innerHTML='<div class="st-detail-empty"><span data-ic="users" data-s="24"></span><b>Выберите студента</b><small>Откройте карточку, чтобы посмотреть основные сведения, успеваемость, обращения и сегодняшнее расписание.</small></div>';return;}
  const initials=staffInitials(d.full), requests=d.requests||[], subjects=d.disc2||[], submitted=d.submissions||[];
  const day=moscowDayIndex(), week=LIVE_WEEK%2?(d.Lb&&d.Lb.length?d.Lb:d.L):d.L;
  const p=moscowParts(), currentMin=p.hour*60+p.minute;
  const lessons=day>=0&&Array.isArray(week)?(week[day]||[]):[];
  const schedule=lessons.length?lessons.map(l=>{
    const a=toMin(l.a),b=toMin(l.b),state=currentMin>=a&&currentMin<b?'now':currentMin<a?'next':'past';
    return `<div class="st-schedule-row"><time>${fmt(l.a)}–${fmt(l.b)}</time><div><b>${esc(l.t)}</b><small>${esc(l.k||'Занятие')} · ${esc(l.r||'Аудитория не указана')} · ${esc(l.p||'')}</small>${state==='now'?'<span class="live"><i></i>Идёт сейчас</span>':state==='next'?'<small>Следующая пара</small>':''}</div></div>`;
  }).join(''):'<div class="st-no-results">На сегодня занятий по расписанию нет.</div>';
  const reqHtml=requests.length?requests.slice(0,5).map(r=>{const st=staffStatus(r.st);return `<div class="st-subject-row"><span>${esc(r.t)}<small>${esc(r.no)} · ${esc(r.when)}</small></span><strong class="status ${st[0]}">${st[1]}</strong></div>`}).join(''):'<div class="st-no-results">Обращений пока нет.</div>';
  const subHtml=submitted.length?submitted.slice(0,6).map(x=>`<div class="st-subject-row"><span>${esc(x.task_title)}<small>${esc(x.file_name)} · ${(Number(x.size)/1024).toFixed(1)} КБ</small><a class="link-btn" href="/api/staff/submissions/${Number(x.id)}" rel="nofollow">Скачать работу</a></span><strong>Прикреплено</strong></div>`).join(''):'<div class="st-no-results">Отправленных файлов пока нет.</div>';
  host.innerHTML=`
    <div class="st-detail-head"><span class="avatar">${esc(initials)}</span><div><h3>${esc(d.full)}</h3><p>${esc(d.grp)} · ${d.course} курс</p></div></div>
    <div class="st-detail-facts">
      <div class="st-detail-fact"><small>Факультет</small><b>${esc(d.fac)}</b></div>
      <div class="st-detail-fact"><small>Направление</small><b>${esc(d.dir)}</b></div>
      <div class="st-detail-fact"><small>Средний балл</small><b>${esc(String(d.avg||'—'))}</b></div>
      <div class="st-detail-fact"><small>Посещаемость</small><b>${d.att==null?'—':esc(String(d.att))+'%'}</b></div>
      <div class="st-detail-fact"><small>Куратор</small><b>${esc(d.curator||'Не указан')}</b></div>
      <div class="st-detail-fact"><small>Форма обучения</small><b>${esc(d.form||'—')}</b></div>
    </div>
    <section class="st-detail-section"><h4>Успеваемость по дисциплинам</h4>${subjects.length?subjects.slice(0,6).map(x=>`<div class="st-subject-row"><span>${esc(x.t)}<small>${esc(x.c||'Дисциплина')} · пропусков: ${(x.miss||[]).length}</small></span><strong>${Number(x.pts)||0}/100</strong></div>`).join(''):'<div class="st-no-results">Данные об успеваемости не заполнены.</div>'}</section>
    <section class="st-detail-section"><h4>Расписание на сегодня · ${esc(moscowDateText())}</h4>${schedule}</section>
    <section class="st-detail-section"><h4>Последние обращения</h4>${reqHtml}</section>
    <section class="st-detail-section"><h4>Сданные работы</h4>${subHtml}</section>`;
}
function staffRenderStudents(){
  const host=$('#stStudents');if(!host)return;
  const q=staffStudentQuery.trim().toLocaleLowerCase('ru');
  const rows=X_STUDENTS.filter(x=>[x.name,x.grp,x.faculty,x.direction].join(' ').toLocaleLowerCase('ru').includes(q));
  $('#studentCount').textContent=`${rows.length} из ${X_STUDENTS.length}`;
  host.innerHTML=rows.length?rows.map(x=>`<button type="button" class="st-student-card" data-student="${x.id}" aria-pressed="${String(X_STUDENT_SELECTED)===String(x.id)}"><span class="avatar">${esc(staffInitials(x.name))}</span><span><b>${esc(x.name)}</b><small>${esc(x.grp)} · ${x.course} курс · активных обращений: ${x.activeRequests}</small></span><span class="arr">${ic('chev',17)}</span></button>`).join(''):'<div class="card st-no-results">По этому запросу студентов не найдено.</div>';
  staffRenderStudentDetail();
}
function staffRenderRequests(all){
  const q=staffRequestQuery.trim().toLocaleLowerCase('ru');
  const filtered=all.filter(r=>stFilter==='open'?(r.st==='wait'||r.st==='work'):stFilter==='done'?(r.st==='ok'||r.st==='no'):r.st===stFilter)
    .filter(r=>[r.name,r.grp,r.t,r.purpose,r.no].join(' ').toLocaleLowerCase('ru').includes(q));
  const count=$('#stSearchCount');if(count)count.textContent=`${filtered.length} из ${all.length}`;
  $('#stList').innerHTML=filtered.length?filtered.map(r=>{
    const key=r.src+':'+r.i,ini=staffInitials(r.name),status=staffStatus(r.st);
    const act=r.st==='wait'?`<button class="btn btn-primary" data-sa="work" data-k="${key}">Принять в работу</button><button class="btn btn-ghost" data-sa="rej" data-k="${key}">Отклонить</button>`
      :r.st==='work'?`<button class="btn btn-primary" data-sa="ok" data-k="${key}">${ic('check',15,2.4)}Готово</button><button class="btn btn-ghost" data-sa="rej" data-k="${key}">Отклонить</button>`
      :`<span class="st-note">${esc(r.note||(r.st==='ok'?'Выдано':''))}</span>`;
    return `<article class="card st-req ${r.login?'st-dm':''}"><span class="avatar">${esc(ini)}</span><div class="st-who"><b>${esc(r.name||'Студент')}</b><small>${esc(r.grp||'Группа не указана')}</small></div><div class="st-what"><b>${esc(r.t)}</b><small>${esc(r.purpose||'—')} · <span class="mono">${esc(r.no)}</span> · ${esc(r.when)}</small></div><span class="status ${status[0]}">${status[1]}</span><div class="st-act">${act}</div>${stReject===key?`<form class="st-rej" data-k="${key}"><input placeholder="Причина отказа — её увидит студент" required value="Нужна дополнительная информация по заявлению"><button class="btn btn-danger" type="submit">Отклонить</button><button class="btn btn-ghost" type="button" data-sa="cancel">Отмена</button></form>`:''}</article>`;
  }).join(''):'<div class="card news-empty">Заявок по этому фильтру нет.</div>';
}
function renderStaff(){
  $('#staffName').textContent=STAFF.dekanat?.short||'Сотрудник деканата';
  $('#staffPost').textContent=STAFF.dekanat?.post||'Методист деканата';
  $('#staffAvatar').textContent=STAFF.dekanat?.ini||'СД';
  $('#staffGreeting').textContent=`${moscowGreeting()}, ${STAFF.dekanat?.first||'сотрудник деканата'}`;
  $('#staffDateTime').textContent=`${moscowDateText()} · ${moscowClockText()} МСК`;
  $$('#stTabs button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.st===stTab));
  $$('[data-stv]').forEach(v=>v.hidden=v.dataset.stv!==stTab);
  const all=allReqs(),c=k=>all.filter(r=>r.st===k).length,active=all.filter(r=>r.st==='wait'||r.st==='work').length;
  $('#stStats').innerHTML=[
    ['wait','Новые обращения','inbox',c('wait')],['work','В работе','clock',c('work')],['people','Учебных профилей','users',X_STUDENTS.length],['news','Опубликовано','news',X_NEWS.length]
  ].map(([k,label,icon,num])=>`<div class="card st-stat"><span class="m-ic ${k}">${ic(icon,18)}</span><div><b class="num">${num}</b><span>${label}</span></div></div>`).join('');
  const attention=all.filter(r=>r.st==='wait'||r.st==='work').slice(0,5);
  $('#stAttention').innerHTML=attention.length?attention.map(r=>{const s=staffStatus(r.st);return `<div class="st-overview-item"><span><b>${esc(r.name||'Студент')}</b><small>${esc(r.t)} · ${esc(r.grp||'')}</small></span><span class="status ${s[0]}">${s[1]}</span></div>`}).join(''):'<div class="st-overview-empty">Все обращения обработаны. Новых задач нет.</div>';
  $('#stRecent').innerHTML=all.slice(0,5).length?all.slice(0,5).map(r=>{const s=staffStatus(r.st);return `<div class="st-overview-item"><span><b>${esc(r.t)}</b><small>${esc(r.name||'Студент')} · ${esc(r.when)}</small></span><span class="status ${s[0]}">${s[1]}</span></div>`}).join(''):'<div class="st-overview-empty">Пока нет обращений.</div>';
  const F=[['open','Активные',active],['wait','Новые',c('wait')],['work','В работе',c('work')],['done','Закрытые',c('ok')+c('no')]];
  $('#stFilter').innerHTML=F.map(([k,l,n])=>`<button data-sf="${k}" aria-pressed="${k===stFilter}">${l}<span class="c num">${n}</span></button>`).join('');
  staffRenderRequests(all);
  staffRenderStudents();
  const N=X_NEWS;
  $('#stPub').innerHTML=N.length?N.map((n,i)=>`<div class="card st-pubi"><div class="news-top"><span class="cat ${(NCAT[n.cat]||NCAT.study)[1]}">${(NCAT[n.cat]||NCAT.study)[0]}</span><span>${n.aud==='all'?'Все студенты':'Группа '+esc(n.aud)}</span><span>·</span><span>${esc(n.d)}</span></div><b>${esc(n.t)}</b><p>${esc(n.p)}</p><button class="link-btn" data-unpub="${i}">Снять с публикации</button></div>`).join(''):'<div class="card news-empty">Пока ничего не опубликовано. Создайте объявление — оно появится у выбранной аудитории.</div>';
}
function openStaffStudent(id){
  X_STUDENT_SELECTED=Number(id);X_STUDENT_DETAIL=null;staffRenderStudents();
  api('/staff/students/'+encodeURIComponent(id)).then(d=>{X_STUDENT_DETAIL=d;staffRenderStudents()}).catch(e=>{toast('Не удалось открыть карточку',e.message,{icon:'alert',tone:'err'});X_STUDENT_SELECTED=null;staffRenderStudents()});
}
function startStaff(anim){
  document.body.classList.remove('locked');document.body.classList.add('staff-mode');$('#login').hidden=true;$('#staff').hidden=false;
  stTab='home';stFilter='open';stReject=null;X_STUDENT_SELECTED=null;X_STUDENT_DETAIL=null;
  renderStaff();staffLoad();
  if(anim){$('#boot').classList.add('on');setTimeout(()=>{$('#boot').classList.remove('on');toast(`${moscowGreeting()}, ${STAFF.dekanat?.first||'сотрудник деканата'}!`,'Вы вошли как сотрудник деканата',{icon:'shield'})},600)}
}
['#stForm','#stPub'].forEach(sel=>{const n=$(sel),c=n.cloneNode(true);n.replaceWith(c)});
$('#stForm').addEventListener('submit',async e=>{
  e.preventDefault();const t=$('#stT').value.trim(),p=$('#stP').value.trim();
  if(!t||!p){toast('Заполните заголовок и текст','',{icon:'alert',tone:'err'});return}
  try{await api('/staff/news',{method:'POST',body:{t,p,cat:$('#stC').value,aud:$('#stA').value}});$('#stForm').reset();await staffLoad();stTab='news';renderStaff();toast('Объявление опубликовано','Студенты выбранной группы увидят его в ленте новостей',{icon:'news'})}
  catch(err){toast('Не опубликовано',err.message,{icon:'alert',tone:'err'})}
});
$('#stPub').addEventListener('click',async e=>{const b=e.target.closest('[data-unpub]');if(!b)return;const n=X_NEWS[+b.dataset.unpub];if(!n)return;try{await api('/staff/news/'+n.id,{method:'DELETE'});await staffLoad();toast('Объявление снято с публикации','',{icon:'x',tone:'info'})}catch(err){toast('Не удалось снять',err.message,{icon:'alert',tone:'err'})}});
{const n=$('#stList'),c=n.cloneNode(true);n.replaceWith(c)}
$('#stList').addEventListener('click',e=>{
  const b=e.target.closest('[data-sa]');if(!b)return;const a=b.dataset.sa;if(a==='cancel'){stReject=null;renderStaff();return;}
  const [,i]=b.dataset.k.split(':');if(a==='rej'){stReject=b.dataset.k;renderStaff();setTimeout(()=>{const f=$('.st-rej input');if(f){f.focus();f.select()}},30);return;}
  setReq('api',Number(i),a==='work'?{st:'work'}:{st:'ok',note:'Документ готов, студент уведомлён о статусе обращения'});
  toast(a==='work'?'Заявка принята в работу':'Заявка отмечена как готовая','Изменение статуса будет видно студенту в личном кабинете',{icon:'check'});
});
$('#stList').addEventListener('submit',e=>{
  const f=e.target.closest('.st-rej');if(!f)return;e.preventDefault();const [,i]=f.dataset.k.split(':');
  setReq('api',Number(i),{st:'no',note:f.querySelector('input').value.trim()});stReject=null;toast('Заявка отклонена','Студент увидит указанную причину',{icon:'x',tone:'info'});
});
$('#stSearch').addEventListener('input',e=>{staffRequestQuery=e.target.value;staffRenderRequests(allReqs())});
$('#studentSearch').addEventListener('input',e=>{staffStudentQuery=e.target.value;staffRenderStudents()});
$('#stStudents').addEventListener('click',e=>{const b=e.target.closest('[data-student]');if(b)openStaffStudent(b.dataset.student)});
$('#staff').addEventListener('click',e=>{const b=e.target.closest('[data-st-go]');if(b){stTab=b.dataset.stGo;renderStaff()}});
