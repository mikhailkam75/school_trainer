const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 3001;

const AUTH_KEY = process.env.GIGACHAT_AUTH_KEY;
const SCOPE = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
const MODEL = process.env.GIGACHAT_MODEL || 'GigaChat-2';

// HTTPS: сертификаты НУЦ читаем из кода (попадёт в бандл Vercel). undici — опционален.
let fetchImpl = globalThis.fetch;
try {
  const ca = fs.readFileSync(path.join(__dirname, 'certs', 'ca-bundle.pem'), 'utf8');
  const { Agent, fetch: undiciFetch } = require('undici');
  const agent = new Agent({ connect: { ca } });
  fetchImpl = (url, opts = {}) => undiciFetch(url, { ...opts, dispatcher: agent });
  console.log('CA: сертификаты НУЦ загружены');
} catch (e) {
  console.log('CA: работаю без дополнительных сертификатов (', e.message, ')');
}

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---------- Токен GigaChat (OAuth) с кэшем ----------
let tokenCache = { token: null, expiresAtMs: 0 };
async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAtMs - 60_000) return tokenCache.token;
  if (!AUTH_KEY) throw new Error('Не задан GIGACHAT_AUTH_KEY');
  const res = await fetchImpl('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      RqUID: crypto.randomUUID(),
      Authorization: `Basic ${AUTH_KEY}`,
    },
    body: `scope=${SCOPE}`,
  });
  if (!res.ok) throw new Error(`OAuth ошибка: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const expiresAtMs = data.expires_at > 1e12 ? data.expires_at : data.expires_at * 1000;
  tokenCache = { token: data.access_token, expiresAtMs };
  return tokenCache.token;
}

async function gigaChat(messages) {
  const token = await getToken();
  const res = await fetchImpl('https://api.giga.chat/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ model: MODEL, messages }),
  });
  if (!res.ok) throw new Error(`Ошибка GigaChat: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

async function withRetry(fn, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { lastErr = e; console.error(`Попытка ${i + 1} не удалась:`, e.message); }
  }
  throw lastErr;
}

app.get('/api/models', async (_req, res) => {
  try {
    const token = await getToken();
    const r = await fetchImpl('https://api.giga.chat/v1/models', {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { history: [], asked: [] });
  return sessions.get(id);
}

// ---------- Объяснение ----------
app.post('/api/learn', async (req, res) => {
  const { classLevel, subject, question, sessionId } = req.body || {};
  const q = (question || '').trim();
  if (!q) return res.status(400).json({ error: 'Вопрос пуст' });
  const subjectName = subject === 'math' ? 'Математика' : 'Русский язык';
  const system =
    `Ты виртуальный учитель для ученика ${classLevel} класса. Предмет: ${subjectName}. ` +
    `Объясняй темы простыми словами, с 1–2 примерами, без ссылок и сложных терминов. ` +
    `Держись школьной программы России. Будь дружелюбным, как старший брат.`;
  try {
    const s = sessionId ? getSession(sessionId) : { history: [], asked: [] };
    s.history.push({ role: 'user', content: q });
    if (s.history.length > 20) s.history.splice(0, s.history.length - 20);
    const answer = await withRetry(() => gigaChat([{ role: 'system', content: system }, ...s.history]));
    s.history.push({ role: 'assistant', content: answer });
    res.json({ answer });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера: ' + e.message });
  }
});

// ========== МАТЕМАТИКА: вопросы и ответы считает КОД ==========
function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = rnd(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function pack(answer, question, explanation) {
  const opts = new Set([answer]);
  const deltas = [1, -1, 2, -2, 5, -5, 9, -9, 10, -10];
  let guard = 0;
  while (opts.size < 3 && guard++ < 60) {
    const d = answer + deltas[rnd(0, deltas.length - 1)];
    if (d >= 0) opts.add(d);
  }
  while (opts.size < 3) opts.add(answer + opts.size * 3 + 1);
  const options = shuffle([...opts]).map(String);
  return { question, options, correctText: String(answer), explanation };
}

function genAddSub(g, op) {
  const max = g <= 2 ? 50 : 100;
  const o = op || (rnd(0, 1) ? '+' : '-');
  let a, b, ans, sym;
  if (o === '+') { a = rnd(10, max); b = rnd(10, max); ans = a + b; sym = '+'; }
  else { a = rnd(20, max); b = rnd(10, a - 1); ans = a - b; sym = '−'; }
  const q = rnd(0, 1)
    ? `Сколько будет ${a} ${sym} ${b}?`
    : o === '+'
      ? `Если к числу ${a} прибавить ${b}, какое число получится?`
      : `Если из числа ${a} вычесть ${b}, какое число получится?`;
  return pack(ans, q, `${a} ${sym} ${b} = ${ans}.`);
}

function genCompound(g) {
  const b = rnd(2, 9), c = rnd(2, 9), p = b * c;
  if (rnd(0, 1)) {
    const a = rnd(p + 5, p + 80), ans = a - p;
    return pack(ans, `Какое число получится, если из числа ${a} вычесть произведение чисел ${b} и ${c}?`,
      `${b} × ${c} = ${p}; ${a} − ${p} = ${ans}.`);
  }
  const a = rnd(10, 80), ans = a + p;
  return pack(ans, `Какое число получится, если к числу ${a} прибавить произведение чисел ${b} и ${c}?`,
    `${b} × ${c} = ${p}; ${a} + ${p} = ${ans}.`);
}

function genMulDiv(g) {
  if (rnd(0, 1)) {
    const a = rnd(2, g === 3 ? 9 : 12), b = rnd(2, 9), ans = a * b;
    return pack(ans, `Сколько будет ${a} × ${b}?`, `${a} × ${b} = ${ans}.`);
  }
  const b = rnd(2, 9), ans = rnd(2, 12), a = b * ans;
  return pack(ans, `Сколько будет ${a} ÷ ${b}?`, `${a} ÷ ${b} = ${ans}.`);
}

function genSpeed() {
  const v = rnd(30, 90), t = rnd(2, 6), s = v * t;
  if (rnd(0, 1)) return pack(s, `Поезд идёт со скоростью ${v} км/ч. Сколько километров он пройдёт за ${t} ч?`, `${v} × ${t} = ${s} км.`);
  return pack(v, `Поезд прошёл ${s} км за ${t} ч. С какой скоростью он шёл?`, `${s} ÷ ${t} = ${v} км/ч.`);
}

function genRect() {
  const a = rnd(2, 12), b = rnd(2, 12);
  if (rnd(0, 1)) { const p = 2 * (a + b); return pack(p, `Стороны прямоугольника ${a} см и ${b} см. Найди периметр.`, `P = (${a} + ${b}) × 2 = ${p} см.`); }
  const s = a * b;
  return pack(s, `Стороны прямоугольника ${a} см и ${b} см. Найди площадь.`, `S = ${a} × ${b} = ${s} кв. см.`);
}

function genFrac() {
  const k = [2, 3, 4, 5, 10][rnd(0, 4)];
  const m = rnd(1, k - 1);
  const part = rnd(2, 12);
  const n = k * part;
  const ans = part * m;
  return pack(ans, `Найди ${m}/${k} от числа ${n}.`, `${n} ÷ ${k} × ${m} = ${ans}.`);
}

function makeMathQuestion(classLevel, topic, asked) {
  const g = Number(classLevel) || 4;
  const t = (topic || '').toLowerCase();
  const withCompound = g >= 3 && rnd(1, 100) <= 35;
  for (let attempt = 0; attempt < 30; attempt++) {
    let q;
    if (t.includes('скорост') || t.includes('врем')) q = genSpeed();
    else if (t.includes('периметр') || t.includes('площад')) q = genRect();
    else if (t.includes('дроб') || t.includes('дол')) q = genFrac();
    else if (t.includes('умнож') || t.includes('делен')) q = withCompound ? genCompound(g) : genMulDiv(g);
    else if (t.includes('сложен')) q = withCompound ? genCompound(g) : genAddSub(g, '+');
    else if (t.includes('вычитан')) q = withCompound ? genCompound(g) : genAddSub(g, '-');
    else q = withCompound ? genCompound(g) : genAddSub(g);
    if (asked.includes(q.question)) continue;
    return q;
  }
  return null;
}

// ========== Викторина ==========
app.post('/api/quiz', async (req, res) => {
  const { classLevel, subject, topic, sessionId } = req.body || {};
  const s = sessionId ? getSession(sessionId) : { history: [], asked: [] };
  const t = topic || '';
  try {
    let raw = null;
    if (subject === 'math') {
      // Математику придумывает и проверяет код — ошибки исключены
      raw = makeMathQuestion(classLevel, t, s.asked);
      if (!raw) return res.status(502).json({ error: 'Не удалось составить вопрос, нажмите «ещё раз»' });
    } else {
      // Русский язык: модель с обязательной самопроверкой
      const system =
        `Ты виртуальный учитель для ученика ${classLevel} класса. Предмет: Русский язык. Тема: ${t}. ` +
        `Ты отвечаешь за достоверность каждого факта: по тебе учится школьник. ` +
        `Составь ОДИН вопрос ровно с 3 вариантами ответа, из которых только один правильный; два других — правдоподобные, но ошибочные. ` +
        `Перед выдачей молча самопроверься: (1) сам сформулируй правильный ответ; (2) проверь каждый вариант по правилу орфографии; (3) убедись, что верен ровно один вариант. ` +
        (s.asked.length ? `НЕ повторяй вопросы: ${s.asked.join(' | ')}. ` : '') +
        `Ответь СТРОГО одним JSON без markdown: ` +
        `{"question":"текст вопроса","options":["вариант1","вариант2","вариант3"],"correctText":"текст правильного варианта дословно","explanation":"правило одной фразой"}.`;
      for (let attempt = 0; attempt < 2 && !raw; attempt++) {
        const text = await withRetry(() => gigaChat([
          { role: 'system', content: system },
          { role: 'user', content: attempt === 0 ? 'Составь следующий вопрос.' : 'Верни ТОЛЬКО исправный JSON по схеме, обязательно с полем correctText.' },
        ]));
        raw = parseQuizJson(text);
      }
      if (!raw) return res.status(502).json({ error: 'Модель не вернула вопрос, нажмите «ещё раз»' });
    }
    const norm = x => String(x).trim().toLowerCase();
    let correct = raw.options.findIndex(o => norm(o) === norm(raw.correctText));
    if (correct === -1) correct = raw.options.findIndex(o => norm(o).includes(norm(raw.correctText)) || norm(raw.correctText).includes(norm(o)));
    if (correct === -1) return res.status(502).json({ error: 'Ответ противоречив, нажмите «ещё раз»' });
    s.asked.push(raw.question);
    res.json({ question: raw.question, options: raw.options, correct, explanation: raw.explanation || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера: ' + e.message });
  }
});

function parseQuizJson(text) {
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    if (typeof obj.question !== 'string' || !Array.isArray(obj.options) || obj.options.length !== 3) return null;
    if (typeof obj.correctText !== 'string') return null;
    obj.explanation = typeof obj.explanation === 'string' ? obj.explanation : '';
    return obj;
  } catch { return null; }
}

app.listen(port, () => console.log(`Server running on http://localhost:${port}/`));