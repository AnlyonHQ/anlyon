import { connect } from '../context';
import { fetchJson } from '../auth/http';
import { resolveBearer } from '../context';
import { usageError } from '../errors';
import type { CommandSpec } from './types';

export const whoami: CommandSpec = {
  path: ['whoami'],
  summary: 'Show who and where the current credential acts: user, workspace, environment.',
  async run(ctx) {
    if (ctx.args.length) throw usageError('whoami takes no arguments.');
    const { target, identity, environment } = await connect(ctx.globals, ctx.rt);

    let user: { email?: string; name?: string } | null = null;
    const userinfo = target.profile?.oauth?.userinfoEndpoint;
    if (userinfo && target.authType === 'oauth') {
      try {
        const bearer = await resolveBearer(target, ctx.rt);
        const response = await fetchJson(ctx.rt.fetch, userinfo, { method: 'GET', headers: { Authorization: `Bearer ${bearer}` }, signal: ctx.rt.signal });
        if (response.status === 200) {
          const body = response.body as { email?: unknown; name?: unknown };
          user = {
            ...(typeof body?.email === 'string' ? { email: body.email } : {}),
            ...(typeof body?.name === 'string' ? { name: body.name } : {}),
          };
        }
      } catch {
        user = null;
      }
    }

    const result = {
      profile: target.profileName ?? null,
      apiUrl: target.apiUrl,
      credentialType: identity.credentialType,
      apiKeyId: identity.apiKeyId,
      user,
      workspaceId: identity.workspaceId,
      environment: {
        id: environment.id,
        slug: environment.slug,
        name: environment.name,
        halted: environment.halted,
      },
      expiresAt: identity.expiresAt,
      role: identity.role ?? null,
    };
    if (ctx.out.json) return ctx.out.result(result);
    ctx.out.fields([
      ['profile', result.profile ?? '(ANLYON_API_KEY)'],
      ['api', result.apiUrl],
      ['credential', result.credentialType + (result.apiKeyId ? ` ${result.apiKeyId}` : '')],
      ['user', user?.email ?? user?.name ?? '-'],
      ['workspace', result.workspaceId],
      ['environment', `${environment.slug} (${environment.id})${environment.halted ? ' HALTED' : ''}`],
      ['role', result.role ?? '-'],
      ['expires', result.expiresAt ?? 'never'],
    ]);
  },
};
