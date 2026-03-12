# Intent: src/index.ts

## What Changed
- Added `AUTO_REGISTER_DMS` and `GROUPS_DIR` to config imports
- Added `import { generateDmFolderName } from './auto-register.js'`
- Added `onUnregisteredDm` callback in `channelOpts` object (inside `main()`)

## Key Sections
- **Imports** (top of file): `AUTO_REGISTER_DMS`, `GROUPS_DIR` from config; `generateDmFolderName` from auto-register
- **channelOpts in main()**: New `onUnregisteredDm` property after `onChatMetadata`, before `registeredGroups`. The callback checks the `AUTO_REGISTER_DMS` flag, generates a folder name, calls `registerGroup()`, and copies `groups/global/CLAUDE.md` as initial memory.

## Invariants (must-keep)
- State management (lastTimestamp, sessions, registeredGroups, lastAgentTimestamp)
- loadState/saveState functions
- registerGroup function with folder validation
- getAvailableGroups function
- processGroupMessages trigger logic, cursor management, idle timer, error rollback with duplicate prevention
- runAgent task/group snapshot writes, session tracking, wrappedOnOutput
- startMessageLoop with dedup-by-group and piping logic
- recoverPendingMessages startup recovery
- main() with channel setup, scheduler, IPC watcher, queue
- ensureContainerSystemRunning using container-runtime abstraction
- Graceful shutdown with queue.shutdown
- All existing channelOpts properties (onMessage, onChatMetadata, registeredGroups)
