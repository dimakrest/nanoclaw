# Intent: Add LINE channel import

Add `import './line.js';` to the channel barrel file so the LINE
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
