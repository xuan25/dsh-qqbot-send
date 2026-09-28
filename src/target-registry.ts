/**
 * Target registry: resolves which QQ conversation an agent session belongs
 * to, so a caller (model or human) can address a proactive send without
 * knowing platform ids.
 *
 * Data sources (this registry imports no other plugin):
 *   1. own in-memory send cache: sessions this plugin recently sent for
 *   2. the on-disk model-preferences file (`~/.dsh-qqbot/model-prefs.json`
 *      by default): maps session keys `qqbot:<appId>:<kind>:<peerId>` to
 *      the dsh session id of the QQ session; keys whose kind is not one of
 *      the sendable scopes are skipped for resolution and omitted from the
 *      known list
 *   3. session-id derivation: a dsh session id is derived for a session key
 *      as the SHA-256 hex digest of the key, hyphenated into 8-4-4-4-12
 *      UUID form; a session that was never persisted under an explicit id
 *      still matches that derivation
 *
 * Matching is restricted to inventory keys whose appId equals the appId
 * this plugin is configured with (empty appId = credentials unresolved =
 * no matching at all). The `known` list is never filtered by appId: it is
 * a selection aid, not a resolution claim.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TARGET_SCOPES } from './targets.js';
import type { Logger, TargetRef, TargetScope } from './types.js';
import type { QQMessageSender } from './sender.js';

const KEY_PREFIX = 'qqbot:';

interface ParsedSessionKey {
  appId: string;
  kind: string;
  peerId: string;
}

export interface TargetRegistryOptions {
  /** The sender providing the in-memory send cache. */
  sender: QQMessageSender;
  /** Returns the resolved bot appId ('' when credentials are unavailable). */
  resolveAppId?: () => string;
  /** Path of the model-preferences inventory file. */
  prefsPath?: string;
  logger?: Logger;
}

interface ResolvedTarget {
  resolved: true;
  source: 'send-cache' | 'inventory';
  scope: string;
  targetId: string;
  target: string;
  known: TargetRef[];
}

interface UnresolvedTarget {
  resolved: false;
  source: 'none';
  known: TargetRef[];
  note: string;
}

/** Result of one resolution attempt. */
export type TargetResolution = ResolvedTarget | UnresolvedTarget;

/** SHA-256 hex digest of a value. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** SHA-256 hex digest in 8-4-4-4-12 UUID hyphenation. */
export function hyphenatedSessionId(key: string): string {
  const hex = sha256Hex(key);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Parse a session key of the form `qqbot:<appId>:<kind>:<peerId>`. The
 * peer id may itself contain colons; only the first two segments after the
 * prefix are appId and kind.
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
  readonly sender: QQMessageSender;
  readonly resolveAppId: () => string;
  readonly prefsPath: string;
  readonly logger?: Logger;

  constructor(options: TargetRegistryOptions) {
    this.sender = options.sender;
    this.resolveAppId = options.resolveAppId ?? (() => '');
    this.prefsPath = options.prefsPath ?? path.join(os.homedir(), '.dsh-qqbot', 'model-prefs.json');
    this.logger = options.logger;
  }

  /**
   * Read the `sessionIds` inventory from the model-preferences file. Only
   * string values are kept. Returns {} when the file is missing or the
   * table is absent.
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
   * Known sendable targets from the inventory: entries whose kind is one of
   * the sendable scopes (other kinds are omitted; the list is never
   * appId-filtered; a selection aid for explicit addressing).
   */
  knownTargets(): TargetRef[] {
    const known: TargetRef[] = [];
    for (const key of Object.keys(this.readInventory())) {
      const parsed = parseSessionKey(key);
      if (parsed !== null && TARGET_SCOPES.includes(parsed.kind as TargetScope)) {
        known.push({ scope: parsed.kind as TargetScope, targetId: parsed.peerId });
      }
    }
    return known;
  }

  /**
   * Resolve the QQ conversation of one agent session.
   * @param agentSessionId the dsh session id of the calling agent (undefined
   *        or empty when the call has no agent context)
   */
  resolve(agentSessionId: string | undefined): TargetResolution {
    const known = this.knownTargets();
    if (agentSessionId && agentSessionId.length > 0) {
      const cached = this.sender.cachedTarget(agentSessionId);
      if (cached) {
        return {
          resolved: true,
          source: 'send-cache',
          scope: cached.scope,
          targetId: cached.targetId,
          target: `${cached.scope}:${cached.targetId}`,
          known,
        };
      }
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
        if (agentSessionId === childId || agentSessionId === hyphenatedSessionId(key)) {
          return {
            resolved: true,
            source: 'inventory',
            scope: parsed.kind,
            targetId: parsed.peerId,
            target: `${parsed.kind}:${parsed.peerId}`,
            known,
          };
        }
      }
    }
    return {
      resolved: false,
      source: 'none',
      known,
      note: agentSessionId
        ? 'no matching record for this session'
        : 'no agent session context; send-cache and inventory matching skipped',
    };
  }
}
