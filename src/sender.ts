/**
 * QQ Open Platform REST sender.
 *
 * Uses the protocol layer of @tencent-connect/qqbot-nodejs (TokenManager +
 * ApiClient + MessageApi) only; no WebSocket/gateway connection is opened.
 *
 * Endpoints (QQ Open Platform v2):
 *   c2c     POST /v2/users/{openid}/messages
 *   group   POST /v2/groups/{group_openid}/messages
 *   channel POST /channels/{channel_id}/messages
 *   dm      POST /dms/{guild_id}/messages
 *
 * c2c/group bodies are dispatched via MessageApi.sendRaw (the SDK fills
 * `msg_seq`/`msg_type` for the call); channel/dm bodies via the raw
 * pass-throughs, which forward the body as-is (undefined fields filtered).
 *
 * Long bodies are split by a MessageChunker (one per sender, constructed
 * with the configured chunkLimit) and sent sequentially with a small gap
 * between chunks; sending stops at the first failed chunk and the failure is
 * reported in `note` (including the platform bizCode when the platform
 * returned a structured error).
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiClient, MessageApi, TokenManager } from '@tencent-connect/qqbot-nodejs/protocol';
import type { Credentials, MessageResponse } from '@tencent-connect/qqbot-nodejs/protocol';

import { MessageChunker } from './chunker.js';
import { parseTarget, TARGET_FORMAT } from './targets.js';
import type { Logger, SendResult, TargetRef, TargetScope } from './types.js';

/** Default base URL for both the message and the token endpoints. */
export const DEFAULT_BASE_URL = 'https://api.bot.qq.com';

/** Environment variable names used when a config value is a placeholder. */
export const ENV_KEYS = Object.freeze({
  appId: 'QQBOT_APPID',
  appSecret: 'QQBOT_SECRET',
  baseUrl: 'QQBOT_BASE_URL',
  tokenBaseUrl: 'QQBOT_TOKEN_BASE_URL',
} as const);

/** Sender configuration as supplied by the plugin config (all optional). */
export interface QQMessageSenderOptions {
  appId?: string;
  appSecret?: string;
  baseUrl?: string;
  tokenBaseUrl?: string;
  /** Whether c2c/group markdown is enabled for this bot. */
  markdownSupport?: boolean;
  chunkLimit?: number;
  chunkGapMs?: number;
}

/** Options for one send call. */
export interface SendOptions {
  /**
   * Force markdown (c2c/group default comes from config.markdownSupport;
   * channel/dm default to plain text).
   */
  markdown?: boolean;
  /** Caller cancellation signal. */
  signal?: AbortSignal;
  /** Session id recorded into the send cache on full success. */
  sessionId?: string;
}

interface ResolvedSenderConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  tokenBaseUrl: string;
  markdownSupport: boolean;
  chunkLimit: number;
  chunkGapMs: number;
}

interface ApiErrorLike {
  bizCode?: number | null;
  bizMessage?: string | null;
  httpStatus?: number | null;
  path?: string | null;
}

interface ClientChain {
  tokenManager: TokenManager;
  apiClient: ApiClient;
  messageApi: MessageApi;
}

/**
 * Resolve a config value that may be the `__FROM_ENV__` placeholder or a
 * `process.env.X` reference against the process environment.
 * @returns the concrete value, or '' when the env var is unset
 */
export function resolveEnv(configValue: string | undefined, envKey: string): string {
  if (configValue && configValue !== '__FROM_ENV__' && !configValue.startsWith('process.env')) {
    return configValue;
  }
  return process.env[envKey] ?? '';
}

/** Normalize a base URL: strip trailing slashes; empty input becomes the default. */
export function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) {
    return DEFAULT_BASE_URL;
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * Best-effort package version for the User-Agent header: walk up from this
 * module's directory (bounded to a few levels) for the nearest package.json
 * with a version; fall back to 0.0.0.
 */
function readPluginVersion(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 4; depth++) {
      try {
        const raw = readFileSync(path.join(dir, 'package.json'), 'utf8');
        const pkg = JSON.parse(raw) as { version?: unknown };
        if (typeof pkg.version === 'string') {
          return pkg.version;
        }
      } catch {
        // no package.json here; walk up
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Human-readable failure note, surfacing the platform bizCode when present. */
function describeSendError(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'bizCode' in err) {
    const api = err as ApiErrorLike;
    let note = `API error bizCode=${api.bizCode ?? '?'} http=${api.httpStatus ?? '?'} path=${api.path ?? '?'}`;
    if (api.bizMessage) {
      note += ` ${api.bizMessage}`;
    }
    return note;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `send failed: ${message}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class QQMessageSender {
  private readonly config: ResolvedSenderConfig;
  private readonly logger?: Logger;
  private readonly chunker: MessageChunker;
  private readonly sendCache: Map<string, TargetRef>;
  private clientChain: ClientChain | null;
  private appId: string | null;

  constructor(config: QQMessageSenderOptions = {}, logger?: Logger) {
    this.config = {
      appId: '',
      appSecret: '',
      baseUrl: '',
      tokenBaseUrl: '',
      markdownSupport: true,
      chunkLimit: 4500,
      chunkGapMs: 500,
      ...config,
    };
    this.logger = logger;
    // Fail fast on a misconfigured chunkLimit (RangeError) instead of at the
    // first send; the chunker is constructed once and reused per send.
    this.chunker = new MessageChunker(this.config.chunkLimit);
    this.sendCache = new Map();
    this.clientChain = null;
    this.appId = null;
  }

  /**
   * Resolve the bot appId from config/environment without throwing.
   * @returns '' when unavailable
   */
  resolveAppId(): string {
    if (this.appId !== null) {
      return this.appId;
    }
    this.appId = resolveEnv(this.config.appId, ENV_KEYS.appId);
    return this.appId;
  }

  /**
   * Resolve appId/appSecret, throwing when credentials are not usable.
   */
  resolveCredentials(): Credentials {
    const appId = resolveEnv(this.config.appId, ENV_KEYS.appId);
    const clientSecret = resolveEnv(this.config.appSecret, ENV_KEYS.appSecret);
    if (!appId || !clientSecret) {
      throw new Error(
        `QQ credentials are not configured (set config appId/appSecret or env ${ENV_KEYS.appId}/${ENV_KEYS.appSecret})`,
      );
    }
    return { appId, clientSecret };
  }

  /** Message API base URL. */
  baseUrl(): string {
    return normalizeBaseUrl(resolveEnv(this.config.baseUrl, ENV_KEYS.baseUrl));
  }

  /** Token endpoint base URL. */
  tokenBaseUrl(): string {
    return normalizeBaseUrl(resolveEnv(this.config.tokenBaseUrl, ENV_KEYS.tokenBaseUrl));
  }

  /** Lazily build the SDK client chain (shared across sends). */
  clients(): ClientChain {
    if (this.clientChain === null) {
      const userAgent = `dsh-qqbot-send/${readPluginVersion()} (Node/${process.versions.node}; ${os.platform()})`;
      const tokenManager = new TokenManager({
        baseUrl: this.tokenBaseUrl(),
        userAgent,
        logger: this.logger,
      });
      const apiClient = new ApiClient({
        baseUrl: this.baseUrl(),
        userAgent,
        logger: this.logger,
      });
      const messageApi = new MessageApi(apiClient, tokenManager, {
        markdownSupport: this.config.markdownSupport,
        logger: this.logger,
      });
      this.clientChain = { tokenManager, apiClient, messageApi };
    }
    return this.clientChain;
  }

  /** Remember which target a session was last sent to (in-memory only). */
  recordSend(sessionId: string | undefined, scope: TargetScope, targetId: string): void {
    if (sessionId && sessionId.length > 0) {
      this.sendCache.set(sessionId, { scope, targetId });
    }
  }

  /** Look up the last sent target of a session, if any. */
  cachedTarget(sessionId: string): TargetRef | undefined {
    return this.sendCache.get(sessionId);
  }

  /**
   * Send `content` to one QQ target, chunked when longer than the limit.
   * Sending stops at the first failed chunk; the canonical result carries
   * everything that was delivered plus a `note` explaining any failure.
   */
  async send(target: string, content: string, options: SendOptions = {}): Promise<SendResult> {
    const parsed = parseTarget(target);
    if (!parsed) {
      throw new Error(`invalid target ${JSON.stringify(target)}: expected one of ${TARGET_FORMAT}`);
    }
    if (content.length === 0) {
      throw new Error('content must be a non-empty string');
    }
    const { scope, targetId } = parsed;
    const creds = this.resolveCredentials();
    const { messageApi } = this.clients();

    const useMarkdown =
      scope === 'channel' || scope === 'dm'
        ? options.markdown === true
        : options.markdown ?? this.config.markdownSupport;

    // The chunker returns the whole text unsplit when it fits its limit, so
    // a single call covers both the in-limit and over-limit paths.
    const chunks = this.chunker.chunk(content);
    const gapMs = Number.isFinite(this.config.chunkGapMs) ? this.config.chunkGapMs : 0;

    const format: SendResult['format'] = useMarkdown ? 'markdown' : 'text';
    const sent: string[] = [];
    let note = '';
    for (let i = 0; i < chunks.length; i++) {
      if (options.signal?.aborted) {
        note = 'send aborted before this chunk (caller cancelled)';
        break;
      }
      const chunk = chunks[i];
      const body: Record<string, unknown> = useMarkdown
        ? { markdown: { content: chunk } }
        : { content: chunk };
      try {
        const response = await this.sendChunk(messageApi, scope, targetId, creds, body);
        if (response && typeof response.id === 'string') {
          sent.push(response.id);
        }
      } catch (err) {
        note = describeSendError(err);
        this.logger?.warn(`[qqbot-send] chunk ${i + 1}/${chunks.length} to ${scope}:${targetId} failed: ${note}`);
        break;
      }
      if (i < chunks.length - 1 && gapMs > 0) {
        await sleep(gapMs);
      }
    }

    if (note === '') {
      this.recordSend(options.sessionId, scope, targetId);
    }

    return {
      scope,
      target: `${scope}:${targetId}`,
      format,
      totalChunks: chunks.length,
      sentChunks: sent.length,
      messageIds: sent,
      note,
    };
  }

  /** Dispatch one chunk on the platform endpoint for its scope. */
  private async sendChunk(
    messageApi: MessageApi,
    scope: TargetScope,
    targetId: string,
    creds: Credentials,
    body: Record<string, unknown>,
  ): Promise<MessageResponse> {
    if (scope === 'channel') {
      return messageApi.sendChannelMessageRaw(targetId, creds, body);
    }
    if (scope === 'dm') {
      return messageApi.sendDmMessageRaw(targetId, creds, body);
    }
    // c2c / group: the SDK fills msg_seq/msg_type for this call
    return messageApi.sendRaw(scope, targetId, creds, body);
  }
}
