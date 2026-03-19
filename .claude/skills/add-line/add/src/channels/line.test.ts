import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('undici', () => ({
  Agent: vi.fn(),
  setGlobalDispatcher: vi.fn(),
  fetch: vi.fn(),
  Request: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const {
  mockReply,
  mockSendMessage,
  mockGetChat,
  mockGetUser,
  mockListen,
  mockOn,
  mockBaseOn,
  mockTalkSendMessage,
} = vi.hoisted(() => {
  const mockReply = vi.fn().mockResolvedValue(undefined);
  const mockSendMessage = vi.fn().mockResolvedValue(undefined);
  const mockGetUser = vi.fn().mockResolvedValue({
    raw: { targetProfileDetail: { profileName: 'TestUser' } },
  });
  const mockGetChat = vi.fn().mockResolvedValue({ sendMessage: mockSendMessage });
  const mockListen = vi.fn();
  const mockOn = vi.fn();
  const mockBaseOn = vi.fn();
  const mockTalkSendMessage = vi.fn().mockResolvedValue(undefined);
  return { mockReply, mockSendMessage, mockGetChat, mockGetUser, mockListen, mockOn, mockBaseOn, mockTalkSendMessage };
});

vi.mock('@evex/linejs', () => {
  const mockClient = {
    listen: mockListen,
    on: mockOn,
    getUser: mockGetUser,
    getChat: mockGetChat,
    base: { on: mockBaseOn, talk: { sendMessage: mockTalkSendMessage } },
  };
  return {
    Client: vi.fn().mockImplementation(() => mockClient),
    loginWithPassword: vi.fn().mockResolvedValue(mockClient),
    loginWithQR: vi.fn().mockResolvedValue(mockClient),
  };
});

vi.mock('@evex/linejs/base', () => ({
  BaseClient: vi.fn().mockImplementation(() => ({
    auth: { tryRefreshToken: vi.fn().mockResolvedValue(undefined) },
    loginProcess: { ready: vi.fn().mockResolvedValue(undefined) },
  })),
}));

vi.mock('@evex/linejs/storage', () => ({
  FileStorage: vi.fn().mockImplementation(function () {
    return { get: vi.fn().mockResolvedValue(undefined), set: vi.fn() };
  }),
}));

import { LINEChannel, LINEChannelOpts } from './line.js';
import { loginWithPassword } from '@evex/linejs';
import { ASSISTANT_NAME } from '../config.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<LINEChannelOpts>): LINEChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'ln:GROUP123': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createChannel(overrides?: Partial<LINEChannelOpts>): LINEChannel {
  return new LINEChannel(
    { method: 'password', email: 'test@example.com', password: 'test-password' },
    createTestOpts(overrides),
  );
}

/**
 * Simulate an incoming TalkMessage by capturing and calling the
 * handler registered via mockOn('message', handler).
 */
async function simulateMessage(msg: object): Promise<void> {
  const call = mockOn.mock.calls.find((c) => c[0] === 'message');
  if (!call) throw new Error('No message handler registered');
  const handler = call[1] as (msg: object) => Promise<void>;
  await handler(msg);
}

function buildTextMessage(overrides: {
  toType?: string | number;
  toId?: string;
  fromId?: string;
  text?: string;
  msgId?: string;
  isMyMessage?: boolean;
  createdTime?: number;
} = {}) {
  const toType = overrides.toType ?? 'USER';
  const toId = overrides.toId ?? 'U123';
  const fromId = overrides.fromId ?? 'U123';
  return {
    isMyMessage: overrides.isMyMessage ?? false,
    to: { type: toType, id: toId },
    from: { type: 'USER', id: fromId },
    text: overrides.text ?? 'Hello',
    reply: mockReply,
    raw: {
      id: overrides.msgId ?? 'msg-001',
      contentType: 'NONE',
      createdTime: overrides.createdTime ?? Date.now(),
    },
  };
}

function buildNonTextMessage(contentType: string, overrides: {
  toType?: string | number;
  toId?: string;
  fromId?: string;
} = {}) {
  return {
    isMyMessage: false,
    to: { type: overrides.toType ?? 'GROUP', id: overrides.toId ?? 'GROUP123' },
    from: { type: 'USER', id: overrides.fromId ?? 'U123' },
    text: '',
    reply: mockReply,
    raw: {
      id: 'msg-nt-001',
      contentType,
      createdTime: Date.now(),
    },
  };
}

// --- Tests ---

describe('LINEChannel', () => {
  beforeEach(() => {
    vi.mocked(mockOn).mockClear();
    vi.mocked(mockListen).mockClear();
    vi.mocked(mockBaseOn).mockClear();
    vi.mocked(mockGetUser).mockClear();
    vi.mocked(mockGetChat).mockClear();
    vi.mocked(mockSendMessage).mockClear();
    vi.mocked(mockTalkSendMessage).mockClear();
    vi.mocked(mockReply).mockClear();
    vi.mocked(loginWithPassword).mockClear();
    // Reset to default resolved values
    vi.mocked(mockGetUser).mockResolvedValue({
      raw: { targetProfileDetail: { profileName: 'TestUser' } },
    });
    vi.mocked(mockGetChat).mockResolvedValue({ sendMessage: mockSendMessage });
    vi.mocked(mockSendMessage).mockResolvedValue(undefined);
    vi.mocked(mockTalkSendMessage).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "line"', () => {
      expect(createChannel().name).toBe('line');
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('isConnected() returns false before connect()', () => {
      expect(createChannel().isConnected()).toBe(false);
    });

    it('connect() calls loginWithPassword with email and password', async () => {
      const channel = createChannel();
      await channel.connect();
      expect(loginWithPassword).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'test@example.com', password: 'test-password' }),
        expect.objectContaining({ device: 'DESKTOPWIN' }),
      );
    });

    it('connect() calls client.listen({ talk: true })', async () => {
      const channel = createChannel();
      await channel.connect();
      expect(mockListen).toHaveBeenCalledWith(
        expect.objectContaining({ talk: true }),
      );
    });

    it('isConnected() returns true after connect()', async () => {
      const channel = createChannel();
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('disconnect() aborts listen signal and nulls client', async () => {
      const channel = createChannel();
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false after disconnect()', async () => {
      const channel = createChannel();
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Message routing ---

  describe('message routing', () => {
    it('group message → chatJid = ln:{msg.to.id}, isGroup = true', async () => {
      const opts = createTestOpts();
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        toType: 'GROUP',
        toId: 'GROUP123',
        fromId: 'U123',
        text: 'hello',
      }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'ln:GROUP123',
        expect.any(String),
        'ln:GROUP123',
        'line',
        true,
      );
    });

    it('DM message → chatJid = ln:{msg.from.id}, isGroup = false', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'ln:U123': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        toType: 'USER',
        toId: 'MYSELF',
        fromId: 'U123',
        text: 'hello',
      }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'ln:U123',
        expect.any(String),
        'TestUser',
        'line',
        false,
      );
    });

    it('msg.isMyMessage = true → message stored with is_from_me: true', async () => {
      const opts = createTestOpts();
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        isMyMessage: true,
        toType: 'GROUP',
        toId: 'GROUP123',
        fromId: 'U_SELF',
        text: 'hello from phone',
      }));

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'ln:GROUP123',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: false,
          content: 'hello from phone',
          sender_name: ASSISTANT_NAME,
        }),
      );
    });

    it('msg.isMyMessage = true with bot prefix → is_bot_message: true', async () => {
      const opts = createTestOpts();
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        isMyMessage: true,
        toType: 'GROUP',
        toId: 'GROUP123',
        fromId: 'U_SELF',
        text: `${ASSISTANT_NAME}: I can help with that`,
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'ln:GROUP123',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });

    it('msg.isMyMessage = true skips getDisplayName (uses ASSISTANT_NAME)', async () => {
      const opts = createTestOpts();
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        isMyMessage: true,
        toType: 'GROUP',
        toId: 'GROUP123',
        fromId: 'U_SELF',
        text: 'hello',
      }));

      expect(mockGetUser).not.toHaveBeenCalled();
    });

    it('onChatMetadata called with all 5 params on every message', async () => {
      const opts = createTestOpts();
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        toType: 'GROUP',
        toId: 'GROUP123',
        fromId: 'U123',
        text: 'hello',
      }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'ln:GROUP123',
        expect.any(String),
        expect.any(String),
        'line',
        expect.any(Boolean),
      );
    });

    it('numeric toType 2 (GROUP) is treated as group', async () => {
      const opts = createTestOpts();
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        toType: 2, // numeric GROUP
        toId: 'GROUP123',
        fromId: 'U123',
        text: 'hello',
      }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'ln:GROUP123',
        expect.any(String),
        'ln:GROUP123',
        'line',
        true,
      );
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message to registered group', async () => {
      const opts = createTestOpts();
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        toType: 'GROUP',
        toId: 'GROUP123',
        fromId: 'U123',
        text: 'Hello Andy',
        msgId: 'msg-001',
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'ln:GROUP123',
        expect.objectContaining({
          chat_jid: 'ln:GROUP123',
          content: 'Hello Andy',
          sender: 'U123',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('skips onMessage for unregistered chats (only metadata emitted)', async () => {
      const opts = createTestOpts({ registeredGroups: vi.fn(() => ({})) });
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({ text: 'hi' }));

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('fetches display name via getUser()', async () => {
      vi.mocked(mockGetUser).mockResolvedValue({
        raw: { targetProfileDetail: { profileName: 'Alice' } },
      });

      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'ln:U_ALICE': {
            name: 'Alice DM',
            folder: 'alice-dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        toType: 'USER',
        toId: 'MYSELF',
        fromId: 'U_ALICE',
        text: 'hi',
      }));

      expect(mockGetUser).toHaveBeenCalledWith('U_ALICE');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'ln:U_ALICE',
        expect.objectContaining({ sender_name: 'Alice' }),
      );
    });

    it('uses cached display name on repeat messages', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'ln:U123': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({ toType: 'USER', toId: 'MYSELF', fromId: 'U123', text: 'first' }));
      await simulateMessage(buildTextMessage({ toType: 'USER', toId: 'MYSELF', fromId: 'U123', text: 'second' }));

      // getUser should only be called once (second uses cache)
      expect(mockGetUser).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledTimes(2);
    });

    it('falls back to userId when getUser() throws', async () => {
      vi.mocked(mockGetUser).mockRejectedValue(new Error('Not found'));

      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'ln:U_FAIL': {
            name: 'Fail DM',
            folder: 'fail-dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        toType: 'USER',
        toId: 'MYSELF',
        fromId: 'U_FAIL',
        text: 'hi',
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'ln:U_FAIL',
        expect.objectContaining({ sender_name: 'U_FAIL' }),
      );
    });
  });

  // --- !chatid command ---

  describe('!chatid command', () => {
    it('calls msg.reply() with Chat ID', async () => {
      const opts = createTestOpts();
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        toType: 'GROUP',
        toId: 'GROUP123',
        fromId: 'U123',
        text: '!chatid',
      }));

      expect(mockReply).toHaveBeenCalledWith(
        expect.stringContaining('ln:GROUP123'),
      );
    });

    it('does NOT call onMessage', async () => {
      const opts = createTestOpts();
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        toType: 'GROUP',
        toId: 'GROUP123',
        fromId: 'U123',
        text: '!chatid',
      }));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('still calls onChatMetadata', async () => {
      const opts = createTestOpts();
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        toType: 'GROUP',
        toId: 'GROUP123',
        fromId: 'U123',
        text: '!chatid',
      }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'ln:GROUP123',
        expect.any(String),
        expect.any(String),
        'line',
        true,
      );
    });

    it('is case-insensitive (!CHATID)', async () => {
      const opts = createTestOpts();
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildTextMessage({
        toType: 'GROUP',
        toId: 'GROUP123',
        fromId: 'U123',
        text: '!CHATID',
      }));

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(mockReply).toHaveBeenCalled();
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    async function testPlaceholder(contentType: string, expected: string) {
      const opts = createTestOpts();
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildNonTextMessage(contentType));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'ln:GROUP123',
        expect.objectContaining({ content: expected }),
      );
    }

    it('IMAGE → [Image]', async () => testPlaceholder('IMAGE', '[Image]'));
    it('VIDEO → [Video]', async () => testPlaceholder('VIDEO', '[Video]'));
    it('AUDIO → [Audio]', async () => testPlaceholder('AUDIO', '[Audio]'));
    it('FILE → [File]', async () => testPlaceholder('FILE', '[File]'));
    it('STICKER → [Sticker]', async () => testPlaceholder('STICKER', '[Sticker]'));
    it('LOCATION → [Location]', async () => testPlaceholder('LOCATION', '[Location]'));
    it('unknown type → [FLEX]', async () => testPlaceholder('FLEX', '[FLEX]'));

    it('non-text from unregistered chat → no onMessage', async () => {
      const opts = createTestOpts({ registeredGroups: vi.fn(() => ({})) });
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildNonTextMessage('IMAGE'));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('numeric contentType 1 → [Image]', async () => {
      const opts = createTestOpts();
      const channel = new LINEChannel({ method: 'password', email: 'e@test.com', password: 'pw' }, opts);
      await channel.connect();

      await simulateMessage(buildNonTextMessage(1 as unknown as string));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'ln:GROUP123',
        expect.objectContaining({ content: '[Image]' }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends to mid stripping ln: prefix', async () => {
      const channel = createChannel();
      await channel.connect();

      await channel.sendMessage('ln:GROUP123', 'Hello!');

      expect(mockTalkSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'GROUP123' }),
      );
    });

    it('prefixes message with assistant name', async () => {
      const channel = createChannel();
      await channel.connect();

      await channel.sendMessage('ln:GROUP123', 'Hello!');

      expect(mockTalkSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: `${ASSISTANT_NAME}: Hello!` }),
      );
    });

    it('sends single call for prefixed messages ≤4000 chars', async () => {
      const channel = createChannel();
      await channel.connect();

      const prefixLen = `${ASSISTANT_NAME}: `.length;
      await channel.sendMessage('ln:GROUP123', 'a'.repeat(4000 - prefixLen));

      expect(mockTalkSendMessage).toHaveBeenCalledTimes(1);
    });

    it('splits long prefixed messages into multiple calls', async () => {
      const channel = createChannel();
      await channel.connect();

      // Text long enough that prefix + text > 4000
      await channel.sendMessage('ln:GROUP123', 'b'.repeat(4000));

      expect(mockTalkSendMessage).toHaveBeenCalledTimes(2);
    });

    it('handles send failure gracefully without throwing', async () => {
      vi.mocked(mockTalkSendMessage).mockRejectedValue(new Error('Send failed'));

      const channel = createChannel();
      await channel.connect();

      await expect(channel.sendMessage('ln:GROUP123', 'test')).resolves.toBeUndefined();
    });

    it('is a no-op when client is null', async () => {
      const channel = createChannel();
      // Do not connect

      await expect(channel.sendMessage('ln:GROUP123', 'test')).resolves.toBeUndefined();
      expect(mockGetChat).not.toHaveBeenCalled();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('ln:uXXX → true', () => {
      expect(createChannel().ownsJid('ln:uABC123')).toBe(true);
    });

    it('ln:cXXX → true', () => {
      expect(createChannel().ownsJid('ln:cABC123')).toBe(true);
    });

    it('tg:123 → false', () => {
      expect(createChannel().ownsJid('tg:123')).toBe(false);
    });

    it('dc:456 → false', () => {
      expect(createChannel().ownsJid('dc:456')).toBe(false);
    });

    it('@g.us → false', () => {
      expect(createChannel().ownsJid('12345@g.us')).toBe(false);
    });

    it('@s.whatsapp.net → false', () => {
      expect(createChannel().ownsJid('12345@s.whatsapp.net')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('always resolves without error (no-op)', async () => {
      const channel = createChannel();
      await channel.connect();
      await expect(channel.setTyping('ln:GROUP123', true)).resolves.toBeUndefined();
      await expect(channel.setTyping('ln:GROUP123', false)).resolves.toBeUndefined();
    });
  });
});
