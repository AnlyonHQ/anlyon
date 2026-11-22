import { access, constants } from 'node:fs/promises';
import { connect, resolveTarget, type Target } from '../context';
import { discover } from '../auth/discovery';
import { probeStore } from '../credentials/store';
import { toCliError, usageError } from '../errors';
import { EXIT } from '../exit-codes';
import { CLI_VERSION, SDK_VERSION, runtimeDescription } from '../version';
import type { CommandSpec } from './types';

type Status = 'ok' | 'warn' | 'fail' | 'skip';
interface Check {
  name: string;
  status: Status;
  detail: string;
}

/**
 * Diagnose the local install and the path to the API, one check per layer, in
 * the order a command resolves them. Exit 0 when nothing failed, 1 otherwise.
 */
export const doctor: CommandSpec = {
  path: ['doctor'],
  summary: 'Check the install, config, credential store, API reachability and credential.',
  async run(ctx) {
    if (ctx.args.length) throw usageError('doctor takes no arguments.');
    const checks: Check[] = [];
    const add = (name: string, status: Status, detail: string) => checks.push({ name, status, detail });

    add('version', 'ok', `anlyon ${CLI_VERSION}, @anlyonhq/sdk ${SDK_VERSION}, ${runtimeDescription()} (${ctx.rt.platform}/${process.arch})`);

    try {
      await ctx.rt.config.read();
      const writable = await access(ctx.rt.config.dir, constants.W_OK).then(
        () => true,
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
      add('config', writable ? 'ok' : 'fail', `${ctx.rt.config.file}${writable ? '' : ' (directory not writable)'}`);
    } catch (error) {
      add('config', 'fail', toCliError(error).message);
    }

    let target: Target | undefined;
    try {
      target = await resolveTarget(ctx.globals, ctx.rt);
      add(
        'target',
        'ok',
        target.profileName
          ? `profile "${target.profileName}" (from ${target.profileSource}) → ${target.apiUrl}${target.profile ? '' : ' (not logged in)'}`
          : `ANLYON_API_KEY → ${target.apiUrl}`,
      );
    } catch (error) {
      add('target', 'fail', toCliError(error).message);
    }

    if (target?.credentialSource === 'env:ANLYON_API_KEY') {
      add('credential store', 'skip', 'not used: credential comes from ANLYON_API_KEY');
    } else {
      try {
        const store = ctx.rt.credentialStore();
        const probe = await probeStore(store);
        add('credential store', probe.ok ? (store.secure ? 'ok' : 'warn') : 'fail', probe.ok && !store.secure ? `${probe.detail} (NOT encrypted, opt-in)` : probe.detail);
      } catch (error) {
        add('credential store', 'fail', toCliError(error).message);
      }
    }

    if (target) {
      try {
        const response = await ctx.rt.fetch(`${target.apiUrl}/health`, { signal: ctx.rt.signal });
        const date = response.headers.get('date');
        await response.body?.cancel().catch(() => {});
        add('api', response.ok ? 'ok' : 'fail', `${target.apiUrl}/health → HTTP ${response.status}`);
        if (date) {
          const skew = Math.round((Date.now() - new Date(date).getTime()) / 1000);
          add('clock', Math.abs(skew) > 120 ? 'warn' : 'ok', `local clock is ${skew}s ${skew >= 0 ? 'ahead of' : 'behind'} the server`);
        }
      } catch (error) {
        add('api', 'fail', toCliError(error, ctx.rt.abortState).message);
      }

      if (target.authType === 'oauth' && target.credentialSource === 'profile') {
        try {
          const server = await discover(target.apiUrl, ctx.rt.fetch, ctx.rt.signal);
          const pinned = target.profile?.oauth;
          const changed = pinned && (pinned.issuer !== server.issuer || pinned.tokenEndpoint !== server.tokenEndpoint);
          add('oauth', changed ? 'warn' : 'ok', changed ? `issuer or token endpoint changed since login (${server.issuer}). Log in again` : `issuer ${server.issuer}`);
        } catch (error) {
          add('oauth', 'fail', toCliError(error, ctx.rt.abortState).message);
        }
      }

      if (target.profile || target.credentialSource === 'env:ANLYON_API_KEY') {
        try {
          const { identity, environment } = await connect(ctx.globals, ctx.rt);
          add('credential', 'ok', `${identity.credentialType}, workspace ${identity.workspaceId}, environment ${environment.slug} (${environment.id})`);
          if (environment.halted) add('environment', 'warn', `environment ${environment.slug} is halted`);
        } catch (error) {
          const failure = toCliError(error, ctx.rt.abortState);
          add('credential', 'fail', `${failure.message}${failure.hint ? ` ${failure.hint}` : ''}`);
        }
      } else {
        add('credential', 'fail', 'not logged in. Run `anlyon auth login`');
      }
    }

    const failed = checks.some((check) => check.status === 'fail');
    if (ctx.out.json) {
      ctx.out.result({ ok: !failed, checks });
    } else {
      const width = Math.max(...checks.map((check) => check.name.length));
      for (const check of checks) ctx.out.line(`${check.status.toUpperCase().padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}`);
    }
    return failed ? EXIT.ERROR : EXIT.OK;
  },
};
