# dsh-qqbot-send

DSH plugin that proactively sends text or markdown messages to QQ targets
- `c2c` (private chat), `group`, `channel`, or guild `dm` - over the QQ
Open Platform REST API. It opens no WebSocket/gateway connection of its
own.

## Installation

dsh-qqbot-send is an out-of-tree plugin for a dsh profile. Install it with
the dsh plugin command:

```sh
dsh plugin --profile <name> add dsh-qqbot-send
```

The plugin registers itself. Inspect the composed configuration with
`dsh --profile <name> --dump-config`, then start (or restart) the profile.

## Configuration

When the profile environment provides `QQBOT_APPID` and `QQBOT_SECRET`,
no configuration is required. To set credentials directly or override the
defaults:

| Key | Default | Description |
| --- | --- | --- |
| `appId` | env `QQBOT_APPID` | bot application id |
| `appSecret` | env `QQBOT_SECRET` | bot application secret |
| `markdownSupport` | `true` | whether c2c/group default to markdown |
| `chunkLimit` | `4500` | max characters per message |
| `chunkGapMs` | `500` | gap between chunk sends, in milliseconds |

The message and token API base URLs default to `https://api.bot.qq.com`
and can be overridden with the `QQBOT_BASE_URL` / `QQBOT_TOKEN_BASE_URL`
environment variables. Any key above may also hold `__FROM_ENV__` or a
`process.env.VARNAME` reference.

Missing credentials never block registration: both tools register, and a
send attempt fails at execute time with a clear error. The plugin requires
the host's `dsh-tools` service; on a host without it the plugin stays
inactive.

## Tools

### `qqbot_send_message`

Send a message to a QQ target. No inbound message is required.

- `target`: `c2c:<openid>` (private chat) / `group:<group_openid>` (group) / `channel:<channel_id>` (channel) / `dm:<guild_id>` (guild DM)
- `content`: message body (markdown or plain text)
- `markdown` (optional): c2c/group default to the `markdownSupport` setting; channel/dm default to plain text

Long bodies are split automatically and sent sequentially; sending stops at
the first failed chunk, and the platform `bizCode` (when present) is
reported in the `note` field.

**Platform limits:** proactive messages are subject to QQ platform quotas
(strictest for c2c) and may only reach users who recently interacted with
the bot; nothing in this plugin bypasses platform limits.

### `qqbot_current_target`

Resolves which QQ conversation the current agent session belongs to, with
no side effects. It recognizes QQ sessions recorded by the dsh-qqbot
gateway plugin (when installed); without a gateway the lookup always
misses. A hit returns the ready-to-use target string, for example
`group:<group_openid>`; a miss returns a short note explaining why.

## Message chunking

Long messages are split at line boundaries; fenced code blocks and table
rows move whole to the next chunk. Splitting is lossless: rejoining the
chunks reproduces the original text exactly.

## Tests

`pnpm build`, `pnpm typecheck`, `pnpm lint`, and `node --test` are the
quality gates; a deploy-time token smoke test skips when no
`QQBOT_APPID` / `QQBOT_SECRET` is present.
