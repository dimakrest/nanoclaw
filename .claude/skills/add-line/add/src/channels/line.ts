import fs from 'fs';
import path from 'path';
import { Agent, setGlobalDispatcher, fetch as undiciFetch, Request as UndiciRequest } from 'undici';
import { Client, loginWithPassword, loginWithQR, TalkMessage } from '@evex/linejs';
import { BaseClient } from '@evex/linejs/base';
import { FileStorage } from '@evex/linejs/storage';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

export interface LINEChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class LINEChannel implements Channel {
  name = 'line';

  private lineClient: Client | null = null;
  private connected = false;
  private abortController: AbortController | null = null;
  private opts: LINEChannelOpts;
  private auth: { method: 'password'; email: string; password: string } | { method: 'qr' };
  private displayNameCache = new Map<string, string>();

  constructor(
    auth: { method: 'password'; email: string; password: string } | { method: 'qr' },
    opts: LINEChannelOpts,
  ) {
    this.auth = auth;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const storageDir = path.join(DATA_DIR, 'line');
    fs.mkdirSync(storageDir, { recursive: true });
    const storage = new FileStorage(path.join(storageDir, 'session.json'));

    logger.info('Connecting to LINE...');
    console.log('\n  LINE: Connecting...');

    // LINE's push stream (LegyPusher) requires HTTP/2 for bidirectional streaming.
    // Node.js built-in fetch only speaks HTTP/1.1, so we use undici with allowH2.
    setGlobalDispatcher(new Agent({ allowH2: true }));
    (globalThis as any).Request = UndiciRequest;

    const initOpts = { device: 'DESKTOPWIN' as const, storage, fetch: undiciFetch as any };

    // Try to reuse existing session via refresh token before falling back to QR/password
    const existingToken = await storage.get('refreshToken');
    const expire = await storage.get('expire');
    const sessionValid = existingToken && expire && Number(expire) > Date.now() / 1000;

    const savedAuthToken = await storage.get('authToken');
    if (sessionValid && savedAuthToken) {
      logger.info('Resuming LINE session via refresh token');
      console.log('  LINE: Resuming existing session...\n');
      try {
        const base = new BaseClient({
          device: initOpts.device,
          storage: initOpts.storage,
          fetch: initOpts.fetch,
        });
        // Set the old access token so the refresh endpoint gets x-line-access header
        base.authToken = String(savedAuthToken);
        await base.auth.tryRefreshToken();
        await base.loginProcess.ready();
        this.lineClient = new Client(base);
      } catch (err) {
        logger.warn({ err }, 'LINE session refresh failed, falling back to fresh login');
        console.log('  LINE: Session expired, starting fresh login...\n');
        this.lineClient = await this.freshLogin(storage, initOpts);
      }
    } else {
      this.lineClient = await this.freshLogin(storage, initOpts);
    }

    // Persist auth token for session reuse across restarts
    await storage.set('authToken', this.lineClient.authToken);
    this.lineClient.base.on('update:authtoken', (token: string) => {
      storage.set('authToken', token);
    });

    this.connected = true;
    logger.info('Connected to LINE');
    console.log('  LINE: Connected\n');

    this.lineClient.base.on('end', () => {
      this.connected = false;
      logger.warn('LINE session ended');
    });

    this.lineClient.base.on('log', (log) => {
      if (typeof log.type === 'string' && log.type.includes('PUSH')) {
        logger.info({ pushLog: log.type }, 'LINE PUSH debug');
      }
    });

    this.abortController = new AbortController();
    this.lineClient.listen({ talk: true, signal: this.abortController.signal });
    this.lineClient.on('message', (msg) => {
      this.handleMessage(msg).catch((err) =>
        logger.error({ err }, 'Error handling LINE message'),
      );
    });
  }

  private async freshLogin(
    storage: InstanceType<typeof FileStorage>,
    initOpts: { device: 'DESKTOPWIN'; storage: typeof storage; fetch: any },
  ): Promise<Client> {
    if (this.auth.method === 'qr') {
      const qrcodeTerminal = await import('qrcode-terminal');
      console.log('  Scan the QR code below with your LINE app (Me → Settings → Devices).\n');
      return loginWithQR(
        {
          onReceiveQRUrl(url: string) {
            qrcodeTerminal.default.generate(url, { small: true });
            console.log(`\n  LINE QR URL: ${url}\n`);
          },
          onPincodeRequest(pin: string) {
            logger.info({ pin }, 'LINE pincode required');
            console.log(`\n  LINE: Enter this pincode on your LINE app: ${pin}\n`);
          },
        },
        initOpts,
      );
    } else {
      console.log('  If prompted, enter the pincode on your LINE mobile app.\n');
      return loginWithPassword(
        {
          email: this.auth.email,
          password: this.auth.password,
          onPincodeRequest(pin: string) {
            logger.info({ pin }, 'LINE pincode required');
            console.log(`\n  LINE: Enter this pincode on your LINE app: ${pin}\n`);
          },
        },
        initOpts,
      );
    }
  }

  private async handleMessage(msg: TalkMessage): Promise<void> {
    logger.info({ text: msg.text?.slice(0, 50), from: msg.from.id, to: msg.to.id, toType: msg.to.type, isMyMessage: msg.isMyMessage }, 'LINE handleMessage entered');
    const fromMe = msg.isMyMessage;

    // toType: 1/ROOM or 2/GROUP = group chat; 0/USER = DM
    const toType = msg.to.type;
    const isGroup =
      toType === 'GROUP' || toType === 2 || toType === 'ROOM' || toType === 1;
    // For groups, chat ID is the group MID (msg.to.id).
    // For DMs in shared-account mode, msg.from.id is always our own MID when
    // isMyMessage is true (sent from phone). The reply must go to the OTHER
    // person (msg.to.id), not back to ourselves.
    const chatMid = isGroup ? msg.to.id : (fromMe ? msg.to.id : msg.from.id);
    const chatJid = `ln:${chatMid}`;
    const senderId: string = msg.from.id;
    const timestamp = new Date(Number(msg.raw.createdTime)).toISOString();
    const senderName = fromMe ? ASSISTANT_NAME : await this.getDisplayName(senderId);
    const chatName = isGroup ? chatJid : senderName;

    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'line', isGroup);

    // contentType: 0/NONE = text; others are media
    // The value can be numeric (Thrift wire format) or string (test mocks)
    const rawContentType = msg.raw.contentType;
    const contentTypeStr: string =
      typeof rawContentType === 'number'
        ? ([
            'NONE', 'IMAGE', 'VIDEO', 'AUDIO', 'HTML', 'PDF', 'CALL',
            'STICKER', 'PRESENCE', 'GIFT', 'GROUPBOARD', 'APPLINK', 'LINK',
            'CONTACT', 'FILE', 'LOCATION',
          ][rawContentType as number] ?? String(rawContentType))
        : String(rawContentType ?? 'NONE');

    if (contentTypeStr === 'NONE') {
      const content: string = msg.text || '';
      if (!content) return;

      // Bot messages are prefixed with the assistant name (shared account pattern)
      const isBotMessage = content.startsWith(`${ASSISTANT_NAME}:`);

      if (content.trim().toLowerCase() === '!chatid') {
        await msg.reply(`Chat ID: ${chatJid}\nType: ${String(toType)}`);
        return;
      }

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid }, 'Message from unregistered LINE chat');
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msg.raw.id,
        chat_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: fromMe,
        is_bot_message: isBotMessage,
      });

      logger.info({ chatJid, sender: senderName, fromMe }, 'LINE message stored');
      return;
    }

    // Non-text — placeholder
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) return;

    let placeholder: string;
    switch (contentTypeStr) {
      case 'IMAGE':
        placeholder = '[Image]';
        break;
      case 'VIDEO':
        placeholder = '[Video]';
        break;
      case 'AUDIO':
        placeholder = '[Audio]';
        break;
      case 'FILE':
        placeholder = '[File]';
        break;
      case 'STICKER':
        placeholder = '[Sticker]';
        break;
      case 'LOCATION':
        placeholder = '[Location]';
        break;
      default:
        placeholder = `[${contentTypeStr}]`;
        break;
    }

    this.opts.onMessage(chatJid, {
      id: msg.raw.id,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content: placeholder,
      timestamp,
      is_from_me: fromMe,
    });
  }

  private async getDisplayName(userId: string): Promise<string> {
    const cached = this.displayNameCache.get(userId);
    if (cached) return cached;

    if (this.displayNameCache.size > 10000) this.displayNameCache.clear();

    try {
      const user = await this.lineClient!.getUser(userId);
      const name = user.raw.targetProfileDetail.profileName;
      this.displayNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to get LINE display name');
      return userId;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.lineClient) {
      logger.warn('LINE client not initialized');
      return;
    }

    // Prefix with assistant name so we can distinguish bot replies from user
    // messages on the shared account (same pattern as WhatsApp shared number)
    const prefixed = `${ASSISTANT_NAME}: ${text}`;

    try {
      const mid = jid.replace(/^ln:/, '');
      const MAX_LENGTH = 4000;
      const chunks: string[] = [];

      if (prefixed.length <= MAX_LENGTH) {
        chunks.push(prefixed);
      } else {
        for (let i = 0; i < prefixed.length; i += MAX_LENGTH) {
          chunks.push(prefixed.slice(i, i + MAX_LENGTH));
        }
      }

      // Use talk.sendMessage directly — getChat() fails for user MIDs (DMs)
      for (const chunk of chunks) {
        await this.lineClient.base.talk.sendMessage({ to: mid, text: chunk });
      }
      logger.info({ jid, length: prefixed.length }, 'LINE message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send LINE message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('ln:');
  }

  async disconnect(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this.lineClient = null;
    this.connected = false;
    logger.info('LINE channel stopped');
  }

  // LINEJS does not expose a typing indicator API
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {}
}

// --- Self-registration ---
registerChannel('line', (opts: ChannelOpts) => {
  const lineEnv = readEnvFile(['LINE_EMAIL', 'LINE_PASSWORD', 'LINE_QR']);
  const email = process.env.LINE_EMAIL || lineEnv.LINE_EMAIL || '';
  const password = process.env.LINE_PASSWORD || lineEnv.LINE_PASSWORD || '';
  const qr = (process.env.LINE_QR || lineEnv.LINE_QR || '') === 'true';

  if (qr) {
    return new LINEChannel({ method: 'qr' }, opts);
  }
  if (email && password) {
    return new LINEChannel({ method: 'password', email, password }, opts);
  }
  return null;
});
