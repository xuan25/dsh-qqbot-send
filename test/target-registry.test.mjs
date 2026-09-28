// Unit tests for the target registry (src/target-registry.ts, compiled to
// lib/): the zero-side-effect
// resolution chain that maps an agent session id to a QQ {scope, targetId}.
//
// Pinned regression vectors (field values captured on 2026-09-28): for bot
// appId 1905616003, the on-disk model-preferences inventory (model-prefs.json
// `sessionIds` table) contains the four (sessionKey, childSessionId) pairs
// below. The sha256-derived ids below were computed from the session keys
// with the 8-4-4-4-12 hyphenation rule used by hyphenatedSessionId.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  sha256Hex,
  hyphenatedSessionId,
  parseSessionKey,
  TargetRegistry,
} from '../lib/target-registry.js';

const APP_ID = '1905616003';

const INVENTORY = {
  [`qqbot:${APP_ID}:group:19EAE73811CD4F4A0C787019C093D5AF`]: '12f485dd-f4a7-4aa4-bc21-997b1c6b6f75',
  [`qqbot:${APP_ID}:c2c:67C17F1C1BEDEADACA3D75D80CC3742B`]: '6fac188f-270e-43a1-974b-d806c8f052e5',
  [`qqbot:${APP_ID}:group:F50BA9B6E8969A20152B7BC74BBD232B`]: 'c52902e1-b0b1-46a1-8510-0f5ad03ae355',
  [`qqbot:${APP_ID}:group:11CD8B207C511B63D2E4D0A812FB6215`]: 'e830e06f-da21-4d27-9b42-4b1af9d441ef',
  // A key belonging to a different bot: never matches (appId filter), but is
  // still listed in `known`.
  'qqbot:9999999999:group:OTHERAPPIDGROUP': 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000',
};

function makePrefsFile(dir, prefs) {
  const file = path.join(dir, 'model-prefs.json');
  writeFileSync(file, JSON.stringify(prefs, null, 2));
  return file;
}

function makeRegistry({ dir, prefs, appId = APP_ID, sender } = {}) {
  const prefsPath = prefs === undefined ? path.join(dir ?? tmpdir(), 'nonexistent-prefs.json') : makePrefsFile(dir, prefs);
  const senderObj = sender ?? {
    /** @type {Map<string, {scope: string, targetId: string}>} */
    sendCache: new Map(),
    cachedTarget(id) {
      return this.sendCache.get(id);
    },
  };
  return new TargetRegistry({
    sender: senderObj,
    resolveAppId: () => appId,
    prefsPath,
  });
}

test('sha256 + hyphenation pinned vectors (derived ids of the 2026-09-28 field keys)', () => {
  assert.equal(
    sha256Hex(`qqbot:${APP_ID}:group:19EAE73811CD4F4A0C787019C093D5AF`),
    '8666b31f4582f9916d7e9cd0a34d9a4f5893e161cc1b0a8b73efc3463cf6a10c',
  );
  assert.equal(
    hyphenatedSessionId(`qqbot:${APP_ID}:group:19EAE73811CD4F4A0C787019C093D5AF`),
    '8666b31f-4582-f991-6d7e-9cd0a34d9a4f',
  );
  assert.equal(
    hyphenatedSessionId(`qqbot:${APP_ID}:c2c:67C17F1C1BEDEADACA3D75D80CC3742B`),
    '6c92ce00-de60-4c10-217e-7b7a110fec37',
  );
  assert.equal(
    hyphenatedSessionId(`qqbot:${APP_ID}:group:F50BA9B6E8969A20152B7BC74BBD232B`),
    '2ee44808-0456-84a7-72fa-bf5dfa08f6db',
  );
  assert.equal(
    hyphenatedSessionId(`qqbot:${APP_ID}:group:11CD8B207C511B63D2E4D0A812FB6215`),
    'aae4064e-b2b0-5825-7105-6e35434366e6',
  );
});

test('parseSessionKey accepts well-formed keys and rejects malformed ones', () => {
  assert.deepEqual(parseSessionKey(`qqbot:${APP_ID}:group:19EAE73811CD4F4A0C787019C093D5AF`), {
    appId: APP_ID,
    kind: 'group',
    peerId: '19EAE73811CD4F4A0C787019C093D5AF',
  });
  // Peer id may itself contain colons: only the first two after the prefix
  // are appId and kind.
  assert.deepEqual(parseSessionKey(`qqbot:${APP_ID}:c2c:we:ird:id`), {
    appId: APP_ID,
    kind: 'c2c',
    peerId: 'we:ird:id',
  });
  assert.equal(parseSessionKey('group:123'), null); // no qqbot: prefix
  assert.equal(parseSessionKey(`qqbot:${APP_ID}:group`), null); // missing kind
  assert.equal(parseSessionKey(`qqbot:${APP_ID}:c2c:`), null); // empty peer id
});

test('branch 1: send-cache hit takes priority over the inventory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  const registry = makeRegistry({
    dir,
    prefs: { overrides: {}, sessionIds: INVENTORY, presets: {} },
  });
  try {
    const sid = 'web-session-xyz';
    registry.sender.sendCache.set(sid, { scope: 'group', targetId: 'CUSTOMTARGET' });
    // A different inventory-derived id for the same session would lose:
    const result = registry.resolve(sid);
    assert.equal(result.resolved, true);
    assert.equal(result.source, 'send-cache');
    assert.equal(result.scope, 'group');
    assert.equal(result.targetId, 'CUSTOMTARGET');
    assert.equal(result.target, 'group:CUSTOMTARGET');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('branch 2a: inventory hit via child session id (the session was forked)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  const registry = makeRegistry({ dir, prefs: { overrides: {}, sessionIds: INVENTORY, presets: {} } });
  try {
    const result = registry.resolve('12f485dd-f4a7-4aa4-bc21-997b1c6b6f75');
    assert.equal(result.resolved, true);
    assert.equal(result.source, 'inventory');
    assert.equal(result.scope, 'group');
    assert.equal(result.targetId, '19EAE73811CD4F4A0C787019C093D5AF');
    assert.equal(result.target, 'group:19EAE73811CD4F4A0C787019C093D5AF');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('branch 2b: inventory hit via sha256-derived (non-forked) session id', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  const registry = makeRegistry({ dir, prefs: { overrides: {}, sessionIds: INVENTORY, presets: {} } });
  try {
    const derived = hyphenatedSessionId(`qqbot:${APP_ID}:group:F50BA9B6E8969A20152B7BC74BBD232B`);
    const result = registry.resolve(derived);
    assert.equal(result.resolved, true);
    assert.equal(result.source, 'inventory');
    assert.equal(result.scope, 'group');
    assert.equal(result.targetId, 'F50BA9B6E8969A20152B7BC74BBD232B');
    // The pinned derived id must agree with the independently computed one:
    assert.equal(derived, '2ee44808-0456-84a7-72fa-bf5dfa08f6db');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keys of a different bot appId never match, but remain in the known list', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  const registry = makeRegistry({ dir, prefs: { overrides: {}, sessionIds: INVENTORY, presets: {} } });
  try {
    // The other-bot child id must NOT resolve for this bot.
    const result = registry.resolve('aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000');
    assert.equal(result.resolved, false);
    assert.equal(result.source, 'none');
    // ...but it is still listed in `known` (known is never appId-filtered).
    assert.ok(result.known.some((k) => k.scope === 'group' && k.targetId === 'OTHERAPPIDGROUP'));
    assert.equal(result.known.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('branch 3: unknown session id resolves to unresolved with the full known list', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  const registry = makeRegistry({ dir, prefs: { overrides: {}, sessionIds: INVENTORY, presets: {} } });
  try {
    const result = registry.resolve('00000000-1111-4222-8333-444455556666');
    assert.equal(result.resolved, false);
    assert.equal(result.source, 'none');
    assert.ok(result.note.includes('no matching record'));
    assert.deepEqual(
      result.known.map((k) => `${k.scope}:${k.targetId}`).sort(),
      [
        `c2c:67C17F1C1BEDEADACA3D75D80CC3742B`,
        `group:11CD8B207C511B63D2E4D0A812FB6215`,
        `group:19EAE73811CD4F4A0C787019C093D5AF`,
        `group:F50BA9B6E8969A20152B7BC74BBD232B`,
        `group:OTHERAPPIDGROUP`,
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no agent session context: matching branches skipped, note explains why', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  const registry = makeRegistry({ dir, prefs: { overrides: {}, sessionIds: INVENTORY, presets: {} } });
  try {
    const result = registry.resolve(undefined);
    assert.equal(result.resolved, false);
    assert.equal(result.source, 'none');
    assert.ok(result.note.includes('no agent session context'));
    assert.equal(result.known.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing or corrupt inventory file yields an empty known list and unresolved', () => {
  // Missing file (prefsPath points at a nonexistent path).
  const registryMissing = makeRegistry({ prefs: undefined });
  const r1 = registryMissing.resolve('12f485dd-f4a7-4aa4-bc21-997b1c6b6f75');
  assert.equal(r1.resolved, false);
  assert.deepEqual(r1.known, []);

  // Corrupt file.
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  try {
    writeFileSync(path.join(dir, 'model-prefs.json'), 'this is not json');
    const registryCorrupt = new TargetRegistry({
      sender: { sendCache: new Map(), cachedTarget() {} },
      resolveAppId: () => APP_ID,
      prefsPath: path.join(dir, 'model-prefs.json'),
    });
    const r2 = registryCorrupt.resolve('12f485dd-f4a7-4aa4-bc21-997b1c6b6f75');
    assert.equal(r2.resolved, false);
    assert.deepEqual(r2.known, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inventory entries with non-string values or malformed keys are skipped in known', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  try {
    const prefs = {
      overrides: {},
      sessionIds: {
        [`qqbot:${APP_ID}:group:VALIDGROUP`]: '11111111-2222-4333-8444-555566667777',
        'malformed-no-prefix': '12f485dd-f4a7-4aa4-bc21-997b1c6b6f75',
        [`qqbot:${APP_ID}:group:`]: '12f485dd-f4a7-4aa4-bc21-997b1c6b6f75', // empty peer id
        [`qqbot:${APP_ID}:unknownkind:PEER`]: '12f485dd-f4a7-4aa4-bc21-997b1c6b6f75',
      },
      presets: {},
    };
    const registry = makeRegistry({ dir, prefs });
    const result = registry.resolve('12f485dd-f4a7-4aa4-bc21-997b1c6b6f75');
    // The value collides with an entry that does not parse, so only VALIDGROUP parses;
    // 12f485dd... is not VALIDGROUP's child nor its derived id, hence unresolved.
    assert.equal(result.resolved, false);
    assert.deepEqual(result.known, [{ scope: 'group', targetId: 'VALIDGROUP' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
