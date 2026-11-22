#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startFakeAnlyon, completeBrowserLogin, WORKSPACE_ID } from '../test/fixtures/fake-anlyon.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const binaryArg = flag('--binary');
const tarballArg = flag('--npm-tarball');
const storeArg = flag('--store');
if (!binaryArg === !tarballArg) {
  console.error('usage: smoke.mjs (--binary <path> | --npm-tarball <path>) [--store file]');
  process.exit(2);
}

const isWindows = process.platform === 'win32';
const work = mkdtempSync(join(tmpdir(), 'anlyon-smoke-'));
const configDir = join(work, 'config');
const profile = `smoke-${randomBytes(4).toString('hex')}`;
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

let command;
let prefixArgs = [];
if (binaryArg) {
  const target = join(work, basename(binaryArg));
  copyFileSync(resolve(binaryArg), target);
  if (!isWindows) chmodSync(target, 0o755);
  command = target;
  check('install: binary copied to a clean directory', statSync(target).size > 0, target);
} else {
  const tarball = resolve(tarballArg);
  const install = spawnSync('npm', ['install', '--prefix', work, '--no-audit', '--no-fund', '--ignore-scripts', tarball], {
    stdio: 'inherit',
    shell: isWindows,
  });
  check('install: npm install of the tarball', install.status === 0);
  if (isWindows) {
    command = process.execPath;
    prefixArgs = [join(work, 'node_modules', '@anlyonhq', 'cli', 'dist', 'anlyon.js')];
  } else {
    command = join(work, 'node_modules', '.bin', 'anlyon');
  }
  const deps = readdirSync(join(work, 'node_modules')).filter((d) => !d.startsWith('.'));
  check('install: no runtime dependencies were pulled in', deps.length === 1 && deps[0] === '@anlyonhq', deps.join(','));
}

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ANLYON_'))),
  ANLYON_CONFIG_DIR: configDir,
  ANLYON_PROFILE: profile,
  ANLYON_NO_BROWSER: '1',
  ...(storeArg ? { ANLYON_CREDENTIAL_STORE: storeArg } : {}),
};

function run(argv, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, [...prefixArgs, ...argv], { cwd: options.cwd ?? work, env: { ...env, ...(options.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      options.onStderr?.(stderr, child);
    });
    child.stdin.end(options.stdin ?? '');
    options.onSpawn?.(child);
    child.on('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

const CONFIG_KEY = 'anlyon_test_xxxsmokeconfig0000000000';
const server = await startFakeAnlyon({
  apiKeys: { [CONFIG_KEY]: { scopes: ['actions:read', 'actions:write', 'secrets:read', 'policies:read', 'policies:write', 'impact-limits:read', 'impact-limits:write'] } },
});
const secretsSeen = () => [...server.state.accessTokens.keys(), ...server.state.refreshTokens.keys(), ...server.state.mintedKeys.map((k) => k.key)];
const browser = () => {
  let started = false;
  return (text) => {
    const match = /^\s+(http:\/\/127\.0\.0\.1:\d+\/api\/auth\/oauth2\/authorize\S+)/m.exec(text);
    if (match && !started) {
      started = true;
      completeBrowserLogin(match[1]).catch((error) => console.error('browser step failed', error));
    }
  };
};
const outputs = [];

try {
  const version = await run(['--version', '--json']);
  outputs.push(version);
  const v = version.code === 0 ? JSON.parse(version.stdout) : {};
  check('version: runs with no repository, reports CLI and SDK', version.code === 0 && Boolean(v.cli && v.sdk), `${v.cli} sdk ${v.sdk} ${v.runtime}`);

  let browserStarted = false;
  const login = await run(['auth', 'login', '--api-url', server.origin, '--json'], {
    onStderr(text) {
      const match = /^\s+(http:\/\/127\.0\.0\.1:\d+\/api\/auth\/oauth2\/authorize\S+)/m.exec(text);
      if (match && !browserStarted) {
        browserStarted = true;
        completeBrowserLogin(match[1]).catch((error) => console.error('browser step failed', error));
      }
    },
  });
  outputs.push(login);
  const loginOut = login.code === 0 ? JSON.parse(login.stdout) : {};
  check('login: browser authorization with PKCE + loopback', login.code === 0 && loginOut.workspaceId === WORKSPACE_ID, login.code === 0 ? `store=${loginOut.credentialStore}` : login.stderr.trim());
  check('login: credential went to the expected store', login.code === 0 && (storeArg ? loginOut.credentialStore === storeArg : loginOut.credentialStore !== 'file'), loginOut.credentialStore);

  const who = await run(['whoami', '--json']);
  outputs.push(who);
  check('whoami: resolves workspace and environment', who.code === 0 && JSON.parse(who.stdout || '{}').environment?.slug === 'production', who.stderr.trim());

  const doctor = await run(['doctor', '--json']);
  outputs.push(doctor);
  const doctorOut = JSON.parse(doctor.stdout || '{}');
  check('doctor: all checks pass', doctor.code === 0 && doctorOut.ok === true, (doctorOut.checks ?? []).filter((c) => c.status !== 'ok').map((c) => `${c.name}: ${c.status} ${c.detail}`).join('; '));

  server.state.accessTokens.clear();
  server.state.accessTtlSeconds = 30;
  const rejected = await run(['runs', 'list', '--json']);
  outputs.push(rejected);
  check('refresh: a rejected access token is refreshed once and the call retried', rejected.code === 0 && server.state.counts.refresh === 1, `refreshes ${server.state.counts.refresh}`);
  const before = server.state.counts.refresh;
  const parallel = await Promise.all(Array.from({ length: 4 }, () => run(['runs', 'list', '--json'])));
  outputs.push(...parallel);
  const refreshed = server.state.counts.refresh - before;
  check(
    'refresh: 4 concurrent processes each refresh, serialised, with no refresh-token reuse',
    parallel.every((r) => r.code === 0) && refreshed === 4 && server.state.counts.reuseDetected === 0,
    `exit codes ${parallel.map((r) => r.code).join(',')}; refreshes ${refreshed}; reuse ${server.state.counts.reuseDetected}`,
  );

  const denied = await run(['policies', 'list', '--json']);
  outputs.push(denied);
  check('exit 4: a scope browser login cannot grant', denied.code === 4 && denied.stdout === '' && JSON.parse(denied.stderr).error.status === 403);
  const effectsBefore = server.state.requests.length;
  const effectsCmd = await run(['effects', 'list', '--json']);
  outputs.push(effectsCmd);
  check(
    'effects list: reads GET /api/v2/actions/effects on this server',
    server.state.requests.slice(effectsBefore).some((r) => r.method === 'GET' && r.path === '/api/v2/actions/effects'),
  );
  const mismatch = await run(['runs', 'list', '--environment', 'staging', '--json']);
  outputs.push(mismatch);
  check('exit 10: --environment never overrides the binding', mismatch.code === 10);

  const dispatchedBefore = server.state.dispatches;
  const invokeArgs = ['actions', 'invoke', 'send_receipt', '--data', '{"order":"9921"}', '--idempotency-key', `smoke-${profile}`, '--yes', '--json'];
  const first = await run(invokeArgs);
  const replay = await run(invokeArgs);
  outputs.push(first, replay);
  const firstId = first.code === 0 ? JSON.parse(first.stdout).data.id : undefined;
  check(
    'write: invoke succeeds; a replay with the same key returns it and dispatches nothing',
    first.code === 0 && replay.code === 0 && JSON.parse(replay.stdout || '{}').data?.id === firstId && server.state.dispatches === dispatchedBefore + 1,
    `dispatches ${server.state.dispatches - dispatchedBefore}`,
  );
  const unconfirmed = await run(['actions', 'invoke', 'send_receipt', '--data', '{}']);
  outputs.push(unconfirmed);
  check('write: refused without --yes when not interactive (exit 2)', unconfirmed.code === 2 && server.state.dispatches === dispatchedBefore + 1);
  const flaky = await run(['actions', 'invoke', 'flaky_refund', '--yes', '--json']);
  outputs.push(flaky);
  check('exit 13: an uncertain outcome is reported as unknown, not failed', flaky.code === 13 && JSON.parse(flaky.stdout).data.status === 'unknown');

  server.state.apiDelayMs = 3000;
  const timeout = await run(['actions', 'list', '--timeout', '400ms', '--json']);
  outputs.push(timeout);
  check('exit 9: --timeout', timeout.code === 9, `got ${timeout.code}`);
  if (isWindows) {
    check('exit 130: Ctrl-C (not verified on Windows: no POSIX SIGINT delivery to a child)', true, 'skipped');
  } else {
    const cancelled = await run(['actions', 'list', '--json'], {
      onSpawn(child) {
        setTimeout(() => child.kill('SIGINT'), 1000);
      },
    });
    outputs.push(cancelled);
    check('exit 130: SIGINT cancels the request', cancelled.code === 130, `got ${cancelled.code} ${cancelled.signal ?? ''}`);
  }
  server.state.apiDelayMs = 0;

  const project = join(work, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'smoke-app' }));
  const init = await run(['init', '--yes', '--api-url', server.origin, '--mcp', 'claude,cursor,codex', '--no-install', '--json'], { cwd: project, onStderr: browser() });
  outputs.push(init);
  const initOut = init.code === 0 ? JSON.parse(init.stdout).data : {};
  const envFile = existsSync(join(project, '.env')) ? readFileSync(join(project, '.env'), 'utf8') : '';
  check('init: signs in, writes the key to .env (never printed), ignores .env*', init.code === 0 && /ANLYON_API_KEY=anlyon_test_/.test(envFile) && readFileSync(join(project, '.gitignore'), 'utf8').includes('.env*'), init.stderr.trim().split(/\r?\n/).at(-1));
  check('init: MCP config for Claude Code, Cursor and Codex', ['.mcp.json', join('.cursor', 'mcp.json'), join('.codex', 'config.toml')].every((f) => existsSync(join(project, f))));
  check('init: a governed read with the project key, with a receipt', initOut.smoke?.outcome === 'succeeded' && /^eff_/.test(initOut.smoke?.receiptId ?? ''), JSON.stringify(initOut.smoke ?? {}));
  const again = await run(['init', '--yes', '--api-url', server.origin, '--mcp', 'claude', '--no-install', '--json'], { cwd: project });
  outputs.push(again);
  check('init: a second run changes nothing and mints no key', again.code === 0 && JSON.parse(again.stdout || '{}').data?.key?.outcome === 'kept' && server.state.mintedKeys.length === 1);

  writeFileSync(join(project, 'anlyon.yaml'), ['version: 1', 'environments:', '  production:', '    limits:', '      Emails per day: { dimension: emails, amount: 100, period: day }', ''].join('\r\n'));
  const configEnv = { env: { ANLYON_API_KEY: CONFIG_KEY, ANLYON_API_URL: server.origin, ANLYON_PROFILE: '' }, cwd: project };
  const plan = await run(['plan', '--json'], configEnv);
  outputs.push(plan);
  const planOut = plan.code === 0 ? JSON.parse(plan.stdout).data : {};
  check('plan: marks lowering a limit as tightening', planOut.changes?.[0]?.direction === 'tightening', plan.stderr.trim());
  const apply = await run(['apply', '--yes', '--json'], configEnv);
  outputs.push(apply);
  check('apply: applies it', apply.code === 0 && server.state.impactLimits.find((l) => l.name === 'Emails per day')?.limit === 100, apply.stderr.trim());
  const pull = await run(['pull', '--yes'], configEnv);
  outputs.push(pull);
  check("pull: keeps the file's CRLF line endings", pull.code === 0 && readFileSync(join(project, 'anlyon.yaml'), 'utf8').includes('\r\n'), pull.stderr.trim());

  const billing = await run(['billing', 'status', '--json']);
  outputs.push(billing);
  check('billing status: plan and usage', billing.code === 0 && JSON.parse(billing.stdout || '{}').data?.plan === 'free', billing.stderr.trim());
  const upgrade = await run(['billing', 'upgrade', '--plan', 'starter', '--json']);
  outputs.push(upgrade);
  check('billing upgrade: prints the checkout link', upgrade.code === 0 && JSON.parse(upgrade.stdout || '{}').data?.checkoutUrl?.endsWith('/checkout/starter'), upgrade.stderr.trim());

  const secrets = secretsSeen();
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(configDir);
  const onDisk = files.filter((f) => !(storeArg === 'file' && f.includes(`${join('config', 'credentials')}`))).map((f) => readFileSync(f, 'utf8'));
  const leakedToDisk = secrets.some((s) => onDisk.some((text) => text.includes(s)));
  const leakedToOutput = secrets.some((s) => outputs.some((o) => o.stdout.includes(s) || o.stderr.includes(s)));
  check('secrets: none in config files', !leakedToDisk, `${files.length} files checked`);
  check('secrets: none in any stdout/stderr', !leakedToOutput, `${outputs.length} runs checked`);

  const logout = await run(['auth', 'logout', '--forget', '--json']);
  const logoutOut = JSON.parse(logout.stdout || '{}');
  check('logout: refresh token revoked server-side, local credential deleted', logout.code === 0 && logoutOut.revoked === true && logoutOut.deleted === true);
  const after = await run(['auth', 'status', '--json']);
  check('logout: status now reports not logged in (exit 3)', after.code === 3);
} finally {
  await run(['auth', 'logout', '--forget']).catch(() => {});
  await server.close();
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${results.length - failures}/${results.length} checks passed on ${process.platform}/${process.arch}`);
process.exit(failures ? 1 : 0);
