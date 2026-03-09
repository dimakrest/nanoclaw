import { describe, expect, it, beforeEach } from 'vitest';

import { generateDmFolderName, _setRegisteredGroups } from './index.js';

describe('generateDmFolderName', () => {
  beforeEach(() => {
    _setRegisteredGroups({});
  });

  it('uses contact name when available', () => {
    expect(generateDmFolderName('1234@s.whatsapp.net', 'Alice')).toBe('alice');
  });

  it('sanitizes special characters in contact name', () => {
    const result = generateDmFolderName('1234@s.whatsapp.net', 'José María');
    expect(result).toBe('jos-mar-a');
  });

  it('falls back to JID when no contact name', () => {
    expect(generateDmFolderName('1234567890@s.whatsapp.net')).toBe(
      'wa-1234567890',
    );
  });

  it('falls back to JID when contact name sanitizes to empty', () => {
    const result = generateDmFolderName('1234567890@s.whatsapp.net', '🎉🎊');
    expect(result).toBe('wa-1234567890');
  });

  it('handles collision by appending -2', () => {
    _setRegisteredGroups({
      'other@s.whatsapp.net': {
        name: 'Alice',
        folder: 'alice',
        trigger: '',
        added_at: '',
      },
    });
    expect(generateDmFolderName('1234@s.whatsapp.net', 'Alice')).toBe(
      'alice-2',
    );
  });

  it('handles multiple collisions', () => {
    _setRegisteredGroups({
      'a@s.whatsapp.net': {
        name: 'Alice',
        folder: 'alice',
        trigger: '',
        added_at: '',
      },
      'b@s.whatsapp.net': {
        name: 'Alice 2',
        folder: 'alice-2',
        trigger: '',
        added_at: '',
      },
    });
    expect(generateDmFolderName('1234@s.whatsapp.net', 'Alice')).toBe(
      'alice-3',
    );
  });

  it('returns null for reserved name "global"', () => {
    // "global" is reserved — but generateDmFolderName sanitizes names,
    // so "Global" -> "global" which is caught by isValidGroupFolder
    expect(generateDmFolderName('1234@s.whatsapp.net', 'Global')).toBeNull();
  });

  it('truncates very long push names', () => {
    const longName = 'a'.repeat(100);
    const result = generateDmFolderName('1234@s.whatsapp.net', longName);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(64);
  });

  it('handles empty string contact name', () => {
    expect(generateDmFolderName('1234567890@s.whatsapp.net', '')).toBe(
      'wa-1234567890',
    );
  });

  it('handles JID without @ sign', () => {
    const result = generateDmFolderName('someid');
    expect(result).toBe('dm-someid');
  });
});
