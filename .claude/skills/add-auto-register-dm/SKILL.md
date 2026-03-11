---
name: add-auto-register-dm
description: Auto-register DM users on first message for instant interaction
---

# Add Auto-Register DM Users

When an unknown user sends a DM to the agent's dedicated number/account, automatically create an isolated group registration so they can interact immediately — no manual setup needed. Each auto-registered user gets their own `groups/{folder}/` with a copy of `groups/global/CLAUDE.md`.

Only DMs are auto-registered. Group chats (`@g.us`) and the bot's own outbound messages are never auto-registered.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `add-auto-register-dm` is in `applied_skills`, skip to Phase 3 (Verify). The code changes are already in place.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-auto-register-dm
```

This deterministically:
- Adds `src/auto-register.ts` (pure function for generating DM folder names with collision handling)
- Adds `src/auto-register.test.ts` (unit tests for folder name generation)
- Modifies `src/types.ts` — adds `OnUnregisteredDm` callback type
- Modifies `src/channels/registry.ts` — adds `onUnregisteredDm` to `ChannelOpts` interface
- Modifies `src/config.ts` — adds `AUTO_REGISTER_DMS` env var (defaults to `false`)
- Modifies `src/index.ts` — adds `onUnregisteredDm` callback in `channelOpts` that handles registration, folder creation, and CLAUDE.md copy
- Records the application in `.nanoclaw/state.yaml`

If merge conflicts occur in `src/index.ts`, read `modify/src/index.ts.intent.md` for guidance. The changes are in the imports and in the `channelOpts` object inside `main()`.

### Configure

Add to `.env`:

```
AUTO_REGISTER_DMS=true
```

### Validate

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Verify

### Build and restart

```bash
npm run build
```

Linux:
```bash
systemctl --user restart nanoclaw
```

macOS:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Test auto-registration

1. Ensure `AUTO_REGISTER_DMS=true` is set in `.env`
2. Send a DM from an unregistered number
3. Check that a new folder was created:

```bash
ls groups/
```

4. Verify the agent responds to the message
5. Send from a second unregistered number — verify separate folder
6. Send from a group chat — verify it is NOT auto-registered (existing behavior)

### Test with feature disabled

1. Set `AUTO_REGISTER_DMS=false` in `.env` (or remove the line)
2. Restart the service
3. Send a DM from a new unregistered number — verify it is silently dropped

## Channel Integration

This skill adds the `onUnregisteredDm` callback to `ChannelOpts`, but channels must explicitly call it to trigger auto-registration. If you are using the WhatsApp channel (`add-whatsapp` skill), the WhatsApp skill template already includes the `onUnregisteredDm` hook. For other channels, you may need to add the hook manually in the channel's message handler before the registration gate check.

## What This Does NOT Do

- No rate limiting or abuse prevention
- No welcome messages to new users
- No admin controls or user management UI
- No sender-allowlist integration (orthogonal, already exists)
- No group chat auto-registration (DMs only)

## Troubleshooting

### DMs not being auto-registered

- Verify `AUTO_REGISTER_DMS=true` is set in `.env`
- Check logs for `Auto-registering DM user` or `Could not generate valid folder`
- Ensure the channel calls `opts.onUnregisteredDm()` before the registration gate

### Folder name collisions

- If two contacts share the same sanitized name, the second gets a `-2` suffix
- Names that sanitize to empty (e.g., all emoji) fall back to a JID-derived slug like `wa-1234567890`

### Global CLAUDE.md not copied

- Ensure `groups/global/CLAUDE.md` exists — it's used as the template for new users
- Check logs for `Failed to copy global CLAUDE.md` — may indicate permission issues
