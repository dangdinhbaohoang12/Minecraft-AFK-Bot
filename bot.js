const mineflayer = require('mineflayer');
const config = require('./config.json');

// Prefer the host's secret/environment variable. config.botPassword remains
// supported for local use, but should not be committed to a public repository.
const rawPassword = process.env.BOT_PASSWORD || config.botPassword || '';
const PASSWORD = typeof rawPassword === 'string' ? rawPassword.trim() : '';

const STEP_INTERVAL = 1500;
const JUMP_DURATION = 500;
const RECONNECT_DELAY_MS = Math.max(
  30000,
  Number(config.reconnectDelay) || 30000
);

// One process-wide reconnect timer prevents duplicate bot instances.
let reconnectTimer = null;

function isAuthSuccess(text) {
  if (/already (logged|authenticated)|you are now logged in|đã đăng nhập|da dang nhap/.test(text)) {
    return true;
  }

  return /success|thành công|thanh cong/.test(text) &&
    /log|regist|đăng|dang/.test(text);
}

function startBot() {
  if (!PASSWORD) {
    console.error(
      '⛔ BOT_PASSWORD is missing. Add BOT_PASSWORD in Hyehost environment variables, then restart the app.'
    );
    return;
  }

  console.log(
    '🔌 Connecting ' + config.botUsername + ' to ' +
    config.serverHost + ':' + config.serverPort
  );

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
  let authBlocked = false;
  let registerArgs = 2;
  let promptTimer = null;
  let moveTimer = null;
  let sneakTimer = null;
  let jumpTimer = null;
  let movementStarted = false;
  let movementPhase = 0;
  let scheduledAuthKind = null;

  // Never send the same auth command repeatedly in one connection. The server
  // prompt, not a blind timer, determines whether to login or register.
  const authCommandsSent = new Set();

  function clearAuthTimer() {
    if (promptTimer) clearTimeout(promptTimer);
    promptTimer = null;
    scheduledAuthKind = null;
  }

  function blockAuthentication(reason) {
    if (authBlocked) return;
    authBlocked = true;
    clearAuthTimer();

    console.error('⛔ Automatic authentication stopped: ' + reason);
    console.error(
      'Fix the account/password or ask the server administrator to resolve the registration limit, then restart the bot.'
    );
  }

  function sendAuth(kind) {
    if (ended || authed || authBlocked || authCommandsSent.has(kind)) return;

    authCommandsSent.add(kind);

    const command = kind === 'register'
      ? (registerArgs === 1
          ? '/register ' + PASSWORD
          : '/register ' + PASSWORD + ' ' + PASSWORD)
      : '/login ' + PASSWORD;

    try {
      bot.chat(command);
      console.log('🔑 Sent /' + kind + ' once for this connection.');
    } catch (error) {
      console.error('⚠️ Could not send authentication command:', error.message || error);
    }
  }

  function schedulePromptAuth(kind) {
    if (ended || authed || authBlocked || authCommandsSent.has(kind)) return;
    if (promptTimer && scheduledAuthKind === kind) return;

    clearAuthTimer();
    scheduledAuthKind = kind;
    promptTimer = setTimeout(() => {
      promptTimer = null;
      scheduledAuthKind = null;
      sendAuth(kind);
    }, 1500);
  }

  function onAuthed() {
    if (authed || ended || authBlocked) return;

    authed = true;
    clearAuthTimer();
    console.log('✅ ' + config.botUsername + ' is authenticated and ready!');

    // Reset the reconnect delay after a successful authenticated connection.
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (bot.entity) startMovement();
  }

  bot.once('login', () => {
    console.log('✅ Connected to the server; waiting for its login/register prompt.');
  });

  bot.on('spawn', () => {
    if (sneakTimer) clearTimeout(sneakTimer);
    sneakTimer = setTimeout(() => {
      if (!ended && bot.entity) {
        try {
          bot.setControlState('sneak', true);
        } catch (error) {
          console.warn('⚠️ Could not enable sneak:', error.message || error);
        }
      }
    }, 3000);

    if (authed) startMovement();
  });

  bot.on('message', (jsonMsg) => {
    const raw = String(jsonMsg).trim();
    if (!raw) return;
    console.log('💬 ' + raw);

    if (authed || authBlocked || ended) return;

    const text = raw.toLowerCase();

    // Stop rather than hammer the server when the account/IP registration
    // quota has been reached. Client code cannot legitimately bypass this.
    if (
      /maximum number of registrations|exceeded.*registrations|registration limit|too many registrations/.test(text) ||
      /vượt quá.*lượt đăng ký|giới hạn đăng ký/.test(text)
    ) {
      blockAuthentication('the server registration limit has been reached.');
      return;
    }

    if (
      /incorrect password|wrong password|invalid password|password is incorrect/.test(text) ||
      /sai mật khẩu|mật khẩu không đúng/.test(text)
    ) {
      blockAuthentication('the server rejected the password.');
      return;
    }

    if (isAuthSuccess(text)) {
      onAuthed();
      return;
    }

    // An existing account should be logged into, not registered again.
    if (/already registered|đã đăng ký|da dang ky/.test(text)) {
      schedulePromptAuth('login');
      return;
    }

    const wantsRegister =
      text.includes('/register') ||
      text.includes('please, register') ||
      text.includes('please register') ||
      text.includes('đăng ký') ||
      text.includes('dang ky');

    const wantsLogin =
      text.includes('/login') ||
      text.includes('please, login') ||
      text.includes('please login') ||
      text.includes('please log in') ||
      text.includes('đăng nhập') ||
      text.includes('dang nhap');

    if (wantsRegister && !wantsLogin) {
      // Support both /register <password> and /register <password> <confirm>.
      const match = text.match(/\/register((?:\s+<[^>]*>)+)/i);
      if (match) {
        const placeholders = match[1].match(/<[^>]*>/g) || [];
        registerArgs = placeholders.length >= 2 ? 2 : 1;
      }
      schedulePromptAuth('register');
    } else if (wantsLogin) {
      schedulePromptAuth('login');
    }
  });

  bot.on('kicked', (reason) => {
    console.log(
      '⛔ Kicked from server:',
      typeof reason === 'string' ? reason : JSON.stringify(reason)
    );
  });

  bot.on('error', (error) => {
    if (error && (error.code === 'EPIPE' || error.code === 'ECONNRESET')) {
      // Do not send more chat packets while the socket is closing. The end
      // event below owns reconnect scheduling.
      clearAuthTimer();
      console.warn('⚠️ Connection socket closed (' + error.code + ').');
      return;
    }

    console.error('⚠️ Bot error:', error);
  });

  bot.on('end', () => {
    if (ended) return;
    ended = true;

    clearAuthTimer();
    clearTimeout(moveTimer);
    clearTimeout(sneakTimer);
    clearTimeout(jumpTimer);

    try {
      bot.clearControlStates();
    } catch (_) {
      // The socket may already be closed.
    }

    if (authBlocked) {
      console.error(
        '⛔ Not reconnecting because authentication is blocked. Resolve the server account/password issue and restart the app.'
      );
      return;
    }

    if (reconnectTimer) return;

    console.log(
      '⛔ Bot disconnected. Reconnecting in ' +
      Math.round(RECONNECT_DELAY_MS / 1000) + ' seconds...'
    );

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startBot();
    }, RECONNECT_DELAY_MS);
  });

  // ---------- ANTI-AFK MOVEMENT ----------
  function startMovement() {
    if (movementStarted || ended || !authed || !bot.entity) return;
    movementStarted = true;
    moveTimer = setTimeout(movementCycle, STEP_INTERVAL);
  }

  function movementCycle() {
    if (ended || !authed || !bot.entity) {
      movementStarted = false;
      return;
    }

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
        if (jumpTimer) clearTimeout(jumpTimer);
        jumpTimer = setTimeout(() => {
          if (!ended && bot.entity) {
            bot.setControlState('jump', false);
          }
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

if (!PASSWORD) {
  console.error(
    '⛔ BOT_PASSWORD is not set. Add it in the hosting panel under Environment Variables, then restart.'
  );
  process.exitCode = 1;
} else {
  startBot();
}

// Socket errors are normally delivered through bot.on('error'). Keep a clear
// diagnostic for any remaining asynchronous failures.
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  if (error && (error.code === 'EPIPE' || error.code === 'ECONNRESET')) return;
  process.exitCode = 1;
});
