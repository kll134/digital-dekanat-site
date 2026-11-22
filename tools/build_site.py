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
# tick() в исходном прототипе уже защищён от вызова до входа; часы обновляются до раннего выхода.

# 3. Вход: старый обработчик (проверка в браузере) убираем, новый — в site_client.js
cut("$('#lgForm').addEventListener('submit',async e=>{", "$('#pwEye').addEventListener", "$('#pwEye').addEventListener", include_end=True)

# 4. Заявки создаются на сервере
rep("""  const s=SVC[b.dataset.act]; const no='МФЦ-'+(48210+S.reqs.length);
  S.reqs.unshift({t:s.t,no,when:'сегодня, '+clockStr(),st:'wait'}); save(); renderOffice(); closeOffice();""",
    """  const s=SVC[b.dataset.act]; closeOffice(); createReq(s.t).then(r=>{if(!r)return;const no=r.no;""")
# закрываем then(...) — следующая строка после этого блока в исходнике — toast
i = s.index("createReq(s.t).then(r=>{if(!r)return;")
j = s.index("\n", s.index("\n", i) + 1)
s = s[:j] + "});" + s[j:]
# 5. Объявления деканата — с сервера
rep("const X=(()=>{try{return JSON.parse(store.get('digital-dekanat-news')||'[]')}catch(e){return []}})().filter(n=>n.aud==='all'||n.aud===U.grp);", "const X=(window.SRV_NEWS||[]);")

# 6. Тексты
s = s.replace('<html>','<html lang="ru">',1)
s = s.replace('<meta charset=utf8>', '<meta charset=utf8><link rel="icon" href="/favicon.svg" type="image/svg+xml">', 1)
rep("Хранится только в зашифрованном виде (хэш), его не видят даже сотрудники", "На сервере хранится только хэш scrypt с солью: пароль не видят даже администраторы")

# 6b. Заглушки с именами в разметке очищаем — их заполнит сервер
s = re.sub(r'(data-u="[a-zA-Z]+"[^>]*>)[^<]*(<)', r'\1\2', s)

# 7. Подключаем клиент сервера и новый запуск
client = open(__import__('os').path.join(__import__('os').path.dirname(__file__),'site_client.js'), encoding='utf-8').read()
cut("const sess=(()=>{try{return JSON.parse(store.get(SKEY)||'null')}catch(e){return null}})();", "else {renderAll();showLogin()}",
    client + """
async function refreshCampusClock(){
  try{const clock=await api('/clock');if(clock&&Number.isFinite(clock.now))setServerClockOffset(clock.now-Date.now())}catch(e){/* сохраняем последний синхронизированный ход часов */}
}
setInterval(refreshCampusClock,5*60*1000);
(async()=>{
  try{
    await refreshCampusClock();
    const me=await api('/me');
    if(!me.role){showLogin();return;}
    if(me.role==='staff'){STAFF.dekanat=me;startStaff(false)}else await startSession(me,false);
  }catch(e){showLogin();if(e.status===0)lgErr('Нет связи с сервером. Проверьте интернет и обновите страницу.')}
})();""")

open(dst, 'w', encoding='utf-8').write(s)
print('site ok', len(s))
