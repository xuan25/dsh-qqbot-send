// Deployment-environment smoke test: fetches ONE access token through the
// real SDK TokenManager chain (appId/appSecret from the environment or an
// explicit --secret argument). Sends no messages.
//
// Skips cleanly when credentials are unavailable (e.g. a plain development
// checkout without QQBOT_SECRET), so `node --test` stays green there.
//
// In the deployed plugin directory the SDK resolves through the plugin's own
// node_modules symlink; outside the deployment (bare checkout) pass the SDK
// location via --sdk-dir or env QQBOT_SDK_DIR, otherwise the test skips.

import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';

async function loadTokenManager() {
  try {
    const mod = await import('@tencent-connect/qqbot-nodejs/protocol');
    return mod.TokenManager;
  } catch {
    // Bare checkout: try an explicitly supplied SDK location.
    const dir =
      process.argv.find((a) => a.startsWith('--sdk-dir='))?.slice('--sdk-dir='.length) ??
      process.env.QQBOT_SDK_DIR;
    if (dir) {
      const mod = await import(`file://${dir}/dist/protocol/index.js`);
      return mod.TokenManager;
    }
    return null;
  }
}

test('token smoke: TokenManager obtains an access token (no messages sent)', async (t) => {
  const appId = process.env.QQBOT_APPID ?? '';
  const secret =
    process.argv.find((a) => a.startsWith('--secret='))?.slice('--secret='.length) ??
    (process.env.QQBOT_SECRET ?? '');

  if (!appId || !secret) {
    t.skip('QQBOT_APPID/QQBOT_SECRET not available in this environment (deploy-time check)');
    return;
  }

  const TokenManager = await loadTokenManager();
  if (!TokenManager) {
    t.skip('SDK not resolvable here and no --sdk-dir/QQBOT_SDK_DIR given (deploy-time check)');
    return;
  }

  // Mirror the plugin's resolveEnv() for the env-only case: a configured
  // value that is a placeholder (__FROM_ENV__, or a process.env. reference)
  // falls back to the process environment (an identity here, because the
  // config source and the env key are the same variable; a plain value is
  // used as-is. Then normalize (trim, trailing slashes stripped) and fall
  // back to the QQ Open Platform default; without an explicit base URL the
  // SDK would hit its own default host instead.
  const raw = process.env.QQBOT_TOKEN_BASE_URL ?? '';
  const value =
    raw === '' || raw === '__FROM_ENV__' || raw.startsWith('process.env')
      ? (process.env.QQBOT_TOKEN_BASE_URL ?? '')
      : raw;
  const stripped = value.trim().replace(/\/+$/, '');
  const tokenBaseUrl = stripped === '' ? 'https://api.bot.qq.com' : stripped;

  const tokenManager = new TokenManager({
    userAgent: 'dsh-qqbot-send/token-smoke',
    baseUrl: tokenBaseUrl,
  });
  const token = await tokenManager.getAccessToken(appId, secret);
  assert.ok(typeof token === 'string' && token.length > 0, 'expected a non-empty access token');
  t.diagnostic?.(`obtained access token, length=${token.length}`);
  console.log(`[token-smoke] OK: access token obtained (length=${token.length})`);
});
