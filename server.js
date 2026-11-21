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
function meView(u) {
  const p = JSON.parse(u.profile);
  if (u.role === 'staff') return { role: 'staff', login: u.login, name: u.full_name, ...p };
  return { role: 'student', login: u.login, ...p };
}
const ALLOWED_REQ = ['Справка об обучении', 'Справка для военкомата', 'Справка о стипендии', 'Справка об отсутствии на занятиях', 'Заявление', 'Студенческий билет', 'Академическая справка', 'Перевод и восстановление', 'Общежитие', 'Академическая мобильность'];

/* ---------- ИИ-помощник (ключ только на сервере, в переменных окружения) ---------- */
function studentContext(u) {
  const p = JSON.parse(u.profile);
  const days = ['Пн','Вт','Ср','Чт','Пт','Сб'];
  const f = a => `${String(a[0]).padStart(2,'0')}:${String(a[1]).padStart(2,'0')}`;
  const sched = (p.L || []).map((d, i) => `${days[i]}: ${d.length ? d.map(l => `${f(l.a)} ${l.t} (${l.k}, ${l.r}, ${l.p})${l.ch ? ' [изменение: ' + (l.ch.type === 'cancel' ? 'отменена' : l.ch.type) + ']' : ''}`).join('; ') : 'нет пар'}`).join('\n');
  const disc = (p.disc2 || []).map(d => `${d.t}: ${d.pts}/100 БРС, ${d.c}, пропусков ${d.miss.length}${d.pts < 60 ? ', НЕТ ДОПУСКА' : ''}`).join('\n');
  const ses = (p.ses || []).map(s => `${p.disc2[s.d].t} — ${p.disc2[s.d].c}, ${s.date} ${s.time}, ${s.room}`).join('\n');
  const reqs = db.prepare('SELECT * FROM requests WHERE user_id = ? ORDER BY created DESC LIMIT 5').all(u.id).map(r => `${r.title} ${r.purpose || ''} — ${r.status}`).join('\n') || 'нет';
  return `Студент: ${p.full}, ${p.course} курс, группа ${p.grp}, ${p.fac}, ${p.dir}.
Сегодня (демо-дата) вторник, 10 ноября 2026, 12:07. Неделя нечётная.
Расписание этой недели:\n${sched}\nБаллы и посещаемость:\n${disc}\nСессия:\n${ses}\nЗаявки:\n${reqs}`;
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
server.listen(PORT, () => console.log(`Цифровой деканат запущен: http://localhost:${PORT}`));
