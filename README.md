# dsh-qqbot-send

DSH plugin that proactively sends text or markdown messages to any QQ
target - `c2c` (private chat), `group`, `channel`, or guild `dm` - via the
QQ Open Platform REST API. It opens no WebSocket/gateway connection. A
second tool resolves which QQ conversation the current agent session
belongs to, with no side effects.

## Installation

dsh-qqbot-send is an out-of-tree plugin for a dsh profile. Install it with
the dsh plugin command:

```sh
dsh plugin --profile <name> add dsh-qqbot-send
```

The plugin registers itself. Inspect the composed configuration with
`dsh --profile <name> --dump-config`, then start (or restart) the profile.

## Configuration

All keys are optional. The four string keys (`appId`, `appSecret`,
`baseUrl`, `tokenBaseUrl`) fall back to the named environment variable, or
to the default shown, when left empty, and also accept an explicit
`process.env.VARNAME` value; the remaining keys use the defaults shown.
When the profile environment provides `QQBOT_APPID` and `QQBOT_SECRET`, no
configuration is required.

| Key | Default | Description |
| --- | --- | --- |
| `appId` | `''` | empty, `__FROM_ENV__`, or a `process.env.` reference = env `QQBOT_APPID` |
| `appSecret` | `''` | empty, `__FROM_ENV__`, or a `process.env.` reference = env `QQBOT_SECRET` |
| `baseUrl` | `''` | message API base URL; empty, `__FROM_ENV__`, or a `process.env.` reference = env `QQBOT_BASE_URL`, else `https://api.bot.qq.com` |
| `tokenBaseUrl` | `''` | token endpoint base URL; empty, `__FROM_ENV__`, or a `process.env.` reference = env `QQBOT_TOKEN_BASE_URL`, else `https://api.bot.qq.com` |
| `markdownSupport` | `true` | whether c2c/group default to markdown |
| `chunkLimit` | `4500` | max characters per message (an invalid value rejects the plugin at startup) |
| `chunkGapMs` | `500` | gap between chunk sends, in milliseconds |

Missing credentials never block registration: both tools register, and a
send attempt fails at execute time with a clear error. The plugin requires
the host's `dsh-tools` service; on a host without it the plugin stays
inactive.

## Tools

### `qqbot_send_message`

Send a message to a QQ target. No inbound message is required.

| Parameter | Description |
| --- | --- |
| `target` | `c2c:<openid>` (private chat) / `group:<group_openid>` (group) / `channel:<channel_id>` (channel) / `dm:<guild_id>` (guild DM) |
| `content` | Message body (markdown or plain text) |
| `markdown` | Optional. c2c/group: defaults to the `markdownSupport` setting (true = markdown, false = plain text). channel/dm: plain text by default; explicit `true` sends markdown, and any platform rejection is surfaced as a `bizCode` |

Long bodies (over `chunkLimit`) are split automatically and sent
sequentially with a `chunkGapMs` gap. Sending stops at the first failed
chunk; the failure detail (platform `bizCode` when present) is reported in
the `note` field. Successful sends are recorded in an in-memory send cache
(cleared on restart) that `qqbot_current_target` can resolve.

**Platform limits:** proactive messages are subject to QQ platform quotas
(strictest for c2c) and may only reach users who recently interacted with
the bot; other sends are rejected with a `bizCode`. Nothing in this plugin
bypasses platform limits.

### `qqbot_current_target`

Resolves which QQ conversation the current agent session belongs to, with
no side effects. It recognizes QQ sessions recorded by the dsh-qqbot
gateway plugin (when installed); without a gateway the lookup always
misses. A hit returns the ready-to-use target string, for example
`group:<group_openid>`; a miss returns a short note explaining why.

## Message chunking

Long messages are split at line boundaries. Fenced code blocks and table
row runs move whole to the next chunk instead of being cut apart; a block
taller than `chunkLimit` is re-packed line by line. A single line longer
than the limit is sent alone and may be rejected by the platform. Splitting
is lossless: rejoining the chunks reproduces the original text exactly.

## Tests

`pnpm build`, `pnpm typecheck`, `pnpm lint`, and `node --test` are the
quality gates. The test suite pins the chunker, the target resolution
chain, and a deploy-time token smoke test that skips when no `QQBOT_APPID`
/ `QQBOT_SECRET` is present, or when the SDK cannot be resolved (pass
`--sdk-dir`, or set `QQBOT_SDK_DIR`, to point at an installed copy).
