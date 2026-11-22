'use strict';

// Бот оповещений о рейде для плагина RaidAlert (Rust / Oxide).
//
// Как это устроено:
//   * Игрок берёт код в игровом меню и отправляет его боту (или открывает ссылку
//     t.me/<бот>?start=<код>, тогда код приходит сам).
//   * Бот проверяет, что человек подписан на канал. Без подписки код не принимается.
//   * Бот кладёт код в очередь событий. Игровой сервер раз в несколько секунд сам
//     забирает события (GET /api/events), проверяет код и отвечает (POST /api/ack).
//     Сервер к боту ходит, бот к серверу - никогда: серверу не нужен открытый порт.
//   * Оповещения о рейде сервер присылает на POST /api/alert. Перед отправкой бот
//     ещё раз проверяет подписку; отписавшимся не пишет и снимает привязку.
//   * Если человек отписался от канала, бот узнаёт об этом сразу (событие chat_member)
//     и дополнительно раз в несколько часов сверяет всех привязанных.
//
// Зависимостей нет: нужен только Node.js 18 или новее.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = __dirname;
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
const DATA_PATH = process.env.DATA_PATH || path.join(ROOT, 'data.json');
const TG_API = (process.env.TG_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Конфиг
// ---------------------------------------------------------------------------

function loadConfig() {
  let file = {};
  if (fs.existsSync(CONFIG_PATH)) {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } else if (!process.env.BOT_TOKEN) {
    console.error('Нет config.json. Скопируй config.example.json в config.json и заполни его.');
    process.exit(1);
  }

  const cfg = {
    botToken: process.env.BOT_TOKEN || file.botToken || '',
    channel: {
      id: process.env.CHANNEL_ID || (file.channel && file.channel.id) || '',
      url: process.env.CHANNEL_URL || (file.channel && file.channel.url) || '',
      title: (file.channel && file.channel.title) || 'наш канал',
    },
    serverName: (file.serverName != null ? file.serverName : ''),
    api: {
      host: (file.api && file.api.host) || '0.0.0.0',
      // Многие хостинги сами задают порт через переменную PORT.
      port: Number(process.env.PORT || (file.api && file.api.port) || 8085),
      secret: process.env.API_SECRET || (file.api && file.api.secret) || '',
      allowedIps: (file.api && Array.isArray(file.api.allowedIps)) ? file.api.allowedIps : [],
      trustProxy: !!(file.api && file.api.trustProxy),
    },
    recheckHours: Number(file.recheckHours != null ? file.recheckHours : 6),
    codeAttempts: Number(file.codeAttemptsPer10Min != null ? file.codeAttemptsPer10Min : 6),
    texts: Object.assign({
      alert: '🚨 <b>Твою базу ломают!</b>\nКвадрат: <b>{grid}</b>\nСервер: {server}',
      start: 'Привет! Я присылаю оповещения о рейде с сервера.\n\n'
        + '1. Подпишись на {channel}.\n'
        + '2. Возьми код в игре: <b>/menu</b> → «Уведомления о рейде» → Telegram.\n'
        + '3. Пришли код сюда одним сообщением.',
      needSubscribe: 'Чтобы получать оповещения, подпишись на {channel}, а потом нажми «Я подписался».',
      checking: '⏳ Проверяю код на сервере…',
      linked: '✅ Готово! Аккаунт <b>{name}</b> привязан. Сюда будут приходить оповещения о рейде.',
      badCode: '❌ Код не найден или устарел. Возьми новый в игровом меню и пришли его сюда.',
      serverTimeout: '⚠️ Сервер не ответил. Возможно, он перезагружается — попробуй ещё раз через пару минут.',
      tooMany: 'Слишком много попыток. Подожди несколько минут.',
      subscribeError: 'Не получилось проверить подписку. Попробуй ещё раз через минуту.',
      left: 'Ты отписался от {channel} — оповещения о рейде отключены. Подпишись снова и привяжи аккаунт заново.',
      unlinkedInGame: 'Привязка снята в игре. Оповещения о рейде больше не придут.',
      unlinked: 'Привязка снята. Оповещения о рейде больше не придут.',
      notLinked: 'Аккаунт пока не привязан. Возьми код в игровом меню и пришли его сюда.',
      status: 'Аккаунт привязан: <b>{name}</b>. Оповещения о рейде включены.\nОтвязать: /unlink',
      unknown: 'Не понял. Пришли код из игрового меню — он выглядит примерно так: <b>K7Q2MX</b>.',
    }, file.texts || {}),
  };

  const problems = [];
  if (!/^\d+:[\w-]+$/.test(cfg.botToken)) problems.push('botToken — токен от @BotFather');
  if (!cfg.channel.id) problems.push('channel.id — @username канала или его числовой ID (-100…)');
  if (!cfg.api.secret || cfg.api.secret.length < 16) problems.push('api.secret — случайная строка от 16 символов');
  if (problems.length) {
    console.error('В конфиге не заполнено:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }

  if (!cfg.channel.url && /^@/.test(cfg.channel.id)) cfg.channel.url = 'https://t.me/' + cfg.channel.id.slice(1);
  return cfg;
}

const CFG = loadConfig();

// ---------------------------------------------------------------------------
// Данные: привязки и очередь событий для сервера
// ---------------------------------------------------------------------------

let DATA = { nextId: 1, offset: 0, links: {}, events: [] };

function loadData() {
  if (!fs.existsSync(DATA_PATH)) return;
  try {
    const d = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    DATA = {
      nextId: Number(d.nextId) || 1,
      offset: Number(d.offset) || 0,
      links: d.links && typeof d.links === 'object' ? d.links : {},
      events: Array.isArray(d.events) ? d.events : [],
    };
  } catch (e) {
    const backup = DATA_PATH + '.broken-' + Date.now();
    fs.copyFileSync(DATA_PATH, backup);
    console.error('data.json повреждён, копия сохранена в ' + backup + '. Начинаю с пустого.');
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 500);
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  // Пишем во временный файл и переименовываем: при падении посреди записи
  // старый data.json остаётся целым.
  const tmp = DATA_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DATA, null, 1));
  fs.renameSync(tmp, DATA_PATH);
}

function pushEvent(type, payload) {
  const ev = Object.assign({ id: DATA.nextId++, type, at: Date.now() }, payload);
  DATA.events.push(ev);
  save();
  return ev;
}

function hasPendingEvent(type, telegramId) {
  return DATA.events.some(e => e.type === type && e.telegramId === telegramId);
}

// ---------------------------------------------------------------------------
// Telegram Bot API
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tg(method, params, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${TG_API}/bot${CFG.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: ctrl.signal,
    });
    return await res.json().catch(() => ({ ok: false, error_code: res.status, description: 'bad json' }));
  } catch (e) {
    return { ok: false, error_code: 0, description: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// Исходящие сообщения идут по очереди с паузой: у Telegram лимит ~30 сообщений
// в секунду, а при большом рейде оповещения приходят пачкой.
const outbox = [];
let pumping = false;

function send(method, params) {
  return new Promise(resolve => {
    outbox.push({ method, params, resolve });
    pump();
  });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (outbox.length) {
    const job = outbox.shift();
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await tg(job.method, job.params);
      if (r.ok || r.error_code !== 429) break;
      const wait = (r.parameters && r.parameters.retry_after) || 1;
      await sleep(wait * 1000);
    }
    job.resolve(r);
    await sleep(40);
  }
  pumping = false;
}

function sendText(chatId, text, extra) {
  return send('sendMessage', Object.assign({
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
  }, extra || {}));
}

function editText(chatId, messageId, text, extra) {
  return send('editMessageText', Object.assign({
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true,
  }, extra || {}));
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
}

function channelLink() {
  return CFG.channel.url
    ? `<a href="${esc(CFG.channel.url)}">${esc(CFG.channel.title)}</a>`
    : esc(CFG.channel.title);
}

function subscribeKeyboard(code) {
  const row = [];
  if (CFG.channel.url) row.push({ text: '📢 Подписаться', url: CFG.channel.url });
  row.push({ text: '✅ Я подписался', callback_data: 'check:' + code });
  return { inline_keyboard: [row] };
}

// ---------------------------------------------------------------------------
// Подписка на канал
// ---------------------------------------------------------------------------

const subCache = new Map(); // telegramId -> { ok, at }
const SUB_CACHE_MS = 10 * 60 * 1000;
let channelChatId = null;   // числовой ID канала, чтобы узнавать его в событиях chat_member

// true - подписан, false - нет, null - проверить не удалось (ошибка API).
async function isSubscribed(userId, fresh) {
  const cached = subCache.get(userId);
  if (!fresh && cached && Date.now() - cached.at < SUB_CACHE_MS) return cached.ok;

  const r = await tg('getChatMember', { chat_id: CFG.channel.id, user_id: userId });
  if (!r.ok) {
    // "user not found" / "participant_id_invalid" - человек ни разу не был в канале.
    if (r.error_code === 400 && /user not found|participant|member not found/i.test(r.description || '')) {
      subCache.set(userId, { ok: false, at: Date.now() });
      return false;
    }
    console.warn(`getChatMember(${userId}) не удался: ${r.description}. Бот должен быть администратором канала.`);
    return cached ? cached.ok : null;
  }

  const m = r.result;
  const ok = m.status === 'creator' || m.status === 'administrator' || m.status === 'member'
    || (m.status === 'restricted' && m.is_member === true);
  subCache.set(userId, { ok, at: Date.now() });
  return ok;
}

// Человек больше не подписан: снимаем привязку здесь и сообщаем серверу.
async function onUnsubscribed(telegramId, notify) {
  subCache.set(telegramId, { ok: false, at: Date.now() });

  const key = String(telegramId);
  const wasLinked = !!DATA.links[key];
  if (wasLinked) {
    delete DATA.links[key];
    save();
  }

  if (!hasPendingEvent('left', telegramId)) pushEvent('left', { telegramId });

  if (wasLinked && notify) {
    await sendText(telegramId, fill(CFG.texts.left, { channel: channelLink() }));
  }
}

// Плановая сверка: ловит тех, чей выход из канала бот пропустил (был выключен и т.п.).
async function recheckAll() {
  const ids = Object.keys(DATA.links);
  let dropped = 0;
  for (const key of ids) {
    const id = Number(key);
    const ok = await isSubscribed(id, true);
    if (ok === false) {
      await onUnsubscribed(id, true);
      dropped++;
    }
    await sleep(60);
  }
  if (ids.length) console.log(`Сверка подписок: проверено ${ids.length}, отписались ${dropped}.`);
}

// ---------------------------------------------------------------------------
// Коды привязки
// ---------------------------------------------------------------------------

const CODE_RE = /^[A-Z0-9]{4,12}$/;
const attempts = new Map(); // telegramId -> [timestamps]
const CODE_EVENT_TTL_MS = 2 * 60 * 1000;

function rateLimited(userId) {
  const now = Date.now();
  const list = (attempts.get(userId) || []).filter(t => now - t < 10 * 60 * 1000);
  if (list.length >= CFG.codeAttempts) {
    attempts.set(userId, list);
    return true;
  }
  list.push(now);
  attempts.set(userId, list);
  return false;
}

function displayName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return user.username ? '@' + user.username : (name || String(user.id));
}

async function handleCode(user, chatId, rawCode, editMessageId) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    await sendText(chatId, CFG.texts.unknown);
    return;
  }

  if (DATA.events.some(e => e.type === 'code' && e.telegramId === user.id)) {
    await sendText(chatId, 'Подожди, предыдущий код ещё проверяется.');
    return;
  }

  const sub = await isSubscribed(user.id, true);
  if (sub === null) {
    await sendText(chatId, CFG.texts.subscribeError);
    return;
  }
  if (!sub) {
    const text = fill(CFG.texts.needSubscribe, { channel: channelLink() });
    const markup = { reply_markup: subscribeKeyboard(code) };
    if (editMessageId) await editText(chatId, editMessageId, text, markup);
    else await sendText(chatId, text, markup);
    return;
  }

  // Ограничиваем только реальные попытки: без подписки код всё равно не уходит.
  if (rateLimited(user.id)) {
    await sendText(chatId, CFG.texts.tooMany);
    return;
  }

  let messageId = editMessageId || null;
  if (messageId) {
    await editText(chatId, messageId, CFG.texts.checking);
  } else {
    const r = await sendText(chatId, CFG.texts.checking);
    messageId = r.ok ? r.result.message_id : null;
  }

  pushEvent('code', {
    code,
    telegramId: user.id,
    username: displayName(user),
    chatId,
    messageId,
  });
}

async function reportToUser(ev, text) {
  if (ev.messageId) {
    const r = await editText(ev.chatId, ev.messageId, text);
    if (r.ok) return;
  }
  await sendText(ev.chatId || ev.telegramId, text);
}

// Ответ сервера на событие.
async function onResult(ev, r) {
  if (ev.type !== 'code') return;

  if (r.ok) {
    const steamId = String(r.steamId || '');
    // Один игровой аккаунт - один Telegram: старую привязку этого аккаунта убираем.
    for (const [key, link] of Object.entries(DATA.links)) {
      if (link.steamId === steamId && key !== String(ev.telegramId)) delete DATA.links[key];
    }
    DATA.links[String(ev.telegramId)] = { steamId, name: String(r.name || ''), at: Date.now() };
    save();
    await reportToUser(ev, fill(CFG.texts.linked, { name: esc(r.name || steamId) }));
    console.log(`Привязка: Telegram ${ev.telegramId} (${ev.username}) -> Steam ${steamId}.`);
  } else {
    await reportToUser(ev, CFG.texts.badCode);
  }
}

// Код висит в очереди, а сервер не забирает его (выключен, перезагружается).
async function expireCodeEvents() {
  const now = Date.now();
  const expired = DATA.events.filter(e => e.type === 'code' && now - e.at > CODE_EVENT_TTL_MS);
  if (!expired.length) return;

  DATA.events = DATA.events.filter(e => !expired.includes(e));
  save();
  for (const ev of expired) await reportToUser(ev, CFG.texts.serverTimeout);
}

// ---------------------------------------------------------------------------
// Входящие обновления Telegram
// ---------------------------------------------------------------------------

async function onMessage(msg) {
  if (!msg.chat || msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return;

  const user = msg.from;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  const [command, ...rest] = text.split(/\s+/);
  const cmd = command.toLowerCase().replace(/@.*$/, '');

  if (cmd === '/start') {
    // Ссылка t.me/<бот>?start=<код> приносит код сюда.
    if (rest[0]) return handleCode(user, chatId, rest[0]);
    return sendText(chatId, fill(CFG.texts.start, { channel: channelLink() }));
  }

  if (cmd === '/help') return sendText(chatId, fill(CFG.texts.start, { channel: channelLink() }));

  if (cmd === '/status') {
    const link = DATA.links[String(user.id)];
    return sendText(chatId, link ? fill(CFG.texts.status, { name: esc(link.name || link.steamId) }) : CFG.texts.notLinked);
  }

  if (cmd === '/unlink') {
    const key = String(user.id);
    if (!DATA.links[key]) return sendText(chatId, CFG.texts.notLinked);
    delete DATA.links[key];
    if (!hasPendingEvent('unlink', user.id)) pushEvent('unlink', { telegramId: user.id });
    save();
    return sendText(chatId, CFG.texts.unlinked);
  }

  if (text.startsWith('/')) return sendText(chatId, CFG.texts.unknown);

  return handleCode(user, chatId, text);
}

async function onCallback(q) {
  const data = q.data || '';
  await tg('answerCallbackQuery', { callback_query_id: q.id });

  if (data.startsWith('check:') && q.message) {
    await handleCode(q.from, q.message.chat.id, data.slice(6), q.message.message_id);
  }
}

async function onChatMember(upd) {
  const chat = upd.chat || {};
  const sameChannel = (channelChatId != null && chat.id === channelChatId)
    || ('@' + (chat.username || '')).toLowerCase() === String(CFG.channel.id).toLowerCase();
  if (!sameChannel) return;

  const user = upd.new_chat_member && upd.new_chat_member.user;
  if (!user) return;

  const st = upd.new_chat_member.status;
  const member = st === 'creator' || st === 'administrator' || st === 'member'
    || (st === 'restricted' && upd.new_chat_member.is_member === true);

  if (member) {
    subCache.set(user.id, { ok: true, at: Date.now() });
    return;
  }

  if (DATA.links[String(user.id)]) await onUnsubscribed(user.id, true);
  else subCache.set(user.id, { ok: false, at: Date.now() });
}

async function onUpdate(u) {
  if (u.message) return onMessage(u.message);
  if (u.callback_query) return onCallback(u.callback_query);
  if (u.chat_member) return onChatMember(u.chat_member);
}

async function pollLoop() {
  for (;;) {
    const r = await tg('getUpdates', {
      offset: DATA.offset,
      timeout: 50,
      // chat_member приходит только если попросить явно (и бот - админ канала).
      allowed_updates: ['message', 'callback_query', 'chat_member'],
    }, 65000);

    if (!r.ok) {
      if (r.error_code === 409) console.error('Этот токен уже опрашивает другая копия бота или стоит вебхук.');
      else if (r.error_code === 401) { console.error('Неверный botToken.'); process.exit(1); }
      else if (r.description !== 'timeout') console.warn('getUpdates: ' + r.description);
      await sleep(3000);
      continue;
    }

    for (const u of r.result) {
      DATA.offset = u.update_id + 1;
      try { await onUpdate(u); } catch (e) { console.error('Ошибка обработки обновления:', e); }
    }
    if (r.result.length) save();
  }
}

// ---------------------------------------------------------------------------
// HTTP API для игрового сервера
// ---------------------------------------------------------------------------

let botUsername = '';
const secretHash = crypto.createHash('sha256').update(CFG.api.secret).digest();

function checkSecret(value) {
  const h = crypto.createHash('sha256').update(String(value || '')).digest();
  return crypto.timingSafeEqual(h, secretHash);
}

function clientIp(req) {
  if (CFG.api.trustProxy && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function reply(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 256 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Сервер присылает steamId строкой: 64-битное число в JS теряет точность.
function publicEvent(e) {
  const out = { id: e.id, type: e.type, telegramId: e.telegramId };
  if (e.type === 'code') { out.code = e.code; out.username = e.username; }
  return out;
}

async function apiAlert(body) {
  const telegramId = Number(body.telegramId);
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) return { status: 400, body: { ok: false, error: 'telegramId' } };

  // Оповещения - только подписчикам канала.
  const sub = await isSubscribed(telegramId, false);
  if (sub === false) {
    await onUnsubscribed(telegramId, true);
    return { status: 200, body: { ok: false, reason: 'not_subscribed' } };
  }

  // Если data.json потерялся, привязка восстанавливается по первому же оповещению.
  const key = String(telegramId);
  if (!DATA.links[key] && body.steamId) {
    DATA.links[key] = { steamId: String(body.steamId), name: '', at: Date.now() };
    save();
  }

  const text = fill(CFG.texts.alert, {
    grid: esc(body.grid || '?'),
    server: esc(CFG.serverName || body.server || ''),
  });

  const r = await sendText(telegramId, text);
  if (!r.ok) {
    // 403 - человек заблокировал бота. Привязку не трогаем: разблокирует - снова начнёт получать.
    return { status: 200, body: { ok: false, reason: r.error_code === 403 ? 'blocked' : 'telegram', error: r.description } };
  }
  return { status: 200, body: { ok: true } };
}

async function apiUnlink(body) {
  const telegramId = Number(body.telegramId);
  const key = String(telegramId);
  const link = DATA.links[key];
  if (link && (!body.steamId || link.steamId === String(body.steamId))) {
    delete DATA.links[key];
    save();
    await sendText(telegramId, CFG.texts.unlinkedInGame);
  }
  return { status: 200, body: { ok: true } };
}

async function apiAck(body) {
  const results = Array.isArray(body.results) ? body.results : [];
  let handled = 0;

  for (const r of results) {
    const id = Number(r && r.id);
    const idx = DATA.events.findIndex(e => e.id === id);
    if (idx < 0) continue; // уже подтверждено раньше
    const ev = DATA.events[idx];
    DATA.events.splice(idx, 1);
    handled++;
    try { await onResult(ev, r); } catch (e) { console.error('Ошибка обработки ответа сервера:', e); }
  }

  if (handled) save();
  return { status: 200, body: { ok: true, handled } };
}

let lastServerPoll = 0;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      return reply(res, 200, { ok: true, bot: botUsername, serverSeenSecAgo: lastServerPoll ? Math.round((Date.now() - lastServerPoll) / 1000) : null });
    }

    const ip = clientIp(req);
    if (CFG.api.allowedIps.length && !CFG.api.allowedIps.includes(ip)) {
      return reply(res, 403, { ok: false, error: 'ip' });
    }
    if (!checkSecret(req.headers['x-api-secret'])) {
      return reply(res, 401, { ok: false, error: 'secret' });
    }

    const route = req.method + ' ' + url.pathname;
    const body = req.method === 'POST' ? await readJson(req) : {};
    let out;

    switch (route) {
      case 'GET /api/events':
        lastServerPoll = Date.now();
        out = {
          status: 200,
          body: {
            ok: true,
            bot: botUsername,
            channel: CFG.channel.title,
            channelUrl: CFG.channel.url,
            events: DATA.events.slice(0, 50).map(publicEvent),
          },
        };
        break;
      case 'POST /api/ack': out = await apiAck(body); break;
      case 'POST /api/alert': out = await apiAlert(body); break;
      case 'POST /api/unlink': out = await apiUnlink(body); break;
      default: out = { status: 404, body: { ok: false, error: 'not found' } };
    }

    reply(res, out.status, out.body);
  } catch (e) {
    console.error('HTTP ' + req.method + ' ' + req.url + ':', e.message);
    if (!res.headersSent) reply(res, 400, { ok: false, error: 'bad request' });
  }
});

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------

async function start() {
  loadData();

  const me = await tg('getMe', {});
  if (!me.ok) {
    console.error('Не удалось подключиться к Telegram: ' + me.description);
    process.exit(1);
  }
  botUsername = me.result.username;

  // Бот работает через getUpdates: вебхук, если остался от другого бота, мешает.
  await tg('deleteWebhook', { drop_pending_updates: false });

  const chat = await tg('getChat', { chat_id: CFG.channel.id });
  if (chat.ok) {
    channelChatId = chat.result.id;
    if (!CFG.channel.url && chat.result.username) CFG.channel.url = 'https://t.me/' + chat.result.username;
    if (CFG.channel.title === 'наш канал' && chat.result.title) CFG.channel.title = chat.result.title;
  } else {
    console.warn('Канал ' + CFG.channel.id + ' не найден: ' + chat.description + '. Добавь бота в канал администратором.');
  }

  const self = await tg('getChatMember', { chat_id: CFG.channel.id, user_id: me.result.id });
  if (!self.ok || (self.result.status !== 'administrator' && self.result.status !== 'creator')) {
    console.warn('ВНИМАНИЕ: бот не администратор канала ' + CFG.channel.id
      + ' — без этого он не может проверять подписку. Добавь его в администраторы (права можно не давать).');
  }

  server.listen(CFG.api.port, CFG.api.host, () => {
    console.log(`Бот @${botUsername} запущен. API для сервера: http://${CFG.api.host}:${CFG.api.port}. `
      + `Канал: ${CFG.channel.id}. Привязано: ${Object.keys(DATA.links).length}.`);
  });

  setInterval(() => { expireCodeEvents().catch(e => console.error(e)); }, 15000);

  if (CFG.recheckHours > 0) {
    setTimeout(() => recheckAll().catch(e => console.error(e)), 60 * 1000);
    setInterval(() => recheckAll().catch(e => console.error(e)), CFG.recheckHours * 3600 * 1000);
  }

  pollLoop();
}

function shutdown() {
  try { saveNow(); } catch (e) { /* ignore */ }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));

start().catch(e => {
  console.error(e);
  process.exit(1);
});
