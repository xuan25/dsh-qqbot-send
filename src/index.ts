/**
 * dsh-qqbot-send: proactively send arbitrary text/markdown messages to any
 * QQ target (c2c / group / channel / guild dm) via the QQ Open Platform REST
 * API only; the plugin opens no WebSocket/gateway connection. Also resolves
 * which QQ conversation the current session is (zero side effects).
 *
 * Two tools (deliberately separated responsibilities):
 *   - qqbot_send_message   proactive send to c2c / group / channel / dm
 *   - qqbot_current_target zero-side-effect lookup of the current session's
 *                          QQ scope + target id
 *
 * Plugin form: cordis class plugin (the default export is a `Service`
 * subclass). The constructor performs all synchronous initialization
 * (logger / sender / registry / both tool registrations on the `tools`
 * service); the instance `async *[Service.init]()` generator yields the
 * single disposer that unregisters both tools. Tool definitions are built
 * with the dsh-tools `defineTool` helper (declarative parameter/output
 * specs).
 *
 * The query component is import-free of any other plugin: it works off the
 * on-disk model-preferences inventory (`~/.dsh-qqbot/model-prefs.json` by
 * default).
 */

import Schema from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools';

import { DEFAULT_BASE_URL, ENV_KEYS, QQMessageSender } from './sender.js';
import { TargetRegistry } from './target-registry.js';
import { TARGET_FORMAT } from './targets.js';
import type { Logger } from './types.js';

export const PLUGIN_NAME = 'qqbot-send';

/** Validated plugin configuration (see QqBotSendPlugin.Config below). */
export interface QqBotSendConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  tokenBaseUrl: string;
  markdownSupport: boolean;
  chunkLimit: number;
  chunkGapMs: number;
}

/**
 * dsh-qqbot-send plugin (cordis `Service` subclass).
 *
 * - constructor: synchronous initialization only (named logger, message
 *   sender construction - which validates chunkLimit - target registry, and
 *   the two tool registrations on the `tools` service).
 * - `*[Service.init]()`: yields the single disposer (both tool unregisters,
 *   best-effort) and starts nothing else.
 * - `inject = ['tools']`: the single hard dependency. A host without the
 *   dsh-tools service does not activate the plugin (its fiber is parked;
 *   nothing is registered and nothing is thrown).
 * - Missing QQ credentials (empty appId/appSecret with no env fallback) do
 *   NOT block activation: both tools register, and sends fail with a clear
 *   error at call time.
 */
export class QqBotSendPlugin extends Service {
  static name = PLUGIN_NAME
  static readonly inject = ['tools']
  static readonly Config = Schema.object({
    appId: Schema.string().default('').description('QQ Bot AppID (empty, __FROM_ENV__, or a process.env. reference = env QQBOT_APPID)'),
    appSecret: Schema.string().default('').description('QQ Bot AppSecret (empty, __FROM_ENV__, or a process.env. reference = env QQBOT_SECRET)'),
    baseUrl: Schema.string()
      .default('')
      .description(`Message API base URL (empty, __FROM_ENV__, or a process.env. reference = env QQBOT_BASE_URL, else ${DEFAULT_BASE_URL})`),
    tokenBaseUrl: Schema.string()
      .default('')
      .description(`Token endpoint base URL (empty, __FROM_ENV__, or a process.env. reference = env QQBOT_TOKEN_BASE_URL, else ${DEFAULT_BASE_URL})`),
    markdownSupport: Schema.boolean()
      .default(true)
      .description(
        'c2c/group default to markdown (msg_type 2); false defaults to plain text (channel/dm always default to plain text)',
      ),
    chunkLimit: Schema.number()
      .default(4500)
      .description('Max characters per message; longer bodies are chunked automatically'),
    chunkGapMs: Schema.number().default(500).description('Gap between chunk sends (milliseconds)'),
  })

  private readonly logger: Logger
  private readonly sender: QQMessageSender
  private readonly registry: TargetRegistry
  private readonly disposeSend: () => void
  private readonly disposeCurrentTarget: () => void

  constructor(ctx: Context, config: QqBotSendConfig) {
    super(ctx, PLUGIN_NAME)
    this.logger = ctx.logger(PLUGIN_NAME)
    this.sender = new QQMessageSender(config, this.logger)
    this.registry = new TargetRegistry({
      resolveAppId: () => this.sender.resolveAppId(),
      logger: this.logger,
    })
    this.disposeSend = ctx.tools.register(sendToolDefinition(this.sender, this.logger))
    this.disposeCurrentTarget = ctx.tools.register(currentTargetToolDefinition(this.registry))
    this.logger.info('[qqbot-send] registered qqbot_send_message / qqbot_current_target')
  }

  /**
   * Yields the single disposer that unregisters both tools (best-effort; a
   * failing unregister never blocks the other). Nothing else to start:
   * registration completed in the constructor.
   */
  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, unknown> {
    yield async () => {
      try {
        this.disposeSend()
      } catch {
        // best-effort; disposal must not throw
      }
      try {
        this.disposeCurrentTarget()
      } catch {
        // best-effort; disposal must not throw
      }
    }
  }
}

export default QqBotSendPlugin

/** Agent session-id accessor (structural read of exec.agent). */
function agentSessionId(exec: ToolRunContext): string | undefined {
  const agent = exec.agent as unknown as { session?: { id?: string } } | undefined;
  return agent?.session?.id;
}

/** Build the qqbot_send_message tool definition. */
function sendToolDefinition(sender: QQMessageSender, logger: Logger): ToolDefinition {
  return defineTool({
    name: 'qqbot_send_message',
    description:
      'Proactively send a text/markdown message to a QQ target (no inbound message required; works for any target): target format ' +
      `${TARGET_FORMAT} (private chat / group / channel / guild DM). Long text is chunked automatically and sent sequentially. ` +
      'Note: proactive messages are subject to QQ platform quota limits (strictest for c2c; the platform may only allow sending to ' +
      'users who recently interacted with the bot, otherwise the send is rejected with a bizCode); markdown for channel/DM is not ' +
      'verified by the platform, prefer markdown=false for channel/DM. If you are unsure about the target id, call ' +
      'qqbot_current_target first.',
    parameters: {
      target: { type: 'string', required: true, description: `Target, e.g. ${TARGET_FORMAT}` },
      content: { type: 'string', required: true, description: 'Message body (markdown or plain text)' },
      markdown: {
        type: 'boolean',
        description:
          'c2c/group: true=markdown, false=plain text; default follows plugin config markdownSupport. ' +
          'channel/dm: plain text by default; explicit true passes markdown through as-is (unverified; the platform may reject it)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: {
            type: 'string',
            enum: ['c2c', 'group', 'channel', 'dm'],
            required: true,
            description: 'Conversation scope actually sent to',
          },
          target: { type: 'string', required: true, description: 'Target address as sent, e.g. group:123' },
          format: {
            type: 'string',
            enum: ['markdown', 'text'],
            required: true,
            description: 'Message format actually used',
          },
          totalChunks: { type: 'integer', required: true, description: 'Number of chunks the body was split into' },
          sentChunks: { type: 'integer', required: true, description: 'Number of chunks actually delivered (<= totalChunks)' },
          messageIds: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'Platform message ids of the delivered chunks',
          },
          note: {
            type: 'string',
            required: true,
            description: 'Empty when all chunks were delivered; otherwise a failure/abort explanation',
          },
        },
      },
      render: (_args, value) => {
        const ok = value.note === '' && value.sentChunks === value.totalChunks;
        const head = ok
          ? `Sent ${value.sentChunks} chunk(s) to ${value.target} (${value.format})`
          : `Send incomplete: ${value.sentChunks}/${value.totalChunks} chunk(s) delivered to ${value.target} (${value.format})`;
        const parts = [head];
        if (value.note) {
          parts.push(`note: ${value.note}`);
        }
        return [{ type: 'text', text: parts.join('\n') }];
      },
    },
    async execute(args, exec) {
      // target and content are required by the parameter spec; an empty
      // string still passes that spec, so reject it here with a clear
      // message.
      if (args.target.length === 0) {
        throw new Error(`qqbot_send_message: target is required, e.g. ${TARGET_FORMAT}`);
      }
      if (args.content.length === 0) {
        throw new Error('qqbot_send_message: content is required and must be a non-empty string');
      }
      try {
        const sessionId = agentSessionId(exec);
        const result = await sender.send(args.target, args.content, {
          markdown: args.markdown,
          signal: exec.signal,
        });
        logger.debug?.(
          `[qqbot-send] sent ${result.sentChunks}/${result.totalChunks} chunk(s) to ${result.target} (agent=${sessionId ?? 'n/a'})`,
        );
        return result;
      } catch (err) {
        throw new Error(`qqbot_send_message: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}

/** Build the qqbot_current_target tool definition. */
function currentTargetToolDefinition(registry: TargetRegistry): ToolDefinition {
  return defineTool({
    name: 'qqbot_current_target',
    description:
      'Look up the QQ conversation target of the current session (zero side effects; sends nothing): returns scope (c2c/group/channel/dm) ' +
      'and targetId for use with qqbot_send_message. Single data source: the on-disk model-preferences inventory ' +
      '(~/.dsh-qqbot/model-prefs.json, written by the dsh-qqbot gateway plugin when installed), value-matched against the current ' +
      "session's id and restricted to this bot's appId and the sendable scopes. Coverage: only QQ sessions present in the " +
      'inventory are recognized.',
    parameters: {},
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              resolved: { type: 'boolean', const: true, required: true, description: 'Whether the current session maps to a known QQ conversation' },
              scope: { type: 'string', required: true, description: 'Conversation scope (c2c/group/channel/dm)' },
              targetId: { type: 'string', required: true, description: 'Platform id of the conversation' },
              target: { type: 'string', required: true, description: 'Ready-to-use target string for qqbot_send_message' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              resolved: { type: 'boolean', const: false, required: true, description: 'Whether the current session maps to a known QQ conversation' },
              note: { type: 'string', required: true, description: 'Explanation when unresolved (empty otherwise)' },
            },
          },
        ],
      },
      render: (_args, value) => {
        if (value.resolved) {
          return [{ type: 'text', text: value.target }];
        }
        return [{ type: 'text', text: value.note }];
      },
    },
    async execute(_args, exec) {
      return registry.resolve(agentSessionId(exec));
    },
  });
}

export { ENV_KEYS, DEFAULT_BASE_URL };
