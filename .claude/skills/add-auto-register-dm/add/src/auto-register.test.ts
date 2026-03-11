import { describe, expect, it } from 'vitest';

import { generateDmFolderName } from './auto-register.js';

describe('generateDmFolderName', () => {
  it('uses contact name when available', () => {
    expect(
      generateDmFolderName('1234@s.whatsapp.net', new Set(), 'Alice'),
    ).toBe('alice');
  });

  it('sanitizes special characters in contact name', () => {
    const result = generateDmFolderName(
      '1234@s.whatsapp.net',
      new Set(),
      'José María',
    );
    expect(result).toBe('jos-mar-a');
  });

  it('falls back to JID when no contact name', () => {
    expect(generateDmFolderName('1234567890@s.whatsapp.net', new Set())).toBe(
      'wa-1234567890',
    );
  });

  it('falls back to JID when contact name sanitizes to empty', () => {
    const result = generateDmFolderName(
      '1234567890@s.whatsapp.net',
      new Set(),
      '🎉🎊',
    );
    expect(result).toBe('wa-1234567890');
  });

  it('handles collision by appending -2', () => {
    expect(
      generateDmFolderName('1234@s.whatsapp.net', new Set(['alice']), 'Alice'),
    ).toBe('alice-2');
  });

  it('handles multiple collisions', () => {
    expect(
      generateDmFolderName(
        '1234@s.whatsapp.net',
        new Set(['alice', 'alice-2']),
        'Alice',
      ),
    ).toBe('alice-3');
  });

  it('returns null for reserved name "global"', () => {
    expect(
      generateDmFolderName('1234@s.whatsapp.net', new Set(), 'Global'),
    ).toBeNull();
  });

  it('truncates very long push names', () => {
    const longName = 'a'.repeat(100);
    const result = generateDmFolderName(
      '1234@s.whatsapp.net',
      new Set(),
      longName,
    );
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(64);
  });

  it('handles empty string contact name', () => {
    expect(
      generateDmFolderName('1234567890@s.whatsapp.net', new Set(), ''),
    ).toBe('wa-1234567890');
  });

  it('handles JID without @ sign', () => {
    const result = generateDmFolderName('someid', new Set());
    expect(result).toBe('dm-someid');
  });
});
