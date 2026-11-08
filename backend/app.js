const express = require('express');
const path = require('path');
const crypto = require('crypto');
// .env лежит в backend/, а запускаем мы из корня — путь указываем явно
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 3001;

const AUTH_KEY = process.env.GIGACHAT_AUTH_KEY;
const SCOPE = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
// Лёгкая модель называется именно "GigaChat-2"
const MODEL = process.env.GIGACHAT_MODEL || 'GigaChat-2';

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Раздаём фронтенд этим же сервером: сайт = http://localhost:3001
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---------- Токен GigaChat (OAuth) с кэшем ----------
let tokenCache = { token: null, expiresAtMs: 0 };
async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAtMs - 60_000) return tokenCache.token;
  if (!AUTH_KEY) throw new Error('Не задан GIGACHAT_AUTH_KEY в backend/.env');
  const res = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
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
  const res = await fetch('https://api.giga.chat/v1/chat/completions', {
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

// ---------- Служебный endpoint: список доступных моделей (для диагностики) ----------
app.get('/api/models', async (_req, res) => {
  try {
    const token = await getToken();
    const r = await fetch('https://api.giga.chat/v1/models', {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Память диалогов ----------
const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { history: [], asked: [] });
  return sessions.get(id);
}

// ---------- Режим "Объяснение" ----------
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
    const answer = await gigaChat([{ role: 'system', content: system }, ...s.history]);
    s.history.push({ role: 'assistant', content: answer });
    res.json({ answer });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера: ' + e.message });
  }
});

// ---------- Режим "Викторина": 1 вопрос, 3 варианта, строго JSON ----------
app.post('/api/quiz', async (req, res) => {
  const { classLevel, subject, topic, sessionId } = req.body || {};
  const subjectName = subject === 'math' ? 'Математика' : 'Русский язык';
  const s = sessionId ? getSession(sessionId) : { history: [], asked: [] };
  const system =
    `Ты генератор вопросов викторины для ученика ${classLevel} класса. ` +
    `Предмет: ${subjectName}. Тема: ${topic}. ` +
    `Составь ОДИН вопрос ровно с 3 вариантами ответа, из которых только один правильный. ` +
    `Сложность — строго по программе ${classLevel} класса. ` +
    (s.asked.length ? `НЕ повторяй уже заданные вопросы: ${s.asked.join(' | ')}. ` : '') +
    `Ответь СТРОГО одним JSON-объектом без markdown и лишних слов: ` +
    `{"question":"текст вопроса","options":["вариант1","вариант2","вариант3"],"correct":0,"explanation":"почему это правильный ответ"}. ` +
    `correct — номер правильного варианта (0, 1 или 2).`;
  try {
    let obj = null;
    for (let attempt = 0; attempt < 2 && !obj; attempt++) {
      const text = await gigaChat([
        { role: 'system', content: system },
        { role: 'user', content: attempt === 0 ? 'Составь следующий вопрос.' : 'Верни ТОЛЬКО исправный JSON по схеме.' },
      ]);
      obj = parseQuizJson(text);
    }
    if (!obj) return res.status(502).json({ error: 'Модель вернула не-JSON, нажмите "ещё раз"' });
    s.asked.push(obj.question);
    res.json(obj);
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
    if (typeof obj.correct !== 'number' || obj.correct < 0 || obj.correct > 2) return null;
    obj.explanation = typeof obj.explanation === 'string' ? obj.explanation : '';
    return obj;
  } catch {
    return null;
  }
}

app.listen(port, () => console.log(`Server running on http://localhost:${port}/`));