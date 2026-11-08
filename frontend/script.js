const API = location.port === '3001' ? '' : 'http://localhost:3001';

const state = {
  grade: null, subject: null, mode: null, topic: '',
  sessionId: crypto.randomUUID(),
  quiz: { current: 0, total: 10, correct: 0, data: null, answered: false, retry: false },
};

const TOPICS = {
  math: ['Сложение и вычитание в пределах 100', 'Умножение и деление', 'Задачи на скорость и время', 'Периметр и площадь', 'Доли и дроби'],
  russian: ['Словарные слова', 'Приставки и предлоги', 'Мягкий и твёрдый знак', 'Падежи и окончания', 'Безударные гласные в корне'],
};
const DEFAULT_TOPIC = {
  math: 'арифметические действия и задачи по программе класса',
  russian: 'словарные слова с непроверяемым написанием',
};
const LETTERS = ['А', 'Б', 'В'];

const $ = (id) => document.getElementById(id);
const screens = { start: $('screen-start'), quiz: $('screen-quiz'), result: $('screen-result'), learn: $('screen-learn') };

function showScreen(name) {
  Object.values(screens).forEach(s => (s.hidden = true));
  screens[name].hidden = false;
}
function refreshStartButton() {
  $('start-btn').disabled = !(state.grade && state.subject && state.mode);
}

document.querySelectorAll('#grade-pills .pill').forEach(btn => btn.addEventListener('click', () => {
  state.grade = btn.dataset.grade;
  document.querySelectorAll('#grade-pills .pill').forEach(b => b.classList.toggle('selected', b === btn));
  refreshStartButton();
}));
document.querySelectorAll('#subject-cards .card').forEach(btn => btn.addEventListener('click', () => {
  state.subject = btn.dataset.subject;
  document.querySelectorAll('#subject-cards .card').forEach(b => b.classList.toggle('selected', b === btn));
  renderChips();
  refreshStartButton();
}));
document.querySelectorAll('#mode-cards .card').forEach(btn => btn.addEventListener('click', () => {
  state.mode = btn.dataset.mode;
  document.querySelectorAll('#mode-cards .card').forEach(b => b.classList.toggle('selected', b === btn));
  $('topic-block').hidden = false;
  refreshStartButton();
}));

function renderChips() {
  const box = $('topic-chips');
  box.innerHTML = '';
  (TOPICS[state.subject] || []).forEach(t => {
    const c = document.createElement('button');
    c.className = 'chip'; c.textContent = t;
    c.addEventListener('click', () => {
      state.topic = t; $('topic-input').value = t;
      box.querySelectorAll('.chip').forEach(x => x.classList.toggle('selected', x === c));
    });
    box.appendChild(c);
  });
}
$('topic-input').addEventListener('input', e => { state.topic = e.target.value.trim(); });

$('start-btn').addEventListener('click', () => {
  state.sessionId = crypto.randomUUID();
  if (state.mode === 'quiz') {
    state.quiz = { current: 1, total: 10, correct: 0, data: null, answered: false, retry: false };
    showScreen('quiz');
    loadQuestion();
  } else {
    showScreen('learn');
    $('chat-log').innerHTML = '';
    addMsg('bot', `Привет! Я объясню любую тему по предмету «${state.subject === 'math' ? 'Математика' : 'Русский язык'}» для ${state.grade} класса. Спроси!`);
  }
});

// ---------- Викторина ----------
async function loadQuestion() {
  const qz = state.quiz;
  qz.answered = false;
  $('quiz-progress').textContent = `Вопрос ${qz.current} из ${qz.total}`;
  $('quiz-score').textContent = `⭐ ${qz.correct}`;
  $('progress-fill').style.width = ((qz.current - 1) / qz.total) * 100 + '%';
  $('quiz-question').textContent = 'Придумываю вопрос…';
  $('quiz-question').classList.add('loading');
  $('quiz-options').innerHTML = '';
  $('quiz-feedback').hidden = true;
  $('next-btn').hidden = true;
  try {
    const res = await fetch(API + '/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        classLevel: state.grade, subject: state.subject,
        topic: state.topic || DEFAULT_TOPIC[state.subject],
        sessionId: state.sessionId,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    qz.data = data;
    $('quiz-question').classList.remove('loading');
    $('quiz-question').textContent = data.question;
    data.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.className = 'option';
      b.textContent = `${LETTERS[i]}. ${opt}`;
      b.addEventListener('click', () => answer(i, b));
      $('quiz-options').appendChild(b);
    });
  } catch (e) {
    $('quiz-question').classList.remove('loading');
    $('quiz-question').textContent = 'Ошибка: ' + e.message;
    qz.retry = true;
    $('next-btn').hidden = false;
    $('next-btn').textContent = 'Попробовать ещё раз 🔁';
  }
}

function answer(i, btn) {
  const qz = state.quiz;
  if (qz.answered) return;
  qz.answered = true;
  [...$('quiz-options').children].forEach((b, idx) => {
    b.disabled = true;
    if (idx === qz.data.correct) b.classList.add('correct');
    else if (idx === i) b.classList.add('wrong');
  });
  const fb = $('quiz-feedback');
  fb.hidden = false;
  if (i === qz.data.correct) { qz.correct++; fb.textContent = 'Правильно! 🎉 ' + qz.data.explanation; }
  else fb.textContent = `Правильный ответ: ${LETTERS[qz.data.correct]}. ${qz.data.explanation}`;
  $('quiz-score').textContent = `⭐ ${qz.correct}`;
  qz.retry = false;
  $('next-btn').hidden = false;
  $('next-btn').textContent = qz.current < qz.total ? 'Следующий вопрос ➡️' : 'Показать результат 🏁';
}

$('next-btn').addEventListener('click', () => {
  const qz = state.quiz;
  if (qz.retry) { loadQuestion(); return; }
  if (qz.current < qz.total) { qz.current++; loadQuestion(); }
  else finishQuiz();
});

function finishQuiz() {
  const qz = state.quiz;
  $('progress-fill').style.width = '100%';
  saveStats(qz);
  const c = qz.correct;
  let emoji = '💪', title = 'Хорошая попытка! Потренируемся ещё?';
  if (c >= 9) { emoji = '🏆'; title = 'Великолепно!'; }
  else if (c >= 7) { emoji = '🎉'; title = 'Отлично!'; }
  else if (c >= 5) { emoji = '👍'; title = 'Неплохо!'; }
  $('result-emoji').textContent = emoji;
  $('result-title').textContent = title;
  $('result-text').textContent = `Правильных ответов: ${c} из ${qz.total}. Результат сохранён в «Мои результаты».`;
  showScreen('result');
}

$('again-btn').addEventListener('click', () => {
  state.sessionId = crypto.randomUUID();
  state.quiz = { current: 1, total: 10, correct: 0, data: null, answered: false, retry: false };
  showScreen('quiz');
  loadQuestion();
});
$('home-btn').addEventListener('click', () => showScreen('start'));
$('learn-home-btn').addEventListener('click', () => showScreen('start'));

// ---------- Статистика (для исследования к защите) ----------
function saveStats(qz) {
  const arr = JSON.parse(localStorage.getItem('trainerStats') || '[]');
  arr.push({
    date: new Date().toLocaleDateString('ru-RU'),
    grade: state.grade,
    subject: state.subject === 'math' ? 'Математика' : 'Русский язык',
    topic: state.topic || DEFAULT_TOPIC[state.subject],
    correct: qz.correct, total: qz.total,
  });
  localStorage.setItem('trainerStats', JSON.stringify(arr));
}
$('stats-btn').addEventListener('click', () => {
  const box = $('stats-box');
  box.hidden = !box.hidden;
  if (box.hidden) return;
  const arr = JSON.parse(localStorage.getItem('trainerStats') || '[]');
  box.innerHTML = arr.length
    ? arr.map(s => `<div>📅 ${s.date} — ${s.subject}, ${s.grade} кл., «${s.topic}»: ${s.correct}/${s.total}</div>`).join('')
    : '<div>Пока нет ни одной сыгранной викторины.</div>';
});

// ---------- Объяснение ----------
function addMsg(who, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  div.textContent = text;
  $('chat-log').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}
async function sendLearn() {
  const input = $('user-input');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  addMsg('user', question);
  const loading = addMsg('bot', 'Думаю…');
  loading.classList.add('loading');
  try {
    const res = await fetch(API + '/api/learn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classLevel: state.grade, subject: state.subject, question, sessionId: state.sessionId }),
    });
    const data = await res.json();
    loading.remove();
    addMsg('bot', data.answer || ('Ошибка: ' + (data.error || res.status)));
  } catch (e) {
    loading.remove();
    addMsg('bot', 'Не удалось связаться с сервером: ' + e.message);
  }
}
$('send-btn').addEventListener('click', sendLearn);
$('user-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendLearn(); });