<!-- Last updated: 2026-10-11 -->
# 🤖 Minecraft AFK Bot (Mineflayer-Based)

This is a lightweight Minecraft Java AFK bot powered by [Mineflayer](https://github.com/PrismarineJS/mineflayer). It connects to a Java server, performs basic movement to help avoid AFK detection, and can be customized using `config.json`.

## ⚠️ Before you begin

- Make sure you are allowed to connect a bot to the server.
- For offline/cracked servers, configure the server accordingly.
- If the server uses an authentication plugin (for example, AuthMe), configure the bot account and password correctly.
- The bot intentionally stops automatic authentication retries when the server reports a password error or registration limit. Client code cannot legitimately bypass a server-side registration limit.

## ✨ Features

- Connect to Minecraft Java servers (IP + port)
- Customize the bot username
- Configure view distance / chunk usage
- Move forward and backward, jump, and sneak to reduce AFK detection
- Reconnect after ordinary network disconnects, with a single reconnect timer
- Authenticate only in response to the server's login/register prompt, without blind repeated registration attempts

## ⚡ Installation

Clone the repository and install its dependencies:

```bash
npm install
```

## ⚙️ Configure `config.json`

Example:

```json
{
  "serverHost": "yourserver.aternos.me",
  "serverPort": 25565,
  "botUsername": "MyBotName",
  "botChunk": 4,
  "reconnectDelay": 30000
}
```

`serverHost` and `serverPort` must match the current server address and port. `reconnectDelay` is measured in milliseconds; reconnects use at least 30 seconds to avoid rapid join attempts.

### Set the bot password securely

`bot.js` reads the password from the `BOT_PASSWORD` environment variable. This is the recommended method on hosting services such as Hyehost:

1. Open your app's hosting panel.
2. Find **Environment Variables** / **Secrets**.
3. Add `BOT_PASSWORD` with the password for the configured Minecraft account.
4. Save and restart the app.

Do not commit your real password to `config.json` or post it in public logs. For local testing only, the legacy `botPassword` property is still supported, but an environment variable takes precedence.

## 🤖 Start the bot

```bash
npm start
```

The console should show that the bot is connecting and then waiting for the server's authentication prompt. Movement starts only after authentication is confirmed.

## 🔐 Authentication troubleshooting

- **“This user isn't registered!”** — the account does not appear to exist in the server's authentication plugin. The bot can respond to a registration prompt once.
- **“You have exceeded the maximum number of registrations”** — the server has reached its account-registration quota for the connection/IP. Stop the bot and ask the server administrator to check the account or registration policy; restarting repeatedly will not fix this limit.
- **“Incorrect password”** — check the `BOT_PASSWORD` value and account name.
- **“Login timeout exceeded”** — check that the credentials and registration state are valid and that the server is replying to the bot. Avoid running multiple copies of the bot at the same time.
- **“EPIPE” / socket closed** — indicates a write to a closed connection. The bot stops auth sends on disconnect and reconnects once after a delay for ordinary network failures.

## Notes

- Offline-mode servers may not provide premium account skins.
- Anti-AFK movement may be restricted by server rules or plugins.
- The bot does not bypass authentication or server-side account limits.

## License

MIT License.
