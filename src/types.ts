/**
 * Local shared types for dsh-qqbot-send. Framework types are not re-exported
 * here; each module imports them directly from the defining package (cordis,
 * dsh-tools).
 */

/** Minimal logger consumed by this plugin. */
export interface Logger {
  debug?(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** QQ conversation scope (platform target kind). */
export type TargetScope = 'c2c' | 'group' | 'channel' | 'dm';

/** A parsed send target. */
export interface TargetRef {
  scope: TargetScope;
  targetId: string;
}

/** Canonical result of one proactive send. */
export interface SendResult {
  scope: TargetScope;
  target: string;
  format: 'markdown' | 'text';
  totalChunks: number;
  sentChunks: number;
  messageIds: string[];
  /** '' on full success; human-readable failure/abort note otherwise. */
  note: string;
}
