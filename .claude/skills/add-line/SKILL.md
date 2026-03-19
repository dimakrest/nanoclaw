---
name: add-line
description: Add LINE as a channel. Can replace other channels entirely or run alongside them. Supports QR code and email/password authentication.
---

# Add LINE Channel

This skill adds LINE support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `line` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: How do you want to authenticate with LINE? QR code (scan with your phone) or email/password?

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-line
```

This deterministically:
- Adds `src/channels/line.ts` (LINEChannel class with self-registration via `registerChannel`)
- Adds `src/channels/line.test.ts` (46 unit tests)
- Appends `import './line.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `@evex/linejs`, `qrcode-terminal`, `@types/qrcode-terminal`, and `undici` npm dependencies
- Updates `.env.example` with `LINE_EMAIL`, `LINE_PASSWORD`, `LINE_QR`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new LINE tests) and build must be clean before proceeding.

## Phase 3: Setup

### Configure environment

Based on the user's chosen auth method:

**QR code authentication** (recommended for first-time setup):

Add to `.env`:
```bash
LINE_QR=true
```

**Email/password authentication**:

Add to `.env`:
```bash
LINE_EMAIL=<their-email>
LINE_PASSWORD=<their-password>
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### First-time QR login

If using QR auth, the first startup requires scanning a QR code:

1. Run `npm run dev` (not as a background service)
2. A QR code will appear in the terminal
3. On your phone: LINE app → Me → Settings → Devices → Scan QR code
4. Enter the pincode shown in the terminal on your phone
5. Once connected, the session is saved and future restarts will resume automatically

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Open a LINE chat (group or DM) where you want the bot to respond
> 2. Send `!chatid` — the bot will reply with the chat ID
> 3. The format is `ln:<MID>` (e.g., `ln:C1234567890abcdef`)

Wait for the user to provide the chat ID.

### Register the chat

Use the IPC register flow or register directly. The chat ID, name, and folder name are needed.

For a main chat (responds to all messages):

```typescript
registerGroup("ln:<chat-id>", {
  name: "<chat-name>",
  folder: "line_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("ln:<chat-id>", {
  name: "<chat-name>",
  folder: "line_<group-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered LINE chat:
> - For main chat: Any message works
> - For non-main: @mention the bot or use the trigger pattern
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Session expired / QR timeout

LINE sessions expire periodically. If the bot fails to connect:
1. Delete `data/line/session.json`
2. Set `LINE_QR=true` in `.env`
3. Restart with `npm run dev` and scan the QR code again
4. The new session will be saved for future restarts

### Bot not responding

Check:
1. `LINE_QR=true` or `LINE_EMAIL`/`LINE_PASSWORD` are set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite (check with: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'ln:%'"`)
3. For non-main chats: message includes trigger pattern
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### HTTP/2 issues

LINE's push stream requires HTTP/2. The channel uses undici with `allowH2: true` to handle this. If you see connection errors:
1. Ensure `undici` is installed: `npm ls undici`
2. Check Node.js version (18+ required for HTTP/2 support in undici)

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove LINE integration:

1. Delete `src/channels/line.ts` and `src/channels/line.test.ts`
2. Remove `import './line.js'` from `src/channels/index.ts`
3. Remove `LINE_EMAIL`, `LINE_PASSWORD`, `LINE_QR` from `.env`
4. Remove LINE registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'ln:%'"`
5. Remove session data: `rm -rf data/line/`
6. Uninstall: `npm uninstall @evex/linejs qrcode-terminal @types/qrcode-terminal`
7. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
