'use strict';
/*
 * Цифровой деканат — сервер прототипа (концепт для конкурса, не официальный сервис РАНХиГС).
 * Без внешних зависимостей: только встроенные модули Node.js ≥ 22.13
 *   node:http      — веб-сервер и API
 *   node:sqlite    — база данных (файл SQLite в DATA_DIR)
 *   node:crypto    — хэширование паролей (scrypt), токены сессий
 */
process.removeAllListeners('warning');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEED_DIR = path.join(__dirname, 'seed');
const SUBMISSIONS_DIR = path.join(DATA_DIR, 'submissions');
fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });
const COOKIE = 'dd_sid';
const SESSION_TTL_SHORT = 12 * 3600e3;      // без «Запомнить меня»
const SESSION_TTL_LONG = 7 * 24 * 3600e3;   // с «Запомнить меня»

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'dekanat.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    login TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student','staff')),
    pass_hash TEXT,                 -- scrypt$N$r$p$salt$hash; NULL = вход запрещён
    full_name TEXT NOT NULL,
    grp TEXT,
    profile TEXT NOT NULL           -- JSON: учебные данные студента / данные сотрудника
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,    -- в базе только SHA-256 от токена
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS state (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL              -- JSON: заметки, свои события, записи в секции и т. п.
  );
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    no TEXT NOT NULL,
    title TEXT NOT NULL,
    purpose TEXT,
    status TEXT NOT NULL DEFAULT 'wait' CHECK (status IN ('wait','work','ok','no')),
    note TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    seen INTEGER NOT NULL DEFAULT 1 -- 0 = студент ещё не видел изменение статуса
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    task_title TEXT NOT NULL,
    file_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created INTEGER NOT NULL,
    UNIQUE(user_id, task_id)
  );
  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY,
    cat TEXT NOT NULL,
    aud TEXT NOT NULL,              -- 'all' или название группы
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    author TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_req_user ON requests(user_id);
  CREATE INDEX IF NOT EXISTS idx_sess_user ON sessions(user_id);
`);

/* ---------- пароли: scrypt с солью ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [alg, N, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, got);
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex')); // одинаковое время ответа для несуществующих логинов

/* ---------- первичное наполнение (вымышленные данные) ---------- */
function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return;
  const accounts = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'accounts.json'), 'utf8'));
  const students = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'students.json'), 'utf8'));
  const insUser = db.prepare('INSERT INTO users (login, role, pass_hash, full_name, grp, profile) VALUES (?,?,?,?,?,?)');
  const insState = db.prepare('INSERT INTO state (user_id, data) VALUES (?,?)');
  const insReq = db.prepare('INSERT INTO requests (user_id,no,title,purpose,status,note,created,updated,seen) VALUES (?,?,?,?,?,?,?,?,1)');
  db.exec('BEGIN');
  try {
    for (const a of accounts) {
      const hash = a.passHash || null; // в репозитории лежат только хэши, не пароли
      if (a.role === 'student' && students[a.login]) {
        const s = students[a.login];
        const { state, reqs0, reqs, ...profile } = s;
        const { lastInsertRowid: id } = insUser.run(a.login, 'student', hash, s.full, s.grp, JSON.stringify(profile));
        insState.run(id, JSON.stringify(state || {}));
        const t0 = Date.parse('2026-11-02T10:00:00+03:00');
        (reqs0 || []).forEach((r, i) => insReq.run(id, r.no, r.t, r.purpose || null, r.st, null, t0 + i * 864e5, t0 + i * 864e5));
      } else {
        const { lastInsertRowid: id } = insUser.run(a.login, a.role, hash, a.full, a.grp || null, JSON.stringify(a.profile || {}));
        (a.requests || []).forEach(r => insReq.run(id, r.no, r.t, r.purpose, r.st, r.note || null, Date.parse(r.at), Date.parse(r.at)));
      }
    }
    db.exec('COMMIT');
    console.log('База заполнена демо-данными');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
seed();
// Синхронизируем демо-профили с seed при каждом запуске, чтобы обновлённые
// расписание, курс, дисциплины и типы занятий применялись и к уже созданной БД.
try {
  const seeded = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'students.json'), 'utf8'));
  const update = db.prepare('UPDATE users SET profile = ?, grp = ? WHERE login = ?');
  for (const login of ['student1', 'student2']) {
    const s = seeded[login];
    const row = db.prepare('SELECT id, profile FROM users WHERE login = ?').get(login);
    if (!s || !row) continue;
    const profile = { ...JSON.parse(row.profile || '{}'), ...s };
    update.run(JSON.stringify(profile), s.grp || null, login);
  }
} catch (e) { console.error('Не удалось синхронизировать демо-профили:', e.message); }

// Идемпотентное расширение демо-каталога методиста. Не очищает и не пересоздаёт
// существующую БД: добавляет только отсутствующие учебные карточки и обращения.
try {
  const catalog = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'directory.json'), 'utf8'));
  const findUser = db.prepare('SELECT id, role, full_name, grp, profile FROM users WHERE login = ?');
  const addUser = db.prepare("INSERT INTO users (login, role, pass_hash, full_name, grp, profile) VALUES (?, 'student', NULL, ?, ?, ?)");
  const updateUser = db.prepare("UPDATE users SET full_name = ?, grp = ?, profile = ? WHERE id = ? AND role = 'student'");
  const addRequest = db.prepare('INSERT INTO requests (user_id,no,title,purpose,status,note,created,updated,seen) VALUES (?,?,?,?,?,?,?,?,1)');
  const requestExists = db.prepare('SELECT id FROM requests WHERE user_id = ? AND no = ?');
  db.exec('BEGIN');
  try {
    for (const item of (catalog.students || [])) {
      if (!item || !/^[a-z0-9-]{3,40}$/i.test(item.login || '') || !item.full || !item.grp || !item.profile) continue;
      let row = findUser.get(item.login);
      if (!row) {
        const result = addUser.run(item.login, item.full, item.grp, JSON.stringify(item.profile));
        row = { id: Number(result.lastInsertRowid), role: 'student', full_name: item.full, grp: item.grp, profile: JSON.stringify(item.profile) };
      } else if (row.role === 'student') {
        let existing = {};
        try { existing = JSON.parse(row.profile || '{}'); } catch {}
        const supplied = item.profile || {};
        // Демо-профиль дополняется только пустыми полями; уже сохранённые значения не затираются.
        for (const [key, value] of Object.entries(supplied)) {
          if (existing[key] === undefined || existing[key] === null || existing[key] === '') existing[key] = value;
        }
        const fullName = row.full_name || item.full;
        const group = row.grp || item.grp;
        updateUser.run(fullName, group, JSON.stringify(existing), row.id);
        row.profile = JSON.stringify(existing);
      }
      if (row?.role !== 'student') continue;
      for (const req of (item.requests || [])) {
        if (!req.no || requestExists.get(row.id, req.no)) continue;
        const at = Date.parse(req.at);
        if (!Number.isFinite(at)) continue;
        addRequest.run(row.id, req.no, req.title, req.purpose || null, req.status || 'wait', req.note || null, at, at);
      }
    }
    for (const req of (catalog.additionalRequests || [])) {
      const user = findUser.get(req.login);
      if (!user || user.role !== 'student' || !req.no || requestExists.get(user.id, req.no)) continue;
      const at = Date.parse(req.at);
      if (!Number.isFinite(at)) continue;
      addRequest.run(user.id, req.no, req.title, req.purpose || null, req.status || 'wait', req.note || null, at, at);
    }
    db.exec('COMMIT');
    console.log(`Каталог методиста синхронизирован: ${(catalog.students || []).length} демо-карточек`);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
} catch (e) { console.error('Не удалось синхронизировать каталог методиста:', e.message); }

/* ---------- утилиты ---------- */
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
function fmtWhen(ms) {
  const d = new Date(ms + 3 * 3600e3); // Москва / Волгоград, UTC+3
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function isHttps(req) { return process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https'; }
function setSessionCookie(req, res, token, ttl) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (ttl) parts.push(`Max-Age=${Math.floor(ttl / 1000)}`); else parts.push('Max-Age=0');
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};
function send(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(body);
}
function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Некорректный JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const str = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

/* ---------- защита от перебора паролей ---------- */
const attempts = new Map(); // ключ ip|login → {n, until}
function loginBlocked(key) { const a = attempts.get(key); return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0; }
function loginFailed(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n += 1; if (a.n >= 5) { a.until = Date.now() + 30e3; a.n = 0; }
  attempts.set(key, a);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (a.until < now && a.n === 0) attempts.delete(k);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
}, 60e3).unref();

/* ---------- сессии ---------- */
function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || token.length > 100) return null;
  const row = db.prepare(`SELECT u.* , s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?`).get(sha256(token), Date.now());
  return row || null;
}

/* ---------- представление данных ---------- */
function reqView(r) {
  return { id: r.id, no: r.no, t: r.title, purpose: r.purpose || '', st: r.status, note: r.note || '', when: fmtWhen(r.created), upd: r.seen ? 0 : 1 };
}
function effectiveProfile(login, profile) {
  if (login !== 'student1' || !Array.isArray(profile.L)) return profile;
  const L = profile.L.map(day => day.map(lesson => ({ ...lesson,
    a: Array.isArray(lesson.a) ? [...lesson.a] : lesson.a,
    b: Array.isArray(lesson.b) ? [...lesson.b] : lesson.b,
    ch: lesson.ch ? { ...lesson.ch } : undefined
  })));
  const find = (day, id, predicate) => L[day]?.find(x => x.id === id) || L[day]?.find(predicate);

  // Демонстрационные изменения расписания Анастасии. Применяются к профилю,
  // который уже хранится в постоянной БД, без изменения самой БД.
  const english = find(1, 'a-tue3', x => x.t === 'Иностранный язык (английский)' && x.k === 'Семинар' && x.a?.[0] === 12);
  if (english) {
    english.r = 'Корпус 1, ауд. 112';
    english.ch = { type: 'room', old: 'Корпус 1, ауд. 214', why: 'аудитория изменена деканатом' };
  }
  const lawLecture = find(2, 'a-wed2', x => x.t === 'Гражданское право' && x.k === 'Лекция');
  if (lawLecture) {
    lawLecture.a = [10, 10]; lawLecture.b = [11, 30];
    lawLecture.ch = { type: 'time', old: [[10, 40], [12, 0]], why: 'изменение расписания деканатом' };
  }
  const gmuLecture = find(3, 'a-thu1', x => x.t === 'Основы государственного и муниципального управления' && x.k === 'Лекция');
  if (gmuLecture) {
    gmuLecture.p = 'Ковалёв А. П.';
    gmuLecture.ch = { type: 'teacher', old: 'Соколова Е. А.', why: 'замена преподавателя' };
  }
  return { ...profile, L };
}
function meView(u) {
  const p = effectiveProfile(u.login, JSON.parse(u.profile));
  if (u.role === 'staff') return { role: 'staff', login: u.login, name: u.full_name, ...p };
  return { role: 'student', login: u.login, ...p };
}
const ALLOWED_REQ = ['Справка об обучении', 'Справка для военкомата', 'Справка о стипендии', 'Справка об отсутствии на занятиях', 'Заявление', 'Студенческий билет', 'Академическая справка', 'Перевод и восстановление', 'Общежитие', 'Академическая мобильность'];

/* ---------- ИИ-помощник (ключ только на сервере, в переменных окружения) ---------- */
function studentContext(u) {
  const p = effectiveProfile(u.login, JSON.parse(u.profile));
  const days = ['Пн','Вт','Ср','Чт','Пт','Сб'];
  const f = a => `${String(a[0]).padStart(2,'0')}:${String(a[1]).padStart(2,'0')}`;
  const sched = (p.L || []).map((d, i) => `${days[i]}: ${d.length ? d.map(l => `${f(l.a)} ${l.t} (${l.k}, ${l.r}, ${l.p})${l.ch ? ' [изменение: ' + (l.ch.type === 'cancel' ? 'отменена' : l.ch.type) + ']' : ''}`).join('; ') : 'нет пар'}`).join('\n');
  const disc = (p.disc2 || []).map(d => `${d.t}: ${d.pts}/100 БРС, ${d.c}, пропусков ${d.miss.length}${d.pts < 60 ? ', НЕТ ДОПУСКА' : ''}`).join('\n');
  const ses = (p.ses || []).map(s => `${p.disc2[s.d].t} — ${p.disc2[s.d].c}, ${s.date} ${s.time}, ${s.room}`).join('\n');
  const reqs = db.prepare('SELECT * FROM requests WHERE user_id = ? ORDER BY created DESC LIMIT 5').all(u.id).map(r => `${r.title} ${r.purpose || ''} — ${r.status}`).join('\n') || 'нет';
  const now = new Date();
  const campusDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
  const campusTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const campusWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', weekday: 'short' }).format(now);
  const campusWeekNum = Math.floor((Date.UTC(...(() => { const f = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now); const o={}; for (const x of f) if(x.type!=='literal') o[x.type]=+x.value; return [o.year,o.month-1,o.day]; })()) - Date.UTC(2026,10,9)) / 604800000);
  return `Студент: ${p.full}, ${p.course} курс, группа ${p.grp}, ${p.fac}, ${p.dir}.
Текущая дата и время кампуса: ${campusDate}, ${campusTime} МСК. День недели: ${campusWeekday}. Учебная неделя: ${campusWeekNum + 11}.
Расписание профиля (по учебным дням):\n${sched}\nБаллы и посещаемость:\n${disc}\nСессия:\n${ses}\nЗаявки:\n${reqs}`;
}
const AI_SYSTEM = `Ты — ИИ-помощник «Спроси деканат» в личном кабинете студента (концепт для конкурса, данные вымышлены).
Отвечай по-русски, коротко (до 5 предложений), дружелюбно и по делу, опираясь ТОЛЬКО на данные студента ниже.
Если данных нет — честно скажи и подскажи раздел кабинета. Не выдумывай оценки, даты и аудитории.
Не обещай поставить зачёт, изменить оценку или отменить пропуск — это решают преподаватель и деканат.
Если просят справку — скажи, что её можно оформить кнопкой «Подать заявку» в разделе «Справки и заявления» или попросить словами «закажи справку».`;
async function askLLM(u, q, history) {
  const ctx = studentContext(u);
  const msgs = [{ role: 'system', text: AI_SYSTEM + '\n\n' + ctx }, ...history.slice(-6), { role: 'user', text: q }];
  if (process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID) {
    const r = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Api-Key ' + process.env.YANDEX_API_KEY },
      body: JSON.stringify({ modelUri: `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt-lite/latest`, completionOptions: { temperature: 0.3, maxTokens: 500 }, messages: msgs }),
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) throw new Error('YandexGPT ' + r.status);
    const j = await r.json();
    return j.result?.alternatives?.[0]?.message?.text || '';
  }
  if (process.env.GIGACHAT_AUTH_KEY) {
    const t = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', RqUID: crypto.randomUUID(), Authorization: 'Basic ' + process.env.GIGACHAT_AUTH_KEY },
      body: 'scope=' + (process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS'), signal: AbortSignal.timeout(15000)
    });
    if (!t.ok) throw new Error('GigaChat auth ' + t.status);
    const { access_token } = await t.json();
    const r = await fetch('https://gigachat.devices.sberbank.ru/api/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + access_token },
      body: JSON.stringify({ model: 'GigaChat', temperature: 0.3, max_tokens: 500, messages: msgs.map(m => ({ role: m.role, content: m.text })) }),
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) throw new Error('GigaChat ' + r.status);
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  }
  return null;
}
const aiCalls = new Map(); // простая квота: 20 запросов в 10 минут на пользователя

/* ---------- API ---------- */
async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  // Защита от CSRF: изменяющие запросы только со своего сайта и только через наш JS
  if (m !== 'GET') {
    if (req.headers['x-requested-with'] !== 'dd') return send(res, 403, { error: 'Запрос отклонён' });
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Запрос отклонён' });
  }
  if (p === '/api/health') return send(res, 200, { ok: true });
  // Серверное время — единая точка отсчёта для календаря кампуса (Москва).
  if (p === '/api/clock' && m === 'GET') return send(res, 200, { now: Date.now(), timeZone: 'Europe/Moscow' });

  if (p === '/api/login' && m === 'POST') {
    const b = await readJson(req, 4096);
    const login = str(b.login, 64).toLowerCase(), password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
    const key = clientIp(req) + '|' + login;
    const wait = loginBlocked(key);
    if (wait) return send(res, 429, { error: `Слишком много попыток. Повторите через ${wait} с.` });
    const u = login ? db.prepare('SELECT * FROM users WHERE login = ?').get(login) : null;
    const ok = verifyPassword(password, u ? u.pass_hash : DUMMY_HASH) && u && u.pass_hash;
    if (!ok) { loginFailed(key); return send(res, 401, { error: 'Неверный логин или пароль' }); }
    attempts.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    const ttl = b.remember === false ? SESSION_TTL_SHORT : SESSION_TTL_LONG;
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?,?,?)').run(sha256(token), u.id, Date.now() + ttl);
    setSessionCookie(req, res, token, ttl);
    return send(res, 200, meView(u));
  }

  const u = currentUser(req);
  if (!u && p === '/api/me') return send(res, 200, { role: null }); // гость: показать экран входа без ошибки в консоли
  if (!u) return send(res, 401, { error: 'Нужно войти' });

  if (p === '/api/logout' && m === 'POST') {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(parseCookies(req)[COOKIE]));
    setSessionCookie(req, res, '', 0);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/me' && m === 'GET') return send(res, 200, meView(u));

  /* --- студент: только свои данные; id студента берётся из сессии, а не из адреса --- */
  if (p.startsWith('/api/staff')) {
    if (u.role !== 'staff') return send(res, 403, { error: 'Доступ только для сотрудников деканата' });
  } else if (!['/api/news'].includes(p) && u.role !== 'student') {
    return send(res, 403, { error: 'Доступ только для студентов' });
  }

  if (p === '/api/state' && m === 'GET') {
    const row = db.prepare('SELECT data FROM state WHERE user_id = ?').get(u.id);
    return send(res, 200, row ? JSON.parse(row.data) : {});
  }
  if (p === '/api/state' && m === 'PUT') {
    const b = await readJson(req, 64 * 1024);
    if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'Некорректные данные' });
    const KEYS = ['notes', 'events', 'applied', 'certs', 'newsRead', 'ev', 'clubs', 'prefs', 'cons'];
    const clean = {}; for (const k of KEYS) if (k in b) clean[k] = b[k];
    db.prepare('INSERT INTO state (user_id, data) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data').run(u.id, JSON.stringify(clean));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/submissions' && m === 'GET') {
    const rows = db.prepare('SELECT task_id, task_title, file_name, mime_type, size, created FROM submissions WHERE user_id = ? ORDER BY created DESC').all(u.id);
    return send(res, 200, rows);
  }
  if (p === '/api/submissions' && m === 'POST') {
    if (u.role !== 'student') return send(res, 403, { error: 'Сдавать работы могут только студенты' });
    const b = await readJson(req, 7 * 1024 * 1024);
    const taskId = str(b.taskId, 80), taskTitle = str(b.taskTitle, 180), fileName = str(b.fileName, 180);
    const ext = path.extname(fileName).toLowerCase();
    const allowed = new Set(['.ppt', '.pptx', '.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt']);
    if (!taskId || !taskTitle || !fileName || !allowed.has(ext)) return send(res, 400, { error: 'Поддерживаются PPT, PPTX, PDF, DOC, DOCX, TXT, RTF и ODT' });
    if (typeof b.data !== 'string' || !/^data:[^;]+;base64,/.test(b.data)) return send(res, 400, { error: 'Файл не получен' });
    const base64 = b.data.slice(b.data.indexOf(',') + 1);
    if (base64.length > 7.05 * 1024 * 1024) return send(res, 413, { error: 'Файл слишком большой. Максимум — 5 МБ' });
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) return send(res, 413, { error: 'Файл слишком большой. Максимум — 5 МБ' });
    const mime = str(b.mimeType, 120) || 'application/octet-stream';
    const storedName = crypto.randomBytes(18).toString('hex') + ext;
    const target = path.join(SUBMISSIONS_DIR, storedName);
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    try {
      const prev = db.prepare('SELECT stored_name FROM submissions WHERE user_id = ? AND task_id = ?').get(u.id, taskId);
      db.prepare(`INSERT INTO submissions (user_id,task_id,task_title,file_name,stored_name,mime_type,size,created)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,task_id) DO UPDATE SET task_title=excluded.task_title,file_name=excluded.file_name,stored_name=excluded.stored_name,mime_type=excluded.mime_type,size=excluded.size,created=excluded.created`)
        .run(u.id, taskId, taskTitle, fileName, storedName, mime, bytes.length, Date.now());
      if (prev?.stored_name) { try { fs.unlinkSync(path.join(SUBMISSIONS_DIR, prev.stored_name)); } catch {} }
    } catch (e) { try { fs.unlinkSync(target); } catch {} throw e; }
    return send(res, 201, { ok: true, taskId, taskTitle, fileName, mimeType: mime, size: bytes.length, created: Date.now() });
  }

  if (p === '/api/requests' && m === 'GET') {
    return send(res, 200, db.prepare('SELECT * FROM requests WHERE user_id = ? ORDER BY created DESC, id DESC').all(u.id).map(reqView));
  }
  if (p === '/api/requests' && m === 'POST') {
    const b = await readJson(req, 4096);
    const title = str(b.t, 80), purpose = str(b.purpose, 120);
    if (!ALLOWED_REQ.includes(title)) return send(res, 400, { error: 'Неизвестный тип заявки' });
    const recent = db.prepare('SELECT COUNT(*) c FROM requests WHERE user_id = ? AND created > ?').get(u.id, Date.now() - 3600e3).c;
    if (recent >= 10) return send(res, 429, { error: 'Слишком много заявок за час' });
    const now = Date.now();
    const info = db.prepare('INSERT INTO requests (user_id,no,title,purpose,status,created,updated,seen) VALUES (?,?,?,?,?,?,?,1)').run(u.id, '', title, purpose || null, 'wait', now, now);
    const no = 'МФЦ-' + (48200 + Number(info.lastInsertRowid));
    db.prepare('UPDATE requests SET no = ? WHERE id = ?').run(no, info.lastInsertRowid);
    return send(res, 201, reqView(db.prepare('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid)));
  }
  if (p === '/api/requests/seen' && m === 'POST') {
    db.prepare('UPDATE requests SET seen = 1 WHERE user_id = ?').run(u.id);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/news' && m === 'GET') {
    const rows = u.role === 'staff' ? [] : db.prepare("SELECT * FROM news WHERE aud = 'all' OR aud = ? ORDER BY created DESC LIMIT 50").all(u.grp);
    return send(res, 200, rows.map(n => ({ id: 'x' + n.id, cat: n.cat, aud: n.aud, t: n.title, p: n.body, d: fmtWhen(n.created), s: 'Деканат · ' + n.author })));
  }
  if (p === '/api/ai' && m === 'POST') {
    const b = await readJson(req, 16 * 1024);
    const q = str(b.q, 500); if (!q) return send(res, 400, { error: 'Пустой вопрос' });
    const now = Date.now(), list = (aiCalls.get(u.id) || []).filter(t => t > now - 600e3);
    if (list.length >= 20) return send(res, 429, { error: 'Слишком много вопросов, подождите пару минут' });
    list.push(now); aiCalls.set(u.id, list);
    const history = Array.isArray(b.history) ? b.history.slice(-6).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', text: str(h.text, 800) })) : [];
    try {
      const text = await askLLM(u, q, history);
      if (text === null) return send(res, 200, { fallback: true });
      return send(res, 200, { text });
    } catch (e) {
      console.error('AI error:', e.message);
      return send(res, 200, { fallback: true });
    }
  }

  /* --- сотрудник деканата: каталог студентов и учебные карточки --- */
  if (p === '/api/staff/students' && m === 'GET') {
    const rows = db.prepare("SELECT id, login, full_name, grp, profile FROM users WHERE role = 'student' ORDER BY full_name").all();
    const students = rows.flatMap(row => {
      let profile = {}; try { profile = JSON.parse(row.profile || '{}'); } catch {}
      // В каталог попадают все демо-профили с заполненными сведениями об обучении.
      if (!Number.isFinite(Number(profile.course)) || !profile.fac || !profile.dir) return [];
      const requestCounts = db.prepare("SELECT SUM(CASE WHEN status IN ('wait','work') THEN 1 ELSE 0 END) AS active, COUNT(*) AS total FROM requests WHERE user_id = ?").get(row.id);
      return [{ id: row.id, login: row.login, name: row.full_name, grp: row.grp || '', course: profile.course, faculty: profile.fac, direction: profile.dir, average: profile.avg || '—', attendance: Number.isFinite(Number(profile.att)) ? Number(profile.att) : null, brs: Number.isFinite(Number(profile.brs)) ? Number(profile.brs) : null, activeRequests: Number(requestCounts.active || 0), requestsTotal: Number(requestCounts.total || 0) }];
    });
    return send(res, 200, students);
  }
  const staffSubmissionMatch = p.match(/^\/api\/staff\/submissions\/(\d+)$/);
  if (staffSubmissionMatch && m === 'GET') {
    const file = db.prepare('SELECT file_name, stored_name, size FROM submissions WHERE id = ?').get(Number(staffSubmissionMatch[1]));
    if (!file) return send(res, 404, { error: 'Файл не найден' });
    const stored = path.basename(file.stored_name);
    if (stored !== file.stored_name || !/^[a-f0-9]{36}\.[a-z0-9]+$/.test(stored)) return send(res, 404, { error: 'Файл не найден' });
    const target = path.join(SUBMISSIONS_DIR, stored);
    if (!fs.existsSync(target)) return send(res, 404, { error: 'Файл больше недоступен' });
    const safeName = encodeURIComponent(String(file.file_name).replace(/[\r\n\"']/g, '_'));
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size, 'Content-Disposition': `attachment; filename*=UTF-8''${safeName}`, 'Cache-Control': 'no-store', ...SEC_HEADERS });
    return fs.createReadStream(target).pipe(res);
  }

  const studentDetailMatch = p.match(/^\/api\/staff\/students\/(\d+)$/);
  if (studentDetailMatch && m === 'GET') {
    const row = db.prepare("SELECT id, login, full_name, grp, profile FROM users WHERE id = ? AND role = 'student'").get(Number(studentDetailMatch[1]));
    if (!row) return send(res, 404, { error: 'Студент не найден' });
    let profile = {}; try { profile = JSON.parse(row.profile || '{}'); } catch {}
    if (!Number.isFinite(Number(profile.course)) || !profile.fac || !profile.dir) return send(res, 404, { error: 'Учебный профиль не заполнен' });
    const requests = db.prepare('SELECT * FROM requests WHERE user_id = ? ORDER BY created DESC LIMIT 10').all(row.id).map(reqView);
    const submissions = db.prepare('SELECT id, task_id, task_title, file_name, mime_type, size, created FROM submissions WHERE user_id = ? ORDER BY created DESC LIMIT 20').all(row.id);
    const safe = { id: row.id, login: row.login, full: row.full_name, grp: row.grp || '', course: profile.course, fac: profile.fac, dir: profile.dir, prof: profile.prof || '', form: profile.form || '', email: profile.email || '', curator: profile.curator || '', avg: profile.avg || '—', att: profile.att ?? null, brs: profile.brs ?? null, disc2: Array.isArray(profile.disc2) ? profile.disc2 : [], L: Array.isArray(profile.L) ? effectiveProfile(row.login, profile).L : [], Lb: Array.isArray(profile.Lb) ? profile.Lb : [], tasks: Array.isArray(profile.tasks) ? profile.tasks.map(x => ({ id: x.id, t: x.t, s: x.s, due: x.due })) : [], ses: Array.isArray(profile.ses) ? profile.ses : [], requests, submissions };
    return send(res, 200, safe);
  }

  /* --- сотрудник деканата --- */
  if (p === '/api/staff/requests' && m === 'GET') {
    const rows = db.prepare(`SELECT r.*, u.full_name, u.grp, u.login, u.pass_hash IS NOT NULL AS demo FROM requests r JOIN users u ON u.id = r.user_id ORDER BY CASE r.status WHEN 'wait' THEN 0 WHEN 'work' THEN 1 ELSE 2 END, r.created DESC`).all();
    return send(res, 200, rows.map(r => ({ ...reqView(r), name: r.full_name, grp: r.grp, login: r.demo ? r.login : null })));
  }
  const rm = p.match(/^\/api\/staff\/requests\/(\d+)$/);
  if (rm && m === 'PATCH') {
    const b = await readJson(req, 4096);
    const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(rm[1]));
    if (!r) return send(res, 404, { error: 'Заявка не найдена' });
    const st = b.st;
    const FLOW = { wait: ['work', 'no'], work: ['ok', 'no'] };
    if (!(FLOW[r.status] || []).includes(st)) return send(res, 400, { error: 'Недопустимая смена статуса' });
    const note = st === 'no' ? 'Причина: ' + (str(b.note, 200) || 'не указана') : st === 'ok' ? 'Документ с электронной подписью деканата готов, его можно скачать' : null;
    db.prepare('UPDATE requests SET status = ?, note = ?, updated = ?, seen = 0 WHERE id = ?').run(st, note, Date.now(), r.id);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/staff/news' && m === 'GET') {
    return send(res, 200, db.prepare('SELECT * FROM news ORDER BY created DESC').all().map(n => ({ id: n.id, cat: n.cat, aud: n.aud, t: n.title, p: n.body, d: fmtWhen(n.created) })));
  }
  if (p === '/api/staff/news' && m === 'POST') {
    const b = await readJson(req, 16 * 1024);
    const t = str(b.t, 140), body = str(b.p, 2000), cat = ['imp', 'study', 'doc', 'ev'].includes(b.cat) ? b.cat : 'study';
    const groups = db.prepare("SELECT DISTINCT grp FROM users WHERE role = 'student' AND grp IS NOT NULL").all().map(x => x.grp);
    const aud = b.aud === 'all' || groups.includes(b.aud) ? b.aud : null;
    if (!t || !body || !aud) return send(res, 400, { error: 'Заполните заголовок, текст и адресатов' });
    const short = u.full_name.split(' ').map((w, i) => i ? w[0] + '.' : w).join(' ');
    db.prepare('INSERT INTO news (cat,aud,title,body,author,created) VALUES (?,?,?,?,?,?)').run(cat, aud, t, body, short, Date.now());
    return send(res, 201, { ok: true });
  }
  const nm = p.match(/^\/api\/staff\/news\/(\d+)$/);
  if (nm && m === 'DELETE') {
    db.prepare('DELETE FROM news WHERE id = ?').run(Number(nm[1]));
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Не найдено' });
}

/* ---------- статика ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=3600', ...SEC_HEADERS });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url);
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Внутренняя ошибка сервера' });
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`Цифровой деканат запущен на 0.0.0.0:${PORT}`));
