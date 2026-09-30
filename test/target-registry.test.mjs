// Unit tests for the target registry (src/target-registry.ts, compiled to
// lib/): the zero-side-effect resolution that value-matches an agent
// session id against the on-disk model-preferences inventory.
//
// Pinned regression vectors (field values captured on 2026-09-28): for bot
// appId 1905616003, the on-disk model-preferences inventory (model-prefs.json
// `sessionIds` table) contains the four (sessionKey, childSessionId) pairs
// below, used as opaque identifiers only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseSessionKey, TargetRegistry } from '../lib/target-registry.js';

const APP_ID = '1905616003';

const INVENTORY = {
  [`qqbot:${APP_ID}:group:19EAE73811CD4F4A0C787019C093D5AF`]: '12f485dd-f4a7-4aa4-bc21-997b1c6b6f75',
  [`qqbot:${APP_ID}:c2c:67C17F1C1BEDEADACA3D75D80CC3742B`]: '6fac188f-270e-43a1-974b-d806c8f052e5',
  [`qqbot:${APP_ID}:group:F50BA9B6E8969A20152B7BC74BBD232B`]: 'c52902e1-b0b1-46a1-8510-0f5ad03ae355',
  [`qqbot:${APP_ID}:group:11CD8B207C511B63D2E4D0A812FB6215`]: 'e830e06f-da21-4d27-9b42-4b1af9d441ef',
  // A key belonging to a different bot: never matches (appId filter).
  'qqbot:9999999999:group:OTHERAPPIDGROUP': 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000',
};

function makePrefsFile(dir, prefs) {
  const file = path.join(dir, 'model-prefs.json');
  writeFileSync(file, JSON.stringify(prefs, null, 2));
  return file;
}

function makeRegistry({ dir, prefs, appId = APP_ID } = {}) {
  const prefsPath = prefs === undefined ? path.join(dir ?? tmpdir(), 'nonexistent-prefs.json') : makePrefsFile(dir, prefs);
  return new TargetRegistry({
    resolveAppId: () => appId,
    prefsPath,
  });
}

test('parseSessionKey accepts well-formed keys and rejects malformed ones', () => {
  assert.deepEqual(parseSessionKey(`qqbot:${APP_ID}:group:19EAE73811CD4F4A0C787019C093D5AF`), {
    appId: APP_ID,
    kind: 'group',
    peerId: '19EAE73811CD4F4A0C787019C093D5AF',
  });
  // Peer id may itself contain colons: only the first two segments after the
  // prefix are appId and kind.
  assert.deepEqual(parseSessionKey(`qqbot:${APP_ID}:c2c:we:ird:id`), {
    appId: APP_ID,
    kind: 'c2c',
    peerId: 'we:ird:id',
  });
  assert.equal(parseSessionKey('group:123'), null); // no qqbot: prefix
  assert.equal(parseSessionKey(`qqbot:${APP_ID}:group`), null); // missing kind
  assert.equal(parseSessionKey(`qqbot:${APP_ID}:c2c:`), null); // empty peer id
});

test('resolves when the agent session id value-matches a stored inventory value', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  const registry = makeRegistry({ dir, prefs: { overrides: {}, sessionIds: INVENTORY, presets: {} } });
  try {
    const result = registry.resolve('12f485dd-f4a7-4aa4-bc21-997b1c6b6f75');
    assert.deepEqual(result, {
      resolved: true,
      scope: 'group',
      targetId: '19EAE73811CD4F4A0C787019C093D5AF',
      target: 'group:19EAE73811CD4F4A0C787019C093D5AF',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a c2c entry also resolves by stored value', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  const registry = makeRegistry({ dir, prefs: { overrides: {}, sessionIds: INVENTORY, presets: {} } });
  try {
    const result = registry.resolve('6fac188f-270e-43a1-974b-d806c8f052e5');
    assert.deepEqual(result, {
      resolved: true,
      scope: 'c2c',
      targetId: '67C17F1C1BEDEADACA3D75D80CC3742B',
      target: 'c2c:67C17F1C1BEDEADACA3D75D80CC3742B',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session ids not present as stored values miss (no derivation branch)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  const registry = makeRegistry({ dir, prefs: { overrides: {}, sessionIds: INVENTORY, presets: {} } });
  try {
    // Pinned literal: not a value of any table entry, so it can only
    // resolve by value match, never by derivation from a session key.
    const result = registry.resolve('2ee44808-0456-84a7-72fa-bf5dfa08f6db');
    assert.deepEqual(result, { resolved: false, note: 'no matching record for this session' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('entries of a different bot appId never match', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  const registry = makeRegistry({ dir, prefs: { overrides: {}, sessionIds: INVENTORY, presets: {} } });
  try {
    const result = registry.resolve('aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000');
    assert.deepEqual(result, { resolved: false, note: 'no matching record for this session' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown session id resolves to unresolved', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  const registry = makeRegistry({ dir, prefs: { overrides: {}, sessionIds: INVENTORY, presets: {} } });
  try {
    const result = registry.resolve('00000000-1111-4222-8333-444455556666');
    assert.deepEqual(result, { resolved: false, note: 'no matching record for this session' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no agent session context skips resolution', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  const registry = makeRegistry({ dir, prefs: { overrides: {}, sessionIds: INVENTORY, presets: {} } });
  try {
    assert.deepEqual(registry.resolve(undefined), {
      resolved: false,
      note: 'no agent session context; resolution skipped',
    });
    assert.deepEqual(registry.resolve(''), {
      resolved: false,
      note: 'no agent session context; resolution skipped',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing inventory file yields a miss', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  try {
    const registry = makeRegistry({ dir, prefs: undefined });
    const result = registry.resolve('12f485dd-f4a7-4aa4-bc21-997b1c6b6f75');
    assert.deepEqual(result, { resolved: false, note: 'no matching record for this session' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt inventory file yields a miss', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  try {
    writeFileSync(path.join(dir, 'model-prefs.json'), 'this is not json');
    const registry = new TargetRegistry({
      resolveAppId: () => APP_ID,
      prefsPath: path.join(dir, 'model-prefs.json'),
    });
    const result = registry.resolve('12f485dd-f4a7-4aa4-bc21-997b1c6b6f75');
    assert.deepEqual(result, { resolved: false, note: 'no matching record for this session' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed inventory entries are skipped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qqsend-test-'));
  try {
    const prefs = {
      overrides: {},
      sessionIds: {
        [`qqbot:${APP_ID}:group:VALIDGROUP`]: '11111111-2222-4333-8444-555566667777',
        'malformed-no-prefix': '12f485dd-f4a7-4aa4-bc21-997b1c6b6f75',
        [`qqbot:${APP_ID}:group:`]: '12f485dd-f4a7-4aa4-bc21-997b1c6b6f75', // empty peer id
        [`qqbot:${APP_ID}:unknownkind:PEER`]: '12f485dd-f4a7-4aa4-bc21-997b1c6b6f75',
        'not-a-string-value': 42,
      },
      presets: {},
    };
    const registry = makeRegistry({ dir, prefs });
    const hit = registry.resolve('11111111-2222-4333-8444-555566667777');
    assert.deepEqual(hit, {
      resolved: true,
      scope: 'group',
      targetId: 'VALIDGROUP',
      target: 'group:VALIDGROUP',
    });
    // The value collides only with entries that do not parse, so it misses.
    const miss = registry.resolve('12f485dd-f4a7-4aa4-bc21-997b1c6b6f75');
    assert.deepEqual(miss, { resolved: false, note: 'no matching record for this session' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
