const mineflayer = require('mineflayer');
const http = require('node:http');
const config = require('./config.json');

// Small HTTP health endpoint for hosting services that require the app to bind
// to PORT (Hyehost Free uses 8080). This endpoint never exposes credentials.
const healthPort = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8080;
let healthState = {
  state: 'starting',
  botConnected: false,
  authenticated: false,
  details: 'Starting process',
  updatedAt: new Date().toISOString()
};

function setHealthState(state, details, botConnected = false, authenticated = false) {
  healthState = {
    state,
    botConnected,
    authenticated,
    details,
    updatedAt: new Date().toISOString()
  };
}

const healthServer = http.createServer((req, res) => {
  const payload = JSON.stringify({
    service: 'Minecraft AFK Bot',
    endpoint: req.url || '/',
    ...healthState
  }, null, 2);

  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(payload + '\n');
});

healthServer.on('error', (error) => {
  console.error('⚠️ HTTP health endpoint error:', error.message || error);
});
healthServer.listen(healthPort, '0.0.0.0', () => {
  console.log(`🌐 HTTP health endpoint listening on 0.0.0.0:${healthPort}`);
});

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
    setHealthState('needs_password', 'BOT_PASSWORD environment variable is missing.');
    console.error(
      '⛔ BOT_PASSWORD is missing. Add BOT_PASSWORD in Hyehost environment variables, then restart the app.'
    );
    return;
  }

  setHealthState('connecting', 'Connecting to the Minecraft server.');
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
  let socketClosed = false;

  // Never send the same auth command repeatedly in one connection. The server
  // prompt, not a blind timer, determines whether to login or register.
  const authCommandsSent = new Set();

  function isSocketKnownClosed() {
    const socket = bot._client && bot._client.socket;
    // Some client wrappers do not expose a socket at this point. A missing
    // socket reference alone must not block a chat command while messages are
    // actively arriving from the server.
    return ended ||
      socketClosed ||
      !!(socket && (socket.destroyed || socket.writableEnded || socket.writable === false));
  }

  function onSocketError(error) {
    if (error && (error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ERR_STREAM_DESTROYED')) {
      socketClosed = true;
      clearAuthTimer();
      setHealthState('connection_error', 'Socket error (' + error.code + '). Waiting for disconnect/reconnect.', false, false);
      console.warn('⚠️ Socket error handled safely (' + error.code + '): ' + (error.message || 'connection closed'));
      return;
    }
    console.error('⚠️ Minecraft socket error:', error);
  }

  // EPIPE may be emitted by node-minecraft-protocol's underlying TCP socket,
  // not by Mineflayer's bot EventEmitter. Listen there directly so it cannot
  // become an unhandled Writable error.
  const minecraftClient = bot._client;
  if (minecraftClient && typeof minecraftClient.on === 'function') {
    minecraftClient.on('error', onSocketError);
  }
  if (minecraftClient && minecraftClient.socket && typeof minecraftClient.socket.on === 'function') {
    minecraftClient.socket.on('error', onSocketError);
  }

  function clearAuthTimer() {
    if (promptTimer) clearTimeout(promptTimer);
    promptTimer = null;
    scheduledAuthKind = null;
  }

  function blockAuthentication(reason) {
    if (authBlocked) return;
    authBlocked = true;
    clearAuthTimer();

    setHealthState('auth_error', reason, true, false);
    console.error('⛔ Automatic authentication stopped: ' + reason);
    console.error(
      'Fix the account/password or ask the server administrator to resolve the registration limit, then restart the bot.'
    );
  }

  function sendAuth(kind) {
    if (ended || authed || authBlocked || authCommandsSent.has(kind)) return;
    if (isSocketKnownClosed()) {
      console.warn('⚠️ Not sending /' + kind + ': the Minecraft connection is already closed.');
      clearAuthTimer();
      return;
    }

    const command = kind === 'register'
      ? (registerArgs === 1
          ? '/register ' + PASSWORD
          : '/register ' + PASSWORD + ' ' + PASSWORD)
      : '/login ' + PASSWORD;

    // Mark before writing so repeated server prompts cannot create a command
    // storm. Log before bot.chat as well, because a socket can fail before the
    // previous "Sent" message is flushed.
    authCommandsSent.add(kind);
    console.log('📤 Attempting /' + kind + ' (one attempt per connection).');

    try {
      bot.chat(command);
      console.log('✅ bot.chat() returned for /' + kind + '. Waiting for server response.');
    } catch (error) {
      console.error('⛔ bot.chat() failed for /' + kind + ':', error.code || '', error.message || error);
      socketClosed = true;
      clearAuthTimer();
    }
  }

  function schedulePromptAuth(kind) {
    if (ended || authed || authBlocked) return;
    if (authCommandsSent.has(kind)) {
      console.warn('⚠️ Server repeated the /' + kind + ' prompt, but that command was already attempted on this connection.');
      return;
    }

    clearAuthTimer();
    console.log('🔐 Authentication prompt detected; sending /' + kind + ' immediately.');
    sendAuth(kind);
  }

  function onAuthed() {
    if (authed || ended || authBlocked) return;

    authed = true;
    clearAuthTimer();
    setHealthState('online', 'Bot authenticated and ready.', true, true);
    console.log('✅ ' + config.botUsername + ' is authenticated and ready!');

    // Reset the reconnect delay after a successful authenticated connection.
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (bot.entity) startMovement();
  }

  bot.once('login', () => {
    setHealthState('waiting_auth', 'Connected; waiting for the server login/register prompt.', true, false);
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

    if (/login timeout exceeded|timed out.*login|try again/.test(text)) {
      blockAuthentication('the server timed out before accepting an authentication command.');
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
    if (error && (error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ERR_STREAM_DESTROYED')) {
      // Do not send more chat packets while the socket is closing. The end
      // event below owns reconnect scheduling.
      socketClosed = true;
      clearAuthTimer();
      setHealthState('connection_error', 'Socket closed (' + error.code + ').', false, false);
      console.warn('⚠️ Connection socket closed (' + error.code + ').');
      return;
    }

    console.error('⚠️ Bot error:', error);
  });

  bot.on('end', (reason) => {
    if (ended) return;
    ended = true;
    socketClosed = true;
    console.warn('🔌 Minecraft connection ended:', reason || 'socket closed');

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
      setHealthState('auth_error', 'Authentication blocked; manual account/password fix required.', false, false);
      console.error(
        '⛔ Not reconnecting because authentication is blocked. Resolve the server account/password issue and restart the app.'
      );
      return;
    }

    setHealthState('disconnected', 'Disconnected; reconnect scheduled.', false, false);
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
  setHealthState('needs_password', 'BOT_PASSWORD environment variable is missing.');
  console.error(
    '⛔ BOT_PASSWORD is not set. Add it in the hosting panel under Environment Variables, then restart.'
  );
  // Keep the HTTP health endpoint alive so the hosting panel can report the
  // configuration error instead of timing out on an unbound port.
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
