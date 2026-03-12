import { isValidGroupFolder } from './group-folder.js';

/**
 * Generate a valid group folder name from a DM JID and optional contact name.
 * Prefers the contact's push name, falls back to a JID-derived slug.
 * Handles collisions by appending -2, -3, etc.
 * Returns null if no valid folder name can be generated.
 */
export function generateDmFolderName(
  chatJid: string,
  usedFolders: Set<string>,
  contactName?: string,
): string | null {
  let base: string | undefined;
  if (contactName) {
    base =
      contactName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || undefined;
  }

  if (!base) {
    const atIdx = chatJid.indexOf('@');
    if (atIdx !== -1) {
      base = `wa-${chatJid.slice(0, atIdx)}`;
    } else {
      base = `dm-${chatJid.slice(0, 20)}`;
    }
  }

  if (!/^[A-Za-z0-9]/.test(base)) base = `dm-${base}`;
  base = base.slice(0, 60);

  let candidate = base;
  let counter = 2;
  while (usedFolders.has(candidate)) {
    if (counter > 1000) return null;
    candidate = `${base}-${counter}`;
    counter++;
  }

  if (!isValidGroupFolder(candidate)) return null;

  return candidate;
}
