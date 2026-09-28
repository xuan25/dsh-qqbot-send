/**
 * QQ target addressing.
 *
 * A target is the addressable endpoint of one QQ conversation:
 *   c2c:<openid>          private (user-to-bot) chat
 *   group:<group_openid>  group chat
 *   channel:<channel_id>  guild channel
 *   dm:<guild_id>         guild DM
 *
 * Parsing is deliberately conservative: anything that does not match exactly
 * one of the four forms is rejected, so a malformed target fails fast with a
 * clear error instead of reaching the platform API.
 */

import type { TargetRef, TargetScope } from './types.js';

/** All conversation scopes this plugin can address. */
export const TARGET_SCOPES: readonly TargetScope[] = Object.freeze(['c2c', 'group', 'channel', 'dm']);

/** Canonical target syntax, used in tool descriptions and errors. */
export const TARGET_FORMAT = 'c2c:<openid> | group:<group_openid> | channel:<channel_id> | dm:<guild_id>';

/**
 * Parse a target string of the form `<scope>:<targetId>`.
 * @returns the parsed target, or null when the input is malformed
 */
export function parseTarget(input: unknown): TargetRef | null {
  if (typeof input !== 'string') {
    return null;
  }
  const idx = input.indexOf(':');
  if (idx <= 0) {
    return null;
  }
  const scope = input.slice(0, idx);
  const targetId = input.slice(idx + 1);
  if (targetId.length === 0) {
    return null;
  }
  if (!TARGET_SCOPES.includes(scope as TargetScope)) {
    return null;
  }
  return { scope: scope as TargetScope, targetId };
}
