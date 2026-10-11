const mineflayer = require('mineflayer');
const config = require('./config.json');

const PASSWORD = config.botPassword;
const STEP_INTERVAL = 1500;
const JUMP_DURATION = 500;

// Auth timing. AuthMe kicks after 30s ("Login timeout exceeded"), so we must be well inside that.
const AUTH_FIRST_FALLBACK_MS = 4000;  // if the server never prompted us, try on our own after 4s
const AUTH_RETRY_MS = 5000;           // gap between fallback attempts
const AUTH_MAX_ATTEMPTS = 6;          // 6 attempts * ~5s = done well before the 30s timeout
const RECONNECT_DELAY_MS = config.reconnectDelay || 10000;

// Chat lines that mean "we are logged in now" (English + Vietnamese)
function isAuthSuccess(text) {
  if (/already (logged|authenticated)|đã đăng nhập|da dang nhap/.test(text)) return true;
  const ok = /success|thành công|thanh cong/.test(text);
  const about = /log|regist|đăng|dang/.test(text);
  return ok && about;
}

function startBot() {
  const bot = mineflayer.createBot({
    host: config.serverHost,
    port: config.serverPort,
    username: config.botUsername,
    auth: 'offline',
    version: config.version || false,
    viewDistance: config.botChunk
  });

  let ended = false;
  let authed = false;
  let authStarted = false;
  let attempts = 0;
  let registerArgs = 2;            // 2 = "/register <pw> <pw>", 1 = "/register <pw>"
  let lastSentAt = 0;
  let promptTimer = null;
  let fallbackTimer = null;
  let moveTimer = null;
  let movementStarted = false;
  let movementPhase = 0;

  // ---------- AUTH ----------
  function sendAuth(kind) {
    if (ended || authed) return;
    const now = Date.now();
    if (now - lastSentAt < 1500) return;   // avoid "too fast chat" kicks
    lastSentAt = now;
    attempts++;

    if (kind === 'register') {
      const cmd = registerArgs === 1
        ? `/register ${PASSWORD}`
        : `/register ${PASSWORD} ${PASSWORD}`;
      bot.chat(cmd);
      console.log(`🔑 Sent /register (attempt ${attempts})`);
    } else {
      bot.chat(`/login ${PASSWORD}`);
      console.log(`🔑 Sent /login (attempt ${attempts})`);
    }
  }

  function schedulePromptAuth(kind) {
    if (promptTimer) clearTimeout(promptTimer);
    promptTimer = setTimeout(() => sendAuth(kind), 1500);
  }

  // Runs even if the server never says anything we recognise.
  function fallbackTick() {
    if (ended || authed) return;
    if (attempts >= AUTH_MAX_ATTEMPTS) {
      console.log('⚠️ Could not confirm login; moving on anyway (check the chat log above).');
      startMovement();
      return;
    }
    // Alternate: login first (account usually exists), then register
    sendAuth(attempts % 2 === 0 ? 'login' : 'register');
    fallbackTimer = setTimeout(fallbackTick, AUTH_RETRY_MS);
  }

  function onAuthed() {
    if (authed) return;
    authed = true;
    clearTimeout(promptTimer);
    clearTimeout(fallbackTimer);
    console.log(`✅ ${config.botUsername} is authenticated and Ready!`);
    startMovement();
  }

  // ---------- EVENTS ----------
  // 'login' fires as soon as the server accepts us (before chunks load), so the
  // auth countdown starts immediately instead of waiting for 'spawn'.
  bot.once('login', () => {
    if (authStarted) return;
    authStarted = true;
    fallbackTimer = setTimeout(fallbackTick, AUTH_FIRST_FALLBACK_MS);
  });

  bot.on('spawn', () => {
    // Sneak after 3s (also re-applied after respawn)
    setTimeout(() => {
      if (!ended) bot.setControlState('sneak', true);
    }, 3000);
  });

  bot.on('message', (jsonMsg) => {
    const raw = jsonMsg.toString().trim();
    if (!raw) return;
    console.log(`💬 ${raw}`);           // so you can SEE what the server asks for
    if (authed) return;

    const text = raw.toLowerCase();

    if (isAuthSuccess(text)) {
      onAuthed();
      return;
    }

    // Account already exists -> log in instead
    if (/already registered|đã đăng ký|da dang ky/.test(text)) {
      schedulePromptAuth('login');
      return;
    }

    const wantsRegister = text.includes('/register') || text.includes('dang ky') || text.includes('đăng ký');
    const wantsLogin = text.includes('/login') || text.includes('dang nhap') || text.includes('đăng nhập');

    if (wantsRegister && !wantsLogin) {
      // Learn how many arguments the server wants: "/register <password>" vs "/register <password> <confirm>"
      const m = text.match(/\/register((?:\s+<[^>]*>)+)/);
      if (m) registerArgs = (m[1].match(/<[^>]*>/g) || []).length >= 2 ? 2 : 1;
      if (attempts < AUTH_MAX_ATTEMPTS + 4) schedulePromptAuth('register');
    } else if (wantsLogin && attempts < AUTH_MAX_ATTEMPTS + 4) {
      schedulePromptAuth('login');
    }
  });

  bot.on('kicked', (reason) => {
    console.log('⛔️ Kicked from server:', typeof reason === 'string' ? reason : JSON.stringify(reason));
  });

  bot.on('error', (err) => {
    if (err.code === 'ECONNRESET') {
      console.log('⚠️ Network error (ECONNRESET), ignoring - will reconnect if the connection drops.');
      return;
    }
    console.error('⚠️ Error:', err);
  });

  bot.on('end', () => {
    if (ended) return;
    ended = true;
    clearTimeout(promptTimer);
    clearTimeout(fallbackTimer);
    clearTimeout(moveTimer);
    console.log(`⛔️ Bot Disconnected! Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(startBot, RECONNECT_DELAY_MS);
  });

  // ---------- ANTI-AFK MOVEMENT ----------
  function startMovement() {
    if (movementStarted || ended) return;
    movementStarted = true;
    moveTimer = setTimeout(movementCycle, STEP_INTERVAL);
  }

  function movementCycle() {
    if (ended || !bot.entity) return;

    switch (movementPhase) {
      case 0:
        bot.setControlState('forward', true);
        bot.setControlState('back', false);
        bot.setControlState('jump', false);
        break;
      case 1:
        bot.setControlState('forward', false);
        bot.setControlState('back', true);
        bot.setControlState('jump', false);
        break;
      case 2:
        bot.setControlState('forward', false);
        bot.setControlState('back', false);
        bot.setControlState('jump', true);
        setTimeout(() => {
          if (!ended) bot.setControlState('jump', false);
        }, JUMP_DURATION);
        break;
      case 3:
        bot.setControlState('forward', false);
        bot.setControlState('back', false);
        bot.setControlState('jump', false);
        break;
    }

    movementPhase = (movementPhase + 1) % 4;
    moveTimer = setTimeout(movementCycle, STEP_INTERVAL);
  }
}

startBot();

// Keep the process alive on unhandled socket errors
process.on('unhandledRejection', (error) => {
  if (!error || error.code !== 'ECONNRESET') console.error('Unhandled error:', error);
});
process.on('uncaughtException', (error) => {
  if (!error || error.code !== 'ECONNRESET') console.error('Fatal error:', error);
});
