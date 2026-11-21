"""Превращает визуальный прототип (lk.html) в фронтенд сайта: данные и вход — через сервер."""
import sys, re
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding='utf-8').read()

def rep(o, n, c=1):
    global s
    k = s.count(o)
    if k != c: raise SystemExit(f'site {k}: {o[:90]!r}')
    s = s.replace(o, n)

def cut(start, end_marker, new, include_end=True):
    """Заменить кусок от start до end_marker (первое вхождение после start)."""
    global s
    a = s.index(start); b = s.index(end_marker, a)
    if include_end: b += len(end_marker)
    s = s[:a] + new + s[b:]

# 1. Личные данные студентов больше не лежат в коде страницы — их отдаёт сервер после входа
cut("const USERS={", "\n};\nlet U=USERS.student1;", "const USERS={};\nlet U=null;")
rep("const save=()=>store.set(KEY+'-'+U.id,JSON.stringify(S));\nloadS();", "let save=()=>{};")
for name in ['L', 'tasks', 'DISC', 'SES']:
    cut(f"\nconst {name}=[\n", "\n];", f"\nconst {name}=[];")
cut("const REC={", "\n};", "const REC={};")
rep("  const rows=REC[rbSem].map(([t,c,g])=>[t,c,g[U.rb]])", "  const rows=(U.recData&&U.recData[rbSem])||[]")
rep("const on=U.rec!==false;", "const on=!!U.recData;")
cut("const L2=[", "Object.assign(USERS.student2,{L:L2,Lb:L2b,tasks:T2,disc2:D2,ses:SES2,rec:false});", "")
cut("const STAFF={dekanat:{", "}};", "const STAFF={};")
rep("const loadN=()=>{try{return JSON.parse(store.get(NKEY)||'[]')}catch(e){return []}};", "let loadN=()=>[];")
cut("const XDEF=()=>[", "}];", "const XDEF=()=>[];")

# 2. Защита от ошибок до входа
rep("function tick(){\n  const n=now();", "function tick(){\n  if(!U||!S)return;\n  const n=now();")

# 3. Вход: старый обработчик (проверка в браузере) убираем, новый — в site_client.js
cut("$('#lgForm').addEventListener('submit',async e=>{", "$$('[data-demo]')", "$$('[data-demo]')", include_end=True)

# 4. Заявки создаются на сервере
rep("""  const s=SVC[b.dataset.act]; const no='МФЦ-'+(48210+S.reqs.length);
  S.reqs.unshift({t:s.t,no,when:'сегодня, '+clockStr(),st:'wait'}); save(); renderOffice(); closeOffice();""",
    """  const s=SVC[b.dataset.act]; closeOffice(); createReq(s.t).then(r=>{if(!r)return;const no=r.no;""")
# закрываем then(...) — следующая строка после этого блока в исходнике — toast
i = s.index("createReq(s.t).then(r=>{if(!r)return;")
j = s.index("\n", s.index("\n", i) + 1)
s = s[:j] + "});" + s[j:]
rep("""    const no='МФЦ-'+(48210+S.reqs.length);
    S.reqs.unshift({t:aiPending.t,purpose:aiPending.purpose,no,when:'сегодня, '+clockStr(),st:'wait'}); save(); renderOffice();""",
    """    const pend=aiPending, act=e.target.closest('.ai-card-act'); aiPending=null; act.innerHTML='<span class="spin"></span>';
    createReq(pend.t,pend.purpose).then(r=>{if(!r){act.innerHTML='<span class="muted">Не отправлено</span>';return}const no=r.no;""")
i = s.index("createReq(pend.t,pend.purpose).then(r=>{")
j = s.index("aiPending=null; return}", i)
s = s[:j] + "});return}" + s[j + len("aiPending=null; return}"):]
s = s.replace("    e.target.closest('.ai-card-act').innerHTML=`<span class=\"status st-ok\">","    act.innerHTML=`<span class=\"status st-ok\">",1)
s = s.replace("toast('Заявка отправлена',`${aiPending.t} ${aiPending.purpose} · ${no}`,{icon:'check'}); ", "toast('Заявка отправлена',`${pend.t} ${pend.purpose} · ${no}`,{icon:'check'}); ", 1)

# 5. Объявления деканата — с сервера
rep("const X=(()=>{try{return JSON.parse(store.get('digital-dekanat-news')||'[]')}catch(e){return []}})().filter(n=>n.aud==='all'||n.aud===U.grp);", "const X=(window.SRV_NEWS||[]);")

# 6. Тексты
s = s.replace('<html>','<html lang="ru">',1)
s = s.replace('<meta charset=utf8>', '<meta charset=utf8><link rel="icon" href="/favicon.svg" type="image/svg+xml">', 1)
rep("Демо: ответы собираются из ваших данных. На сайте подключим нейросеть через сервер.", "ИИ отвечает по вашим данным. Проверяйте важное в разделах кабинета.")
rep("Это демонстрационный прототип. Настоящие логины и пароли РАНХиГС здесь не используются.", "Это демонстрационный прототип для конкурса. Настоящие логины и пароли РАНХиГС здесь не используются.")
rep("Хранится только в зашифрованном виде (хэш), его не видят даже сотрудники", "На сервере хранится только хэш scrypt с солью: пароль не видят даже администраторы")

# 6b. Заглушки с именами в разметке очищаем — их заполнит сервер
s = re.sub(r'(data-u="[a-zA-Z]+"[^>]*>)[^<]*(<)', r'\1\2', s)

# 7. Подключаем клиент сервера и новый запуск
client = open(__import__('os').path.join(__import__('os').path.dirname(__file__),'site_client.js'), encoding='utf-8').read()
cut("const sess=(()=>{try{return JSON.parse(store.get(SKEY)||'null')}catch(e){return null}})();", "else {renderAll();showLogin()}",
    client + """
(async()=>{
  try{const me=await api('/me'); if(!me.role){showLogin();return} if(me.role==='staff'){STAFF.dekanat=me;startStaff(false)} else await startSession(me,false)}
  catch(e){showLogin(); if(e.status===0)lgErr('Нет связи с сервером. Проверьте интернет и обновите страницу.')}
})();""")

open(dst, 'w', encoding='utf-8').write(s)
print('site ok', len(s))
