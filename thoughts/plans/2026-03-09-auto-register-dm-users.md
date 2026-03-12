# Auto-Register DM Users — Implementation Plan

## Overview

When an unknown user sends a DM to the agent's dedicated number/account, automatically create an isolated group registration so they can interact immediately — no manual setup needed.

## Current State Analysis

Messages flow: **Channel SDK event → Channel handler → `registeredGroups()` gate → `onMessage()` → SQLite → poll loop → agent container**.

The gate at the channel layer (`whatsapp.ts:173-174`) silently drops messages from unregistered JIDs. `onChatMetadata` is still called for all messages (including unregistered), so the orchestrator knows about the JID — it just never stores the message content.

### Key Discoveries:
- `registerGroup()` (`src/index.ts:93-115`) already handles validation, DB persistence, and folder creation
- `registeredGroups` is a live getter (`src/index.ts:519`), so a mid-flow registration is immediately visible to all channels
- `onChatMetadata` is called before the registration gate — it receives `name`, `channel`, and `isGroup` params (`src/types.ts:101-107`)
- WhatsApp DMs end in `@s.whatsapp.net`
- The `isValidGroupFolder` regex is `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (`src/group-folder.ts:5`)
- No `CLAUDE.md` copy logic exists today — the global file is mounted read-only at `/workspace/global/` inside containers, and per-group `CLAUDE.md` is written manually

## Desired End State

1. Set `AUTO_REGISTER_DMS=true` in `.env`
2. Unknown user sends a DM → orchestrator auto-registers them with an isolated group folder
3. The triggering message is stored and processed normally
4. Each auto-registered user gets their own `groups/{folder}/` with a copy of `groups/global/CLAUDE.md`
5. Group chats (`@g.us`) are never auto-registered

### Verification:
- Send a DM from an unregistered number → response received, `groups/{folder}/` created
- Send from a second unregistered number → separate folder, no data shared
- Send from a group → silently dropped (existing behavior)
- With `AUTO_REGISTER_DMS=false` (default) → no behavior change

## What We're NOT Doing

- Rate limiting / abuse prevention
- Welcome messages to new users
- Admin controls / user management UI
- Sender-allowlist integration (orthogonal, already exists)
- Modifying `groups/global/CLAUDE.md` content

## Implementation Approach

Add a new `ChannelOpts` callback `onUnregisteredDm` that channels call when they encounter an unknown DM JID. The orchestrator implements this callback to auto-register the user (when enabled). The callback only handles registration — it does NOT store the message. Instead, if registration succeeds, `registeredGroups` is updated synchronously, so the channel's existing gate check (`if (groups[chatJid])`) passes on a re-check, and the message flows through the normal `onMessage` path. This avoids duplicating message construction logic across two code paths and keeps a single entry point for message storage.

---

## Phase 1: Config

### Overview
Add the `AUTO_REGISTER_DMS` env var.

### Changes Required:

#### 1. `src/config.ts`
**Changes**: Read `AUTO_REGISTER_DMS` from `.env` via `readEnvFile`, export as boolean.

```typescript
// Add 'AUTO_REGISTER_DMS' to the readEnvFile keys array (line 9)
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'AUTO_REGISTER_DMS']);

// Add export after ASSISTANT_HAS_OWN_NUMBER (after line 15)
export const AUTO_REGISTER_DMS =
  (process.env.AUTO_REGISTER_DMS || envConfig.AUTO_REGISTER_DMS) === 'true';
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles without errors
- [x] `AUTO_REGISTER_DMS` defaults to `false` when not set

---

## Phase 2: Types & ChannelOpts

### Overview
Add the `onUnregisteredDm` callback type and extend `ChannelOpts`.

### Changes Required:

#### 1. `src/types.ts`
**Changes**: Add callback type for unregistered DM notification.

```typescript
// After OnChatMetadata (after line 107), add:

/**
 * Callback for channels to report a DM from an unregistered JID.
 * The orchestrator decides whether to auto-register.
 * Only handles registration — does NOT store the message.
 * If it returns true, the channel should re-check registeredGroups()
 * and deliver the message via the normal onMessage path.
 */
export type OnUnregisteredDm = (
  chatJid: string,
  meta: { name?: string; channel?: string },
) => boolean;
```

#### 2. `src/channels/registry.ts`
**Changes**: Add `onUnregisteredDm` to `ChannelOpts`.

```typescript
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onUnregisteredDm: OnUnregisteredDm;
  registeredGroups: () => Record<string, RegisteredGroup>;
}
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles without errors

---

## Phase 3: Orchestrator Auto-Registration Logic

### Overview
Implement the `onUnregisteredDm` callback in the orchestrator, with folder naming and `CLAUDE.md` copy.

### Changes Required:

#### 1. `src/index.ts`
**Changes**: Implement `onUnregisteredDm` in `channelOpts` and add a helper for folder name generation.

```typescript
// Add import at top
import { AUTO_REGISTER_DMS, GROUPS_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';

// Add helper function (before channelOpts, e.g. after registerGroup):

/**
 * Generate a valid group folder name from a DM JID and optional contact name.
 * Prefers the contact's push name, falls back to a JID-derived slug.
 * Handles collisions by appending -2, -3, etc.
 * Returns null if no valid folder name can be generated.
 */
function generateDmFolderName(chatJid: string, contactName?: string): string | null {
  const usedFolders = new Set(
    Object.values(registeredGroups).map((g) => g.folder),
  );

  let base: string | undefined;
  if (contactName) {
    // Sanitize: lowercase, replace non-alphanumeric with hyphens, trim
    base = contactName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || undefined;
  }

  // Fallback if name is empty or sanitized to nothing
  if (!base) {
    // Extract identifier from JID: "1234567890@s.whatsapp.net" -> "wa-1234567890"
    const atIdx = chatJid.indexOf('@');
    if (atIdx !== -1) {
      base = `wa-${chatJid.slice(0, atIdx)}`;
    } else {
      base = `dm-${chatJid.slice(0, 20)}`;
    }
  }

  // Ensure valid: must start with alphanumeric, max 64 chars
  if (!/^[A-Za-z0-9]/.test(base)) base = `dm-${base}`;
  base = base.slice(0, 60); // leave room for collision suffix

  let candidate = base;
  let counter = 2;
  while (usedFolders.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter++;
  }

  // Final validation — if the candidate is somehow invalid, bail
  if (!isValidGroupFolder(candidate)) return null;

  return candidate;
}

// In channelOpts (around line 492), add onUnregisteredDm:
const channelOpts = {
  onMessage: (chatJid: string, msg: NewMessage) => {
    // ... existing code ...
  },
  onChatMetadata: (...) => { ... },

  onUnregisteredDm: (
    chatJid: string,
    meta: { name?: string; channel?: string },
  ): boolean => {
    if (!AUTO_REGISTER_DMS) return false;

    const folder = generateDmFolderName(chatJid, meta.name);
    if (!folder) {
      logger.warn({ chatJid, name: meta.name }, 'Could not generate valid folder for DM user');
      return false;
    }

    const displayName = meta.name || folder;

    logger.info(
      { chatJid, folder, name: displayName },
      'Auto-registering DM user',
    );

    registerGroup(chatJid, {
      name: displayName,
      folder,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false, // DMs don't need @trigger
    });

    // Copy global CLAUDE.md as the initial per-user memory
    const globalClaudeMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
    const userClaudeMd = path.join(GROUPS_DIR, folder, 'CLAUDE.md');
    try {
      if (fs.existsSync(globalClaudeMd) && !fs.existsSync(userClaudeMd)) {
        fs.copyFileSync(globalClaudeMd, userClaudeMd);
      }
    } catch (err) {
      logger.warn({ err, folder }, 'Failed to copy global CLAUDE.md template');
    }

    return true;
  },

  registeredGroups: () => registeredGroups,
};
```

### Design Decisions:

1. **`requiresTrigger: false`** — DM users shouldn't need `@Bot` prefix to interact. The whole point is natural conversation.
2. **Copy `CLAUDE.md` rather than relying on mount** — The global dir is mounted read-only at `/workspace/global/` anyway, but per-group `CLAUDE.md` at `/workspace/group/CLAUDE.md` is what the agent actually reads for persona. Without a copy, the agent has no per-group memory file.
3. **`onUnregisteredDm` only handles registration, not message storage** — If it returns `true`, `registeredGroups` is updated synchronously, so the channel re-checks the gate and delivers the message via the normal `onMessage` path. This avoids duplicating message construction logic.
4. **`generateDmFolderName` returns `null` on invalid output** — The caller skips registration rather than creating an orphaned message. The `isValidGroupFolder` check catches edge cases the sanitizer might miss.
5. **Folder naming prefers contact name** — More human-readable. Collision handling with `-2`, `-3` suffix. Reserved names (like `global`) are caught by `isValidGroupFolder`.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles without errors
- [x] Linting passes

#### Manual Verification:
- [ ] With `AUTO_REGISTER_DMS=true`, sending a DM from unknown number creates `groups/{folder}/` with `CLAUDE.md` and `logs/`
- [ ] With `AUTO_REGISTER_DMS=false`, behavior is unchanged (message dropped)

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding to the next phase.

---

## Phase 4: Channel Integration

### Overview
Modify channels to call `onUnregisteredDm` instead of silently dropping unregistered DM messages.

### Changes Required:

#### 1. WhatsApp channel (skill files)
**Changes**: Before the existing gate, try auto-registration for unregistered DMs. If registration succeeds, `registeredGroups()` is updated synchronously, so the existing gate check passes and the message flows through the normal path — no duplicate message construction needed.

The WhatsApp gate is at `whatsapp.ts:203-204`. Note: `fromMe` messages are skipped to prevent the bot's own outbound messages from triggering auto-registration.

Current code:
```typescript
// Only deliver full message for registered groups
const groups = this.opts.registeredGroups();
if (groups[chatJid]) {
  // ... deliver message ...
}
```

New code:
```typescript
// Auto-register unknown DMs (not groups, not fromMe)
let groups = this.opts.registeredGroups();
if (!groups[chatJid] && !isGroup && !msg.key.fromMe) {
  this.opts.onUnregisteredDm(chatJid, { name: msg.pushName, channel: 'whatsapp' });
  groups = this.opts.registeredGroups(); // re-read after potential registration
}

// Only deliver full message for registered groups
if (groups[chatJid]) {
  // ... deliver message (existing code unchanged) ...
}
```

**Files to update** (all copies of the WhatsApp channel that exist in this repo):
- `.claude/skills/add-whatsapp/add/src/channels/whatsapp.ts`
- `.claude/skills/add-voice-transcription/modify/src/channels/whatsapp.ts`

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles without errors
- [x] `npm run build` succeeds

#### Manual Verification:
- [ ] WhatsApp DM from unknown user → auto-registered, message delivered
- [ ] Group message from unknown group → still silently dropped
- [ ] Second message from same user → goes through normal registered path
- [ ] Two different unknown users → two separate folders created

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding to the next phase.

---

## Phase 5: Tests

### Overview
Unit tests for folder name generation and the auto-registration flow.

### Changes Required:

#### 1. New test file: `src/auto-register.test.ts`

Test cases for `generateDmFolderName`:
- Contact name "Alice" → folder `alice`
- Contact name with special chars "José María" → folder `jos-mar-a` (sanitized, non-ASCII chars dropped)
- No contact name, WhatsApp JID `1234567890@s.whatsapp.net` → folder `wa-1234567890`
- Collision: existing folder `alice` → new folder `alice-2`
- Empty contact name → fallback to JID-derived
- All-emoji contact name (e.g. "🎉🎊") → sanitizes to empty, falls back to JID-derived
- Reserved name `global` → returns `null` (caught by `isValidGroupFolder`)
- Very long push name (>64 chars) → truncated to valid folder length
- Same JID arriving twice in rapid succession → second call sees first registration, no duplicate

Test cases for auto-registration flow:
- `AUTO_REGISTER_DMS=false` → `onUnregisteredDm` returns `false`, no registration
- `AUTO_REGISTER_DMS=true` + DM JID → registers group, returns `true`
- `generateDmFolderName` returns `null` → `onUnregisteredDm` returns `false`, no registration
- Verify `registerGroup` is called with `requiresTrigger: false`
- Verify `CLAUDE.md` is copied from global
- Verify message flows through normal `onMessage` path after registration (not stored by callback)

### Success Criteria:

#### Automated Verification:
- [x] All tests pass
- [x] No regressions in existing tests

---

## Testing Strategy

### Unit Tests:
- `generateDmFolderName` — name sanitization, fallbacks, collisions
- `onUnregisteredDm` callback — registration flow, config gating

### Integration Tests (Manual):
1. Start NanoClaw with `AUTO_REGISTER_DMS=true`
2. Send a DM from an unregistered WhatsApp number → verify folder created, agent responds
3. Send a DM from a second number → verify separate folder
4. Send from a group → verify not auto-registered
5. Restart NanoClaw → verify auto-registered users persist (loaded from DB)
6. Set `AUTO_REGISTER_DMS=false`, send from new number → verify dropped

### Edge Cases:
- User sends a DM, then gets manually registered with a different folder → existing registration should win (no re-register)
- Very long push name (>64 chars) → truncated to valid folder length
- Push name that sanitizes to empty string → falls back to JID
- First message is a voice note (voice-transcription installs) → auto-registration still triggers (the `onUnregisteredDm` call is before content extraction), voice message is then transcribed and delivered via the normal path
- Bot's own outbound `fromMe` messages to a new JID → skipped, do not trigger auto-registration

## References

- Original ticket: `thoughts/tickets/auto-register-dm-users.md`
- Channel registry: `src/channels/registry.ts`
- Group folder validation: `src/group-folder.ts`
- Orchestrator: `src/index.ts:93-115` (registerGroup), `src/index.ts:492-520` (channelOpts)
