import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { parse as parseYaml } from 'yaml';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const id = (prefix) => `${prefix}${randomBytes(9).toString('hex')}`;
const healthy = () => ({ status: 'active', checkedAt: new Date().toISOString(), reason: null });

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
export const ENVIRONMENTS = {
  production: { id: '22222222-2222-4222-8222-222222222222', slug: 'production', name: 'Production' },
  staging: { id: '33333333-3333-4333-8333-333333333333', slug: 'staging', name: 'Staging' },
};

const GROUPS = {
  'anlyon:actions': ['actions:read', 'actions:write', 'actions:invoke', 'approvals:read', 'approvals:write', 'impact-limits:read'],
  'anlyon:observability': ['runs:read', 'runs:write', 'logs:read', 'analytics:read', 'billing:read', 'notifications:read', 'notifications:write', 'feedback:write'],
  'anlyon:approvals.decide': ['approvals:decide'],
  'anlyon:secrets': ['secrets:read', 'secrets:write'],
  'anlyon:budgets': ['budgets:read', 'budgets:write'],
  'anlyon:keys': [],
  'anlyon:guardrails': ['policies:read', 'policies:write', 'impact-limits:write'],
};
const STANDARD_AGENT_KEY_SCOPES = [...new Set(['anlyon:actions', 'anlyon:events', 'anlyon:observability'].flatMap((group) => GROUPS[group] ?? []))];

export async function startFakeAnlyon(options = {}) {
  const state = {
    accessTtlSeconds: options.accessTtlSeconds ?? 900,
    environment: options.environment ?? 'production',
    clients: new Map(),
    codes: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
    apiKeys: new Map(Object.entries(options.apiKeys ?? {})),
    counts: { register: 0, token: 0, refresh: 0, revoke: 0, reuseDetected: 0 },
    requests: [],
    actions: options.actions ?? Array.from({ length: 5 }, (_, i) => ({ id: `act_${i}`, name: `action-${i}`, method: 'POST', enabled: true, requiresApproval: i % 2 === 0 })),
    runs: options.runs ?? Array.from({ length: 7 }, (_, i) => ({ id: `run_${i}`, name: `run ${i}`, status: 'succeeded', startedAt: new Date(0).toISOString() })),
    refreshDelayMs: options.refreshDelayMs ?? 0,
    invocations: new Map(),
    idempotency: new Map(),
    approvals: new Map(),
    dispatches: 0,
    effects: options.effects ?? [
      { id: 'eff_1', invocationId: 'inv_1', action: { id: 'act_0', name: 'action-0' }, adapter: null, stage: 'completed', outcome: 'succeeded', grade: 'confirmed', verification: 'provider_verified', createdAt: new Date(0).toISOString() },
      { id: 'eff_2', invocationId: 'inv_2', action: { id: 'act_0', name: 'action-0' }, adapter: null, stage: 'completed', outcome: 'succeeded', grade: 'acknowledged', verification: 'unverified', createdAt: new Date(0).toISOString() },
      { id: 'eff_3', invocationId: 'inv_3', action: { id: 'act_1', name: 'action-1' }, adapter: null, stage: 'dispatched', outcome: 'unknown', grade: 'unknown', verification: 'unverified', createdAt: new Date(0).toISOString() },
    ],
    impactLimits: options.impactLimits ?? [
      { id: 'lim_1', name: 'Refunds per day', dimension: 'money', currency: 'usd', unit: 'usd', scope: { actionName: null, resourcePrefix: null }, period: 'day', limit: 50000, consumed: 1200, reserved: 0, unknownExposure: 0 },
      { id: 'lim_2', name: 'Emails per day', dimension: 'emails', currency: null, unit: 'emails', scope: { actionName: null, resourcePrefix: null }, period: 'day', limit: 500, consumed: 40, reserved: 2, unknownExposure: 0 },
    ],
    declared: [],
    connectSessions: new Map(),
    keyConnects: [],
    consentAfterPolls: options.consentAfterPolls ?? 1,
    secrets: options.secrets ?? [],
    checkAnswer: options.checkAnswer ?? 'accepted',
    checks: [],
    reconnects: [],
    apiDelayMs: options.apiDelayMs ?? 0,
    mintedKeys: [],
    filePolicies: new Map(),
    budgets: options.budgets ?? [],
    signOff: options.signOff === true,
    gateSignOffs: new Map(),
    plan: options.plan ?? 'free',
    checkouts: [],
    signOffs: new Map(),
    mcpUpstreams: [],
    mcpListing: [
      { name: 'delete_issue', hash: 'hash-delete', definition: { name: 'delete_issue', description: 'Deletes an issue.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }, suggestedClass: 'destructive', reasons: [] },
      { name: 'list_issues', hash: 'hash-list', definition: { name: 'list_issues', description: 'Lists issues.', inputSchema: { type: 'object', properties: {} } }, suggestedClass: 'read', reasons: [] },
    ],
    changeMcpTool: (name) => {
      state.mcpListing = state.mcpListing.map((tool) => (tool.name === name ? { ...tool, hash: `${tool.hash}-changed` } : tool));
    },
    autoApproveGate: false,
  };
  let origin = '';

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const apiError = (res, status, code, message, fix) => json(res, status, { success: false, error: { code, message, ...(fix ? { fix } : {}) } });
  const applyDeclarations = (action, body) => {
    if (body.governed === false) Object.assign(action, { impact: null, verify: null, governed: false });
    else {
      if (body.impact !== undefined) action.impact = body.impact && { unit: body.impact.dimension, ...body.impact };
      if (body.verify !== undefined) action.verify = body.verify && { match: [], ...body.verify };
      action.governed = Boolean(body.governed || action.governed || action.impact || action.verify);
    }
  };
  const loosens = (body) => body.governed === false || body.impact === null || body.verify === null;
  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  };
  const form = async (req) => Object.fromEntries(new URLSearchParams(await readBody(req)));

  function issueTokens(clientId, scopes, familyId) {
    const access = `eyJhbGciOiJFUzI1NiJ9.${b64url(JSON.stringify({ sub: 'user_1', azp: clientId, n: randomBytes(6).toString('hex') }))}.${b64url(randomBytes(16))}`;
    state.accessTokens.set(access, { clientId, scopes, expiresAt: Date.now() + state.accessTtlSeconds * 1000 });
    let refresh;
    if (scopes.includes('offline_access')) {
      refresh = b64url(randomBytes(24));
      state.refreshTokens.set(refresh, { clientId, scopes, familyId, revoked: false });
    }
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: state.accessTtlSeconds,
      scope: scopes.join(' '),
      ...(refresh ? { refresh_token: refresh } : {}),
    };
  }

  function authenticate(req) {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice(7);
    const key = state.apiKeys.get(token);
    if (key) return { type: 'api_key', scopes: key.scopes, environment: key.environment ?? 'production', apiKeyId: key.id ?? 'key_1', groups: [] };
    const access = state.accessTokens.get(token);
    if (access && access.expiresAt > Date.now()) {
      const expanded = [...new Set(access.scopes.flatMap((scope) => GROUPS[scope] ?? []))].sort();
      return { type: 'oauth', scopes: expanded, groups: access.scopes.filter((scope) => scope in GROUPS), environment: state.environment, expiresAt: new Date(access.expiresAt).toISOString() };
    }
    return null;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const path = url.pathname;
    state.requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), headers: { ...req.headers } });
    try {
      if (path === '/health') return json(res, 200, { status: 'ok' });
      const approvePage = /^\/sign-offs\/([^/]+)$/.exec(path);
      if (approvePage && req.method === 'GET') {
        const request = state.gateSignOffs.get(approvePage[1]);
        if (!request) return json(res, 404, { error: 'not_found' });
        if (request.status === 'pending' && !options.holdSignOffs) {
          request.result = await request.apply();
          Object.assign(request, { status: 'applied', decidedAt: new Date().toISOString() });
        }
        return json(res, 200, { status: request.status });
      }
      const checkoutPage = /^\/checkout\/([a-z]+)$/.exec(path);
      if (checkoutPage && req.method === 'GET') {
        state.plan = checkoutPage[1];
        return json(res, 200, { status: 'paid' });
      }
      if (path === '/.well-known/oauth-protected-resource/mcp') {
        return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [`${origin}/api/auth`], bearer_methods_supported: ['header'] });
      }
      if (path === '/.well-known/oauth-authorization-server/api/auth') {
        return json(res, 200, {
          issuer: `${origin}/api/auth`,
          authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
          token_endpoint: `${origin}/api/auth/oauth2/token`,
          registration_endpoint: `${origin}/api/auth/oauth2/register`,
          revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
          userinfo_endpoint: `${origin}/api/auth/oauth2/userinfo`,
          scopes_supported: ['openid', 'profile', 'email', 'offline_access', ...Object.keys(GROUPS)],
          code_challenge_methods_supported: ['S256'],
          authorization_response_iss_parameter_supported: false,
        });
      }
      if (path === '/api/auth/oauth2/register' && req.method === 'POST') {
        state.counts.register++;
        const body = JSON.parse(await readBody(req));
        if (body.token_endpoint_auth_method !== 'none') return json(res, 400, { error: 'invalid_client_metadata' });
        if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) return json(res, 400, { error: 'invalid_redirect_uri' });
        const clientId = id('cli_');
        state.clients.set(clientId, { redirectUris: body.redirect_uris, scopes: String(body.scope ?? '').split(' ') });
        return json(res, 201, { client_id: clientId, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' });
      }
      if (path === '/api/auth/oauth2/authorize' && req.method === 'GET') {
        const q = url.searchParams;
        const client = state.clients.get(q.get('client_id'));
        const redirect = q.get('redirect_uri');
        if (!client) return json(res, 400, { error: 'invalid_client' });
        const ok = client.redirectUris.some((registered) => {
          if (registered === redirect) return true;
          const a = new URL(registered);
          const b = new URL(redirect);
          return a.hostname === '127.0.0.1' && a.hostname === b.hostname && a.pathname === b.pathname && a.protocol === b.protocol;
        });
        if (!ok) return json(res, 400, { error: 'invalid_redirect' });
        if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(res, 400, { error: 'invalid_request' });
        const target = new URL(redirect);
        if (options.denyConsent) {
          target.searchParams.set('error', 'access_denied');
        } else {
          const code = b64url(randomBytes(16));
          state.codes.set(code, { clientId: q.get('client_id'), redirect, challenge: q.get('code_challenge'), scopes: q.get('scope').split(' ') });
          target.searchParams.set('code', code);
        }
        target.searchParams.set('state', q.get('state'));
        target.searchParams.set('iss', `${origin}/api/auth`);
        res.writeHead(302, { Location: target.toString() });
        return res.end();
      }
      if (path === '/api/auth/oauth2/token' && req.method === 'POST') {
        state.counts.token++;
        const body = await form(req);
        if (body.resource !== `${origin}/mcp`) return json(res, 400, { error: 'invalid_request', error_description: 'requested resource invalid' });
        if (body.grant_type === 'authorization_code') {
          const grant = state.codes.get(body.code);
          state.codes.delete(body.code);
          if (!grant || grant.clientId !== body.client_id || grant.redirect !== body.redirect_uri) return json(res, 400, { error: 'invalid_grant' });
          const challenge = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
          if (challenge !== grant.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
          return json(res, 200, issueTokens(body.client_id, grant.scopes, id('fam_')), { 'Cache-Control': 'no-store' });
        }
        if (body.grant_type === 'refresh_token') {
          state.counts.refresh++;
          if (state.refreshDelayMs) await new Promise((r) => setTimeout(r, state.refreshDelayMs));
          const record = state.refreshTokens.get(body.refresh_token);
          if (!record || record.clientId !== body.client_id) return json(res, 400, { error: 'invalid_grant' });
          if (record.revoked) {
            state.counts.reuseDetected++;
            for (const other of state.refreshTokens.values()) if (other.familyId === record.familyId) other.revoked = true;
            return json(res, 400, { error: 'invalid_grant', error_description: 'invalid refresh token' });
          }
          record.revoked = true;
          return json(res, 200, issueTokens(record.clientId, record.scopes, record.familyId), { 'Cache-Control': 'no-store' });
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (path === '/api/auth/oauth2/revoke' && req.method === 'POST') {
        state.counts.revoke++;
        const body = await form(req);
        const record = state.refreshTokens.get(body.token);
        if (record) for (const other of state.refreshTokens.values()) if (other.familyId === record.familyId) other.revoked = true;
        return json(res, 200, {});
      }
      if (path === '/api/auth/oauth2/userinfo') {
        const who = authenticate(req);
        if (!who || who.type !== 'oauth') return json(res, 401, { error: 'invalid_token' });
        return json(res, 200, { sub: 'user_1', email: 'dev@example.com', name: 'Dev' });
      }

      if (path.startsWith('/api/v2/')) {
        if (state.apiDelayMs && path !== '/api/v2/auth/identity' && path !== '/api/v2/environment') await new Promise((r) => setTimeout(r, state.apiDelayMs));
        const who = authenticate(req);
        if (!who) return apiError(res, 401, 'AUTHENTICATION_FAILED', 'Authentication failed');
        const environment = ENVIRONMENTS[who.environment];
        const need = (scope) => {
          if (who.scopes.includes(scope)) return true;
          const fix = options.scopeFix ? { summary: `Log in again with the scope ${scope}.`, command: `anlyon auth login --scope ${scope}` } : undefined;
          apiError(res, 403, 'AUTHORIZATION_ERROR', `This authorization is missing required scope: ${scope}`, fix);
          return false;
        };
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 20);
        const paged = (items) => {
          const data = items.slice(offset, offset + limit);
          const page = Math.floor(offset / limit) + 1;
          return { success: true, data, pagination: { total: items.length, page, limit, totalPages: Math.ceil(items.length / limit), hasMore: offset + data.length < items.length } };
        };
        if (path === '/api/v2/auth/identity') {
          return json(res, 200, {
            success: true,
            data: {
              credentialType: who.type,
              apiKeyId: who.type === 'api_key' ? who.apiKeyId : null,
              workspaceId: WORKSPACE_ID,
              environmentId: environment.id,
              scopes: who.scopes,
              expiresAt: who.expiresAt ?? null,
            },
          }, { 'Cache-Control': 'no-store' });
        }
        if (path === '/api/v2/environment') {
          return json(res, 200, { success: true, data: { ...environment, kind: 'production', isDefault: true, isProtected: false, halted: false, haltedAt: null, haltedReason: null, createdAt: '', updatedAt: '' } });
        }
        if (path === '/api/v2/actions' && req.method === 'GET' && need('actions:read')) return json(res, 200, { success: true, data: state.actions });
        if (path === '/api/v2/actions/invocations' && need('actions:read')) return json(res, 200, paged([]));
        if (path === '/api/v2/actions/effects' && need('actions:read')) {
          const grade = url.searchParams.get('grade');
          return json(res, 200, paged(state.effects.filter((effect) => !grade || effect.grade === grade)));
        }
        const effectMatch = /^\/api\/v2\/actions\/effects\/([^/]+)$/.exec(path);
        if (effectMatch && need('actions:read')) {
          const effect = state.effects.find((candidate) => candidate.id === effectMatch[1]);
          return effect ? json(res, 200, { success: true, data: effect }) : apiError(res, 404, 'NOT_FOUND', 'Effect not found');
        }
        if (path === '/api/v2/impact-limits' && req.method === 'GET' && need('impact-limits:read')) return json(res, 200, { success: true, data: state.impactLimits });
        const limitMatch = /^\/api\/v2\/impact-limits\/([^/]+)$/.exec(path);
        if (limitMatch && req.method === 'GET' && need('impact-limits:read')) {
          const found = state.impactLimits.find((candidate) => candidate.id === limitMatch[1]);
          return found ? json(res, 200, { success: true, data: found }) : apiError(res, 404, 'NOT_FOUND', 'Impact limit not found');
        }
        const actionMatch = /^\/api\/v2\/actions\/(?!invocations$|effects$)([^/]+)$/.exec(path);
        if (actionMatch && !res.headersSent && (req.method === 'GET' || req.method === 'PATCH') && need(req.method === 'GET' ? 'actions:read' : 'actions:write')) {
          const ref = decodeURIComponent(actionMatch[1]);
          const action = state.actions.find((candidate) => candidate.id === ref || candidate.name === ref);
          if (!action) return apiError(res, 404, 'NOT_FOUND', 'Action not found');
          if (req.method === 'PATCH') {
            const body = JSON.parse((await readBody(req)) || '{}');
            state.declared.push({ ref, body });
            if (typeof options.signOff === 'object' && loosens(body)) {
              const signOffId = id('sor_');
              const now = new Date();
              const request = {
                object: 'sign_off_request', id: signOffId, status: 'pending', operation: 'action.update', environmentId: environment.id,
                resource: { type: 'action', id: action.id, name: action.name },
                summary: `Remove declarations from action "${action.name}"`,
                changes: [{ field: 'governed', from: true, to: false, direction: 'loosening', reason: 'Stops governing the action.' }],
                diff: '- governed: true\n+ governed: false',
                signOffUrl: `https://console.anlyon.test/sign-offs/${signOffId}`, pollUrl: `/api/v2/sign-offs/${signOffId}`, pollAfterSeconds: 0.05,
                requestedBy: { type: who.type === 'api_key' ? 'api_key' : 'oauth_client', id: who.apiKeyId ?? 'client_1', onBehalfOf: null },
                createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
                decidedAt: null, decidedBy: null, decisionNote: null, result: null, error: null,
              };
              state.signOffs.set(signOffId, { request, polls: 0, apply: () => { applyDeclarations(action, body); return { governed: false, impact: null, verify: null, ...action }; } });
              return json(res, 202, { success: true, signOffRequired: true, data: request }, { Location: request.pollUrl });
            }
            const { impact: _impact, verify: _verify, governed: _governed, ...rest } = body;
            Object.assign(action, rest);
            applyDeclarations(action, body);
          }
          return json(res, 200, { success: true, data: { governed: false, impact: null, verify: null, ...action } });
        }
        if (path === '/api/v2/sign-offs' && req.method === 'GET') {
          const status = url.searchParams.get('status');
          const all = [...state.signOffs.values()].map((entry) => entry.request).filter((request) => !status || request.status === status);
          return json(res, 200, { success: true, data: all.slice(0, limit) });
        }
        const signOffMatch = /^\/api\/v2\/sign-offs\/([^/]+)(\/cancel)?$/.exec(path);
        if (signOffMatch && !state.gateSignOffs.has(decodeURIComponent(signOffMatch[1]))) {
          const entry = state.signOffs.get(decodeURIComponent(signOffMatch[1]));
          if (!entry) return apiError(res, 404, 'NOT_FOUND', 'Sign-off request not found');
          if (signOffMatch[2] && req.method === 'POST') {
            if (entry.request.status !== 'pending') return apiError(res, 409, 'SIGN_OFF_NOT_PENDING', `Sign-off request is already ${entry.request.status}.`);
            entry.request = { ...entry.request, status: 'cancelled', decidedAt: new Date().toISOString() };
            return json(res, 200, { success: true, data: entry.request });
          }
          entry.polls += 1;
          const decision = options.signOff?.decision;
          if (entry.request.status === 'pending' && decision && entry.polls >= (options.signOff.afterPolls ?? 1)) {
            const decided = { status: decision, decidedAt: new Date().toISOString(), decidedBy: { type: 'user', id: 'user_admin', via: 'console' }, decisionNote: options.signOff.note ?? null };
            if (decision === 'applied') decided.result = entry.apply();
            if (decision === 'failed') decided.error = { code: 'TARGET_CHANGED', message: 'The action changed since the request was made.' };
            entry.request = { ...entry.request, ...decided };
          }
          return json(res, 200, { success: true, data: entry.request });
        }
        if (path === '/api/v2/connections/integrations/find') {
          const name = url.searchParams.get('name') ?? '';
          const known = { hubspot: 'integration', figma: 'mcp' }[name];
          const openapi = { kind: 'openapi', why: `If ${name} publishes an OpenAPI spec, import it.`, next: { summary: 'Import the spec.', url: `https://console.test/actions?import=openapi&vendor=${encodeURIComponent(name)}`, docs: 'https://docs.anlyon.com/execution/actions' } };
          const route = known === 'integration'
            ? { kind: 'integration', why: 'Anlyon has a governed pack.', next: { summary: 'Connect an account.', command: 'anlyon connections add hubspot' }, integration: { id: 'hubspot', connect: 'sign_in' } }
            : known === 'mcp'
              ? { kind: 'mcp', why: 'Figma publishes its own server, so govern it with MCP.', next: { summary: 'Add mcp.figma.com as an MCP server.', command: 'anlyon mcp add https://mcp.figma.com/mcp', url: 'https://console.test/mcp-servers/new?url=x' }, mcp: { registryName: 'com.figma.mcp/mcp', url: 'https://mcp.figma.com/mcp', host: 'mcp.figma.com', publisher: { verifiedBy: 'domain', namespace: 'com.figma.mcp' }, report: 'https://anlyon.dev/servers/com.figma.mcp/mcp' } }
              : openapi;
          return json(res, 200, { success: true, data: { query: name, name, route, alternatives: route === openapi ? [] : [openapi], tellUs: 'mailto:support@anlyon.com' } });
        }
        if (path === '/api/v2/connections/integrations' && need('secrets:read')) {
          return json(res, 200, { success: true, data: [
            { id: 'hubspot', name: 'HubSpot', auth: { kind: 'oauth' }, hosts: ['api.hubapi.com'], hostsFromAccount: false, scopes: ['crm.objects.contacts.write'], operationsPack: 'anlyon/hubspot', workflowPacks: [] },
            { id: 'github', name: 'GitHub', auth: { kind: 'api_key', instructions: 'Create a fine-grained token with Issues: Read and write.', instructionsUrl: 'https://github.com/settings/personal-access-tokens/new' }, hosts: ['api.github.com'], hostsFromAccount: false, scopes: [], operationsPack: 'anlyon/github', workflowPacks: [] },
          ] });
        }
        if (path === '/api/v2/connections' && req.method === 'GET' && need('secrets:read')) {
          return json(res, 200, { success: true, data: state.secrets.filter((secret) => secret.kind === 'connection' || secret.integrationId) });
        }
        if (path === '/api/v2/connections/keys' && req.method === 'POST' && need('secrets:write')) {
          const body = JSON.parse((await readBody(req)) || '{}');
          state.keyConnects.push(body);
          if (body.integrationId !== 'github') return apiError(res, 400, 'VALIDATION_ERROR', `No integration named "${body.integrationId}" can be connected.`);
          if (String(body.apiKey).includes('rejected')) return apiError(res, 422, 'CONNECTION_KEY_REJECTED', 'GitHub did not accept that key. Nothing was saved.');
          const secret = { id: id('sec_'), name: body.secretName, description: body.description ?? null, allowedHosts: ['api.github.com'], allowedPlacements: ['header'],
            kind: 'static', connection: null, integrationId: 'github', health: healthy(), lastUsedAt: null, createdAt: '', updatedAt: '' };
          state.secrets.push(secret);
          return json(res, 201, { success: true, data: secret });
        }
        if (path === '/api/v2/connections/sessions' && req.method === 'POST' && need('secrets:write')) {
          const body = JSON.parse((await readBody(req)) || '{}');
          if (body.integrationId !== 'hubspot') return apiError(res, 400, 'VALIDATION_ERROR', `No integration named "${body.integrationId}" can be connected.`);
          const session = { sessionId: id('csn_'), sessionToken: id('tok_'), expiresAt: new Date(Date.now() + 900_000).toISOString(), polls: 0, body };
          state.connectSessions.set(session.sessionId, session);
          return json(res, 201, { success: true, data: {
            sessionId: session.sessionId, sessionToken: session.sessionToken, expiresAt: session.expiresAt,
            connectUrl: `${origin}/connect/${session.sessionId}`,
            integration: { id: 'hubspot', name: 'HubSpot', hosts: ['api.hubapi.com'], hostsFromAccount: false, scopes: ['crm.objects.contacts.write'], operationsPack: 'anlyon/hubspot', workflowPacks: [] },
          } });
        }
        const completeMatch = /^\/api\/v2\/connections\/sessions\/([^/]+)\/complete$/.exec(path);
        if (completeMatch && req.method === 'POST' && need('secrets:write')) {
          const session = state.connectSessions.get(completeMatch[1]);
          if (!session) return apiError(res, 410, 'CONNECTION_SESSION_EXPIRED', 'This connect session has expired.');
          if (session.polls++ < state.consentAfterPolls) return json(res, 200, { success: true, data: { status: 'pending', secret: null } });
          let secret = state.secrets.find((candidate) => candidate.name === session.body.secretName);
          if (!secret) {
            secret = { id: id('sec_'), name: session.body.secretName, description: session.body.description ?? null, allowedHosts: ['api.hubapi.com'], allowedPlacements: ['header'],
              kind: 'connection', connection: { integrationId: 'hubspot', status: 'active' }, integrationId: 'hubspot', health: healthy(), lastUsedAt: null, createdAt: '', updatedAt: '' };
            state.secrets.push(secret);
          } else if (session.reconnects) {
            secret.health = healthy();
            if (secret.connection) secret.connection.status = 'active';
          }
          return json(res, 200, { success: true, data: { status: 'completed', secret } });
        }
        const checkMatch = /^\/api\/v2\/connections\/([A-Z0-9_]+)\/check$/.exec(path);
        if (checkMatch && req.method === 'POST' && need('secrets:write')) {
          const secret = state.secrets.find((candidate) => candidate.name === checkMatch[1]);
          if (!secret) return apiError(res, 404, 'SECRET_NOT_FOUND', 'Secret not found');
          if (!secret.integrationId) return apiError(res, 400, 'VALIDATION_ERROR', `Secret ${secret.name} is a stored value, not a connected account.`);
          state.checks.push(secret.name);
          secret.health = state.checkAnswer === 'rejected'
            ? { status: 'needs_reauth', checkedAt: new Date().toISOString(), reason: secret.kind === 'connection' ? 'access_revoked' : 'key_rejected' }
            : healthy();
          if (secret.connection) secret.connection.status = secret.health.status;
          return json(res, 200, { success: true, data: secret });
        }
        const reconnectMatch = /^\/api\/v2\/connections\/([A-Z0-9_]+)\/reconnect$/.exec(path);
        if (reconnectMatch && req.method === 'POST' && need('secrets:write')) {
          const body = JSON.parse((await readBody(req)) || '{}');
          const secret = state.secrets.find((candidate) => candidate.name === reconnectMatch[1]);
          if (!secret) return apiError(res, 404, 'SECRET_NOT_FOUND', 'Secret not found');
          state.reconnects.push({ secretName: secret.name, apiKey: body.apiKey });
          if (secret.integrationId === 'github') {
            if (!body.apiKey) return apiError(res, 400, 'VALIDATION_ERROR', `${secret.name} is connected with a GitHub key. Create a new key at the provider and send it as apiKey.`);
            if (String(body.apiKey).includes('rejected')) return apiError(res, 422, 'CONNECTION_KEY_REJECTED', 'GitHub did not accept that key. Nothing changed.');
            secret.health = healthy();
            return json(res, 200, { success: true, data: { status: 'completed', secret, session: null } });
          }
          if (body.apiKey) return apiError(res, 400, 'VALIDATION_ERROR', `${secret.name} is connected by signing in at HubSpot, so no key is needed.`);
          const session = { sessionId: id('csn_'), sessionToken: id('tok_'), expiresAt: new Date(Date.now() + 900_000).toISOString(), polls: 0, body: { secretName: secret.name, integrationId: 'hubspot' }, reconnects: secret.name };
          state.connectSessions.set(session.sessionId, session);
          return json(res, 200, { success: true, data: { status: 'pending', secret: null, session: {
            sessionId: session.sessionId, sessionToken: session.sessionToken, expiresAt: session.expiresAt,
            connectUrl: `${origin}/connect/${session.sessionId}`,
            integration: { id: 'hubspot', name: 'HubSpot', hosts: ['api.hubapi.com'], hostsFromAccount: false, scopes: ['crm.objects.contacts.write'], operationsPack: 'anlyon/hubspot', workflowPacks: [] },
          } } });
        }
        const secretMatch = /^\/api\/v2\/secrets\/([A-Z0-9_]+)$/.exec(path);
        if (secretMatch && (req.method === 'GET' || req.method === 'PUT') && need(req.method === 'GET' ? 'secrets:read' : 'secrets:write')) {
          const existing = state.secrets.find((secret) => secret.name === secretMatch[1]);
          if (req.method === 'GET') return existing ? json(res, 200, { success: true, data: existing }) : apiError(res, 404, 'SECRET_NOT_FOUND', 'Secret not found');
          const body = JSON.parse((await readBody(req)) || '{}');
          const secret = { id: id('sec_'), name: secretMatch[1], description: body.description ?? null, allowedHosts: body.allowedHosts ?? null, allowedPlacements: body.allowedPlacements ?? null, kind: 'static', connection: null, lastUsedAt: null, createdAt: '', updatedAt: '' };
          state.secrets.push(secret);
          return json(res, 200, { success: true, data: secret });
        }
        if (path === '/api/v2/actions' && req.method === 'POST' && need('actions:write')) {
          const body = JSON.parse((await readBody(req)) || '{}');
          const create = () => {
            const action = { id: id('act_'), enabled: true, ...body };
            state.actions.push(action);
            return action;
          };
          if (body.enabled !== false) {
            if (gate(who, 'action.create', `Add action "${body.name}"`, create)) return;
          }
          return json(res, 201, { success: true, data: create() });
        }
        if (path === '/api/v2/mcp-upstreams' && req.method === 'GET' && need('actions:read')) {
          return json(res, 200, { success: true, data: state.mcpUpstreams.filter((upstream) => !upstream.archivedAt) });
        }
        if (path === '/api/v2/mcp-upstreams' && req.method === 'POST' && need('actions:write')) {
          const body = JSON.parse((await readBody(req)) || '{}');
          state.lastMcpRegistration = body;
          const secretRefs = JSON.stringify(body.headers ?? {}).match(/\{\{secret:/g);
          if (secretRefs && !who.scopes?.includes('secrets:read')) {
            return apiError(res, 403, 'AUTHORIZATION_ERROR', 'Referencing a secret requires the "secrets:read" scope.', { summary: 'Ask a workspace admin for an API key with secrets:read.' });
          }
          if (state.mcpUpstreams.some((upstream) => upstream.name === body.name && !upstream.archivedAt)) return apiError(res, 409, 'CONFLICT', `An MCP upstream named "${body.name}" already exists.`);
          const create = () => {
            const upstream = {
              id: id('mcpu_'), name: body.name, url: body.url, headers: body.headers ?? {}, registryName: null, protocolVersion: '2025-06-18', serverInfo: { name: 'sim' },
              tools: state.mcpListing.map((tool) => ({ ...tool })), toolsHash: 'h1', listedAt: new Date(0).toISOString(), lastError: null, listedWith: 'headers', oauth: null, adopted: [],
              archivedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
            };
            state.mcpUpstreams.push(upstream);
            return upstream;
          };
          if (body.oauth && gate(who, 'mcp_upstream.register', `Register MCP server "${body.name}"`, create)) return;
          return json(res, 201, { success: true, data: create() });
        }
        const mcpMatch = /^\/api\/v2\/mcp-upstreams\/([^/]+)(?:\/(refresh|adopt|archive))?$/.exec(path);
        if (mcpMatch) {
          const upstream = state.mcpUpstreams.find((entry) => entry.id === decodeURIComponent(mcpMatch[1]));
          if (!upstream) return apiError(res, 404, 'NOT_FOUND', 'MCP upstream not found');
          if (!mcpMatch[2] && req.method === 'GET' && need('actions:read')) return json(res, 200, { success: true, data: upstream });
          if (req.method === 'POST' && need('actions:write')) {
            if (mcpMatch[2] === 'refresh') {
              upstream.tools = state.mcpListing.map((tool) => ({ ...tool }));
              for (const entry of upstream.adopted) {
                const now = upstream.tools.find((tool) => tool.name === entry.tool);
                entry.state = !now ? 'missing' : now.hash === entry.toolHash ? 'current' : 'changed';
              }
              return json(res, 200, { success: true, data: upstream });
            }
            if (mcpMatch[2] === 'archive') {
              upstream.archivedAt = new Date(0).toISOString();
              return json(res, 200, { success: true, data: upstream });
            }
            if (mcpMatch[2] === 'adopt') {
              const body = JSON.parse((await readBody(req)) || '{}');
              state.lastMcpAdoption = body;
              const adopt = () => {
                const result = { adopted: [], skipped: [] };
                for (const [tool, choice] of Object.entries(body.tools)) {
                  const listed = upstream.tools.find((entry) => entry.name === tool);
                  const action = { id: id('act_'), name: `${upstream.name}-${tool}`, method: 'POST', urlTemplate: upstream.url, enabled: true, requiresApproval: choice.requiresApproval ?? false, secrets: [] };
                  state.actions = state.actions.filter((entry) => entry.name !== action.name);
                  state.actions.push(action);
                  upstream.adopted = upstream.adopted.filter((entry) => entry.tool !== tool);
                  upstream.adopted.push({ tool, action: action.name, actionId: action.id, enabled: true, state: 'current', toolHash: listed.hash, requiresApproval: choice.requiresApproval ?? false });
                  result.adopted.push({ tool, action, readopted: false });
                }
                return result;
              };
              if (gate(who, 'mcp_upstream.adopt', `Adopt from MCP server "${upstream.name}"`, adopt)) return;
              return json(res, 201, { success: true, data: adopt() });
            }
          }
        }
        if (path === '/api/v2/approval-policies' && req.method === 'POST' && need('policies:write')) {
          const body = JSON.parse((await readBody(req)) || '{}');
          state.policies = [...(state.policies ?? []), { id: id('apol_'), ...body }];
          return json(res, 201, { success: true, data: state.policies.at(-1) });
        }
        if (path === '/api/v2/impact-limits' && req.method === 'POST' && need('impact-limits:write')) {
          const body = JSON.parse((await readBody(req)) || '{}');
          const limit = { id: id('lim_'), name: body.name, dimension: body.dimension, currency: body.currency ?? null, unit: body.currency ?? body.dimension, scope: { environmentId: environment.id, actionName: body.actionName ?? null, resourcePrefix: body.resourcePrefix ?? null, kind: body.scope ?? 'environment' }, period: body.period, limit: body.amount, consumed: 0, reserved: 0, unknownExposure: 0, archived: false, body };
          state.impactLimits.push(limit);
          return json(res, 201, { success: true, data: limit });
        }
        function gate(caller, operation, summary, apply) {
          if (!state.signOff) return null;
          const request = {
            object: 'sign_off_request', id: id('sor_'), status: 'pending', operation, environmentId: environment.id, resource: null,
            summary, changes: [], diff: `+ ${summary}`, signOffUrl: '', pollUrl: '', pollAfterSeconds: 0.05,
            requestedBy: { type: caller.type === 'api_key' ? 'api_key' : 'oauth_client', id: 'x', onBehalfOf: null },
            createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), decidedAt: null, decidedBy: null, decisionNote: null, result: null, error: null,
          };
          request.signOffUrl = `${origin}/sign-offs/${request.id}`;
          request.pollUrl = `/api/v2/sign-offs/${request.id}`;
          state.gateSignOffs.set(request.id, { ...request, apply });
          const { apply: _apply, ...visible } = state.gateSignOffs.get(request.id);
          json(res, 202, { success: true, signOffRequired: true, data: visible }, { Location: request.pollUrl });
          return true;
        }
        const gateSignOffMatch = /^\/api\/v2\/sign-offs\/([^/]+)$/.exec(path);
        if (gateSignOffMatch && req.method === 'GET') {
          const request = state.gateSignOffs.get(gateSignOffMatch[1]);
          if (!request) return apiError(res, 404, 'NOT_FOUND', 'Sign-off request not found');
          if (state.autoApproveGate && request.status === 'pending') {
            request.status = 'applied';
            request.result = request.apply();
          }
          const { apply: _apply, ...visible } = request;
          return json(res, 200, { success: true, data: visible });
        }

        if (path === '/api/v2/api-keys' && req.method === 'POST') {
          if (who.type !== 'oauth') return apiError(res, 403, 'OAUTH_LOGIN_REQUIRED', 'Only a person\'s own login can create a key here.');
          if (!who.groups.includes('anlyon:keys')) return apiError(res, 403, 'AUTHORIZATION_ERROR', 'This login was not allowed to create keys (anlyon:keys).');
          const body = JSON.parse((await readBody(req)) || '{}');
          const scopes = STANDARD_AGENT_KEY_SCOPES.filter((scope) => who.scopes.includes(scope));
          const key = `anlyon_test_${randomBytes(16).toString('hex')}`;
          const apiKey = { id: `key_${randomBytes(4).toString('hex')}`, name: body.name, scopes, environmentId: environment.id };
          state.apiKeys.set(key, { scopes, environment: who.environment, id: apiKey.id });
          state.mintedKeys.push({ ...apiKey, key });
          return json(res, 201, { success: true, data: { apiKey, key } }, { 'Cache-Control': 'no-store' });
        }

        if (path === '/api/v2/secrets' && req.method === 'GET' && need('secrets:read')) return json(res, 200, { success: true, data: state.secrets });

        const limitWrite = /^\/api\/v2\/impact-limits\/([^/]+)$/.exec(path);
        if (limitWrite && (req.method === 'PATCH' || req.method === 'DELETE') && need('impact-limits:write')) {
          const limit = state.impactLimits.find((candidate) => candidate.id === limitWrite[1]);
          if (!limit) return apiError(res, 404, 'NOT_FOUND', 'Impact limit not found');
          const body = req.method === 'PATCH' ? JSON.parse((await readBody(req)) || '{}') : {};
          const apply = () => (req.method === 'DELETE' ? Object.assign(limit, { archived: true }) : Object.assign(limit, body.amount !== undefined ? { limit: body.amount } : {}, body.name ? { name: body.name } : {}));
          if (req.method === 'DELETE' || (body.amount ?? 0) > limit.limit) {
            if (gate(who, req.method === 'DELETE' ? 'impact_limit.archive' : 'impact_limit.update', `${req.method === 'DELETE' ? 'Archive' : 'Raise'} impact limit "${limit.name}"`, apply)) return;
          }
          return json(res, 200, { success: true, data: apply() });
        }

        if (path === '/api/v2/budgets' && req.method === 'GET' && need('budgets:read')) return json(res, 200, { success: true, data: state.budgets });
        const budgetMatch = /^\/api\/v2\/budgets\/([^/]+)$/.exec(path);
        if (budgetMatch && (req.method === 'PUT' || req.method === 'DELETE') && need('budgets:write')) {
          const keyId = budgetMatch[1];
          const current = state.budgets.find((budget) => budget.apiKeyId === keyId);
          const body = req.method === 'PUT' ? JSON.parse((await readBody(req)) || '{}') : {};
          const apply = () => {
            state.budgets = state.budgets.filter((budget) => budget.apiKeyId !== keyId);
            if (req.method === 'DELETE') return { deleted: true };
            const next = { workspaceId: WORKSPACE_ID, apiKeyId: keyId, monthlyCostCentsCap: null, dimensionCaps: {}, alertThreshold: 0.8, enabled: true, ...(current ?? {}), ...body };
            state.budgets.push(next);
            return next;
          };
          const loosens = req.method === 'DELETE' || body.enabled === false || (current && (body.monthlyCostCentsCap === null || (body.monthlyCostCentsCap ?? 0) > (current.monthlyCostCentsCap ?? Infinity)));
          if (loosens && gate(who, req.method === 'DELETE' ? 'budget.delete' : 'budget.put', `Loosen the budget of key ${keyId}`, apply)) return;
          return json(res, 200, { success: true, data: apply() });
        }

        const fileMatch = /^\/api\/v2\/approval-policies\/files\/(plan|apply)$/.exec(path);
        if (fileMatch && req.method === 'POST' && need(fileMatch[1] === 'plan' ? 'policies:read' : 'policies:write')) {
          const body = JSON.parse((await readBody(req)) || '{}');
          const file = parseYaml(body.source);
          const owned = [...state.filePolicies.values()].filter((policy) => policy.file === file.file);
          const changes = [];
          for (const [key, wanted] of Object.entries(file.policies ?? {})) {
            const current = owned.find((policy) => policy.key === key);
            if (!current) changes.push({ op: 'create', key, name: wanted.name, after: wanted });
            else {
              const fields = [...new Set([...Object.keys(wanted), ...Object.keys(current.spec)])].filter((field) => JSON.stringify(wanted[field]) !== JSON.stringify(current.spec[field]));
              changes.push(fields.length ? { op: 'update', key, name: wanted.name, policyId: current.id, version: current.version, fields, after: wanted } : { op: 'unchanged', key, name: wanted.name, policyId: current.id, version: current.version });
            }
          }
          for (const policy of owned) if (!(policy.key in (file.policies ?? {}))) changes.push({ op: 'delete', key: policy.key, name: policy.spec.name, policyId: policy.id, version: policy.version });
          const digest = createHash('sha256').update(JSON.stringify([body.source, owned.map((policy) => [policy.id, policy.version])])).digest('hex');
          const summary = { create: 0, update: 0, delete: 0, unchanged: 0 };
          for (const change of changes) summary[change.op]++;
          if (fileMatch[1] === 'plan') return json(res, 200, { success: true, data: { file: file.file, environmentId: environment.id, digest, changes, summary, errors: [] } });
          if (body.digest !== digest) return apiError(res, 409, 'POLICY_FILE_STALE', 'The policies changed since this plan. Plan again.');
          const apply = () => {
            for (const change of changes) {
              const ref = `${file.file}:${change.key}`;
              if (change.op === 'delete') state.filePolicies.delete(ref);
              else if (change.op === 'create') state.filePolicies.set(ref, { id: id('apol_'), file: file.file, key: change.key, version: 1, spec: change.after });
              else if (change.op === 'update') Object.assign(state.filePolicies.get(ref), { spec: change.after, version: change.version + 1 });
            }
            return { summary };
          };
          const loosening = changes.some((change) => (change.op === 'create' && change.after.effect === 'auto_approve' && change.after.enabled !== false)
            || (change.op === 'delete' && owned.find((p) => p.key === change.key)?.spec.effect !== 'auto_approve')
            || (change.op === 'update' && (change.fields.includes('target') || change.fields.includes('when') || (change.after.approvals ?? 1) < (owned.find((p) => p.key === change.key)?.spec.approvals ?? 1) || change.after.enabled === false)));
          if (loosening && gate(who, 'policy_file.apply', `Apply policy file ${file.file}`, apply)) return;
          return json(res, 200, { success: true, data: apply() });
        }
        const policyMatch = /^\/api\/v2\/approval-policies\/(?!files$)([^/]+)$/.exec(path);
        if (policyMatch && req.method === 'GET' && need('policies:read')) {
          const owned = [...state.filePolicies.values()].find((policy) => policy.id === policyMatch[1]);
          if (!owned) {
            const plain = (state.policies ?? []).find((policy) => policy.id === policyMatch[1]);
            return plain ? json(res, 200, { success: true, data: plain }) : apiError(res, 404, 'NOT_FOUND', 'Policy not found');
          }
          const { spec } = owned;
          const target = spec.target ?? {};
          return json(res, 200, { success: true, data: {
            id: owned.id, environmentId: environment.id, name: spec.name, priority: spec.priority ?? 100, enabled: spec.enabled !== false,
            match: { kind: target.customRequests ? 'custom' : target.allRequests ? 'any' : 'action', actionName: target.action ?? null, agentId: spec.agent ?? null, userId: spec.user ?? null, tags: spec.tags ?? null, minAmount: null, conditions: null, condition: spec.when ?? null },
            effect: spec.effect ?? 'require_approval', requiredApprovals: spec.approvals ?? 1, version: owned.version, createdAt: '', updatedAt: '',
          } });
        }

        if (path === '/api/v2/billing/plan' && need('billing:read')) {
          return json(res, 200, { success: true, data: { plan: state.plan, pendingPlan: null, access: { mode: 'standard', paidPlansAvailable: true }, subscription: { status: state.plan === 'free' ? null : 'active', isCustomerConfigured: state.plan !== 'free', hasSubscription: state.plan !== 'free', trialEndsAt: null } } });
        }
        if (path === '/api/v2/billing/quota' && need('billing:read')) {
          return json(res, 200, { success: true, data: { plan: state.plan, actionInvokes: { includedUnits: 1000, usedUnits: state.dispatches, overageUnits: 0, projectedOverageCents: 0, reservedUnits: 0 }, projectedOverageCents: 0 } });
        }
        if (path === '/api/v2/billing/checkout' && req.method === 'POST') {
          if (who.type !== 'oauth') return apiError(res, 403, 'AUTHORIZATION_ERROR', 'This endpoint needs a person: log in to the console or with the CLI.');
          const body = JSON.parse((await readBody(req)) || '{}');
          if (!['starter', 'production', 'growth'].includes(body.plan) || !['month', 'year'].includes(body.interval)) return apiError(res, 400, 'VALIDATION_ERROR', 'Invalid plan or interval');
          if (state.plan !== 'free') return apiError(res, 409, 'SUBSCRIPTION_EXISTS', 'This workspace already has a subscription.');
          state.checkouts.push(body);
          return json(res, 200, { success: true, data: { checkoutUrl: `${origin}/checkout/${body.plan}` } });
        }

        if (path === '/api/v2/runs' && need('runs:read')) {
          const data = state.runs.slice(offset, offset + limit);
          return json(res, 200, { success: true, data, pagination: { total: state.runs.length, limit, offset, hasMore: offset + data.length < state.runs.length } });
        }
        if (path === '/api/v2/approvals' && need('approvals:read')) return json(res, 200, paged([]));
        if (path === '/api/v2/approval-policies' && need('policies:read')) {
          const actionName = url.searchParams.get('actionName');
          return json(res, 200, { success: true, data: (state.policies ?? []).filter((p) => !actionName || p.matchActionName === actionName) });
        }

        const invokeMatch = /^\/api\/v2\/actions\/([^/]+)\/invoke$/.exec(path);
        if (invokeMatch && req.method === 'POST' && need('actions:invoke')) {
          const body = JSON.parse((await readBody(req)) || '{}');
          const key = req.headers['idempotency-key'];
          const fingerprint = JSON.stringify([invokeMatch[1], body]);
          if (key && state.idempotency.has(key)) {
            const prior = state.idempotency.get(key);
            if (prior.fingerprint !== fingerprint) return apiError(res, 409, 'CONFLICT_ERROR', 'Idempotency key reused with a different request');
            return json(res, 200, { success: true, data: { ...state.invocations.get(prior.id), pendingApproval: state.invocations.get(prior.id).status === 'pending_approval' } }, { 'Idempotent-Replayed': 'true' });
          }
          const name = decodeURIComponent(invokeMatch[1]);
          const invocation = { id: id('inv_'), actionName: name, status: 'succeeded', responseStatus: 200, body: options.invokeBodies?.[name] ?? '{"ok":true}', error: null, approvalId: null, createdAt: new Date().toISOString(), input: body.input };
          if (name.startsWith('gated_')) {
            const approval = { id: id('apr_'), kind: 'action', status: 'pending', title: `Run ${name}`, invocationId: invocation.id, createdAt: invocation.createdAt };
            state.approvals.set(approval.id, approval);
            Object.assign(invocation, { status: 'pending_approval', responseStatus: null, body: null, approvalId: approval.id });
          } else if (name.startsWith('flaky_')) {
            state.dispatches++;
            Object.assign(invocation, { status: 'unknown', responseStatus: null, body: null, error: 'Destination timed out after the request was sent' });
          } else if (name.startsWith('broken_')) {
            state.dispatches++;
            Object.assign(invocation, { status: 'failed', responseStatus: 422, error: 'Destination rejected the request' });
          } else {
            state.dispatches++;
            const action = state.actions.find((candidate) => candidate.name === name);
            if (action?.governed) Object.assign(invocation, { effectId: id('eff_'), grade: 'acknowledged' });
          }
          state.invocations.set(invocation.id, invocation);
          if (key) state.idempotency.set(key, { id: invocation.id, fingerprint });
          return json(res, invocation.status === 'pending_approval' ? 202 : 200, { success: true, data: { ...invocation, pendingApproval: invocation.status === 'pending_approval' } });
        }
        const invocationMatch = /^\/api\/v2\/actions\/invocations\/([^/]+)$/.exec(path);
        if (invocationMatch && need('actions:read')) {
          const invocation = state.invocations.get(invocationMatch[1]);
          return invocation ? json(res, 200, { success: true, data: invocation }) : apiError(res, 404, 'NOT_FOUND', 'Invocation not found');
        }
        const approvalMatch = /^\/api\/v2\/approvals\/([^/]+)(\/(approve|deny))?$/.exec(path);
        if (approvalMatch) {
          const approval = state.approvals.get(approvalMatch[1]);
          if (!approvalMatch[3]) {
            if (!need('approvals:read')) return;
            return approval ? json(res, 200, { success: true, data: approval }) : apiError(res, 404, 'NOT_FOUND', 'Approval not found');
          }
          if (req.method !== 'POST' || !need('approvals:decide')) return;
          if (!approval) return apiError(res, 404, 'NOT_FOUND', 'Approval not found');
          if (approval.status !== 'pending') return apiError(res, 409, 'CONFLICT_ERROR', `Approval is already ${approval.status}`);
          const body = JSON.parse((await readBody(req)) || '{}');
          const invocation = state.invocations.get(approval.invocationId);
          if (approvalMatch[3] === 'approve') {
            state.dispatches++;
            Object.assign(approval, { status: 'approved', decisionNote: body.note ?? null });
            Object.assign(invocation, { status: 'succeeded', responseStatus: 200, body: '{"ok":true}' });
          } else {
            Object.assign(approval, { status: 'denied', decisionNote: body.note ?? null });
            Object.assign(invocation, { status: 'denied' });
          }
          return json(res, 200, { success: true, data: { approval, invocation } });
        }
        if (res.headersSent) return;
        return apiError(res, 404, 'NOT_FOUND', 'Not found');
      }
      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      return json(res, 500, { error: 'server_error', error_description: String(error) });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    state,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

export async function completeBrowserLogin(authorizationUrl) {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (response.status !== 302 || !location) throw new Error(`authorize did not redirect: HTTP ${response.status} ${await response.text()}`);
  const callback = await fetch(location);
  return { status: callback.status, location };
}
