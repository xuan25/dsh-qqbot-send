/**
 * Target registry: resolves which QQ conversation an agent session belongs
 * to, so callers (model or human) can address proactive sends without
 * knowing platform ids.
 *
 * Data source (this module imports no other plugin, keeps no state, and
 * writes nothing): the on-disk model-preferences file (`~/.dsh-qqbot/
 * model-prefs.json` by default), re-read once per resolve. Its `sessionIds`
 * table maps session keys `qqbot:<appId>:<kind>:<peerId>` to the dsh
 * session id of the QQ session; resolution is a pure value match between
 * the agent session id and a stored value.
 *
 * Matching is restricted to sendable scopes and to inventory keys whose
 * appId equals the appId this plugin is configured with (empty appId =
 * credentials unresolved = no matching at all). A missing or corrupt file
 * simply yields no match.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TARGET_SCOPES } from './targets.js';
import type { Logger, TargetScope } from './types.js';

const KEY_PREFIX = 'qqbot:';

interface ParsedSessionKey {
  appId: string;
  kind: string;
  peerId: string;
}

export interface TargetRegistryOptions {
  /** Returns the resolved bot appId ('' when credentials are unavailable). */
  resolveAppId?: () => string;
  /** Path of the model-preferences inventory file. */
  prefsPath?: string;
  logger?: Logger;
}

interface ResolvedTarget {
  resolved: true;
  scope: TargetScope;
  targetId: string;
  target: string;
}

interface UnresolvedTarget {
  resolved: false;
  note: string;
}

/** Result of one resolution attempt. */
export type TargetResolution = ResolvedTarget | UnresolvedTarget;

/**
 * Parse a session key of the form `qqbot:<appId>:<kind>:<peerId>`. The peer
 * id may itself contain colons; only the first two segments after the prefix
 * are appId and kind.
 * @returns the parsed key, or null when malformed
 */
export function parseSessionKey(key: string): ParsedSessionKey | null {
  if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) {
    return null;
  }
  const parts = key.slice(KEY_PREFIX.length).split(':');
  if (parts.length < 3) {
    return null;
  }
  const appId = parts[0];
  const kind = parts[1];
  const peerId = parts.slice(2).join(':');
  if (!appId || !kind || !peerId) {
    return null;
  }
  return { appId, kind, peerId };
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class TargetRegistry {
  readonly resolveAppId: () => string;
  readonly prefsPath: string;
  readonly logger?: Logger;

  constructor(options: TargetRegistryOptions) {
    this.resolveAppId = options.resolveAppId ?? (() => '');
    this.prefsPath = options.prefsPath ?? path.join(os.homedir(), '.dsh-qqbot', 'model-prefs.json');
    this.logger = options.logger;
  }

  /**
   * Read the `sessionIds` inventory from the model-preferences file. Only
   * string values are kept. Returns {} when the file is missing, unreadable,
   * or the table is absent.
   */
  readInventory(): Record<string, string> {
    let raw: string;
    try {
      raw = readFileSync(this.prefsPath, 'utf8');
    } catch {
      return {};
    }
    try {
      const prefs: unknown = JSON.parse(raw);
      const sessionIds: unknown =
        prefs !== null && typeof prefs === 'object'
          ? (prefs as { sessionIds?: unknown }).sessionIds
          : undefined;
      if (sessionIds === null || typeof sessionIds !== 'object' || Array.isArray(sessionIds)) {
        return {};
      }
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(sessionIds)) {
        if (typeof value === 'string') {
          out[key] = value;
        }
      }
      return out;
    } catch (err) {
      this.logger?.warn(`[qqbot-send] unreadable model prefs at ${this.prefsPath}: ${formatError(err)}`);
      return {};
    }
  }

  /**
   * Resolve the QQ conversation of one agent session by pure value match
   * against the on-disk inventory.
   * @param agentSessionId the dsh session id of the calling agent (undefined
   *        or empty when the call has no agent context)
   */
  resolve(agentSessionId: string | undefined): TargetResolution {
    if (agentSessionId && agentSessionId.length > 0) {
      const appId = this.resolveAppId();
      for (const [key, childId] of Object.entries(this.readInventory())) {
        const parsed = parseSessionKey(key);
        if (parsed === null || !TARGET_SCOPES.includes(parsed.kind as TargetScope)) {
          continue;
        }
        if (childId.length === 0) {
          continue;
        }
        if (appId === '' || parsed.appId !== appId) {
          continue;
        }
        if (agentSessionId === childId) {
          return {
            resolved: true,
            scope: parsed.kind as TargetScope,
            targetId: parsed.peerId,
            target: `${parsed.kind}:${parsed.peerId}`,
          };
        }
      }
    }
    return {
      resolved: false,
      note: agentSessionId
        ? 'no matching record for this session'
        : 'no agent session context; resolution skipped',
    };
  }
}
