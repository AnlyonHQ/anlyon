import type { Client } from '@anlyonhq/sdk';
import { parseLimit } from '../args';
import { connect } from '../context';
import { GRADES, describeGrade, describeImpact, describeVerify } from '../governed';
import type { Column } from '../output';
import { decodeCursor, encodeCursor, localPage, offsetPage, type Page } from '../pagination';
import { requireArgs, type CommandContext, type CommandSpec } from './types';

type Row = Record<string, unknown>;
const DEFAULT_LIMIT = 20;
const str = (value: string | boolean | string[] | undefined) => (typeof value === 'string' ? value : undefined);
const col = (header: string, key: string): Column<Row> => ({ header, value: (row) => row[key] });

function emitPage(ctx: CommandContext, page: Page<Row>, columns: Column<Row>[]): void {
  if (ctx.out.json) {
    ctx.out.result({ data: page.data, nextCursor: page.nextCursor, ...(page.total !== undefined ? { total: page.total } : {}) });
    return;
  }
  ctx.out.table(page.data, columns);
  if (page.nextCursor) ctx.out.info(`More results: add --cursor ${page.nextCursor}`);
}

function emitOne(ctx: CommandContext, data: unknown, fields: [string, (row: Row) => unknown][]): void {
  if (ctx.out.json) {
    ctx.out.result({ data });
    return;
  }
  const row = (data ?? {}) as Row;
  ctx.out.fields(fields.map(([label, get]) => [label, get(row)]));
}

interface ListDef {
  resource: string;
  summary: string;
  options?: CommandSpec['options'];
  columns: Column<Row>[];
  fetch(client: Client, ctx: CommandContext, page: { offset: number; limit: number; before?: number }): Promise<Page<Row>>;
}

function list(def: ListDef): CommandSpec {
  const listName = `${def.resource}.list`;
  return {
    path: [def.resource, 'list'],
    summary: def.summary,
    options: def.options,
    paginated: true,
    async run(ctx) {
      requireArgs(ctx, { path: [def.resource, 'list'], summary: '', run: async () => {} });
      const limit = parseLimit(ctx.globals.limit) ?? DEFAULT_LIMIT;
      const cursor = decodeCursor(ctx.globals.cursor, listName);
      const { client } = await connect(ctx.globals, ctx.rt);
      const page = await def.fetch(client, ctx, { offset: cursor?.o ?? 0, limit, before: cursor?.b });
      emitPage(ctx, page, def.columns);
    },
  };
}

function get(resource: string, summary: string, argName: string, fetch: (client: Client, id: string) => Promise<unknown>, fields: [string, (row: Row) => unknown][]): CommandSpec {
  const spec: CommandSpec = {
    path: [resource, 'get'],
    summary,
    args: [{ name: argName, description: `The ${argName}.` }],
    async run(ctx) {
      const [id] = requireArgs(ctx, spec);
      const { client } = await connect(ctx.globals, ctx.rt);
      emitOne(ctx, await fetch(client, id!), fields);
    },
  };
  return spec;
}

const pick = (key: string) => (row: Row) => row[key];
/** What a limit's amounts count: the currency for money, the declared unit otherwise. */
const unitOf = (row: Row) => row.unit ?? row.currency ?? row.dimension;


export const resourceCommands: CommandSpec[] = [
  list({
    resource: 'actions',
    summary: 'List the actions configured in this environment.',
    columns: [col('Name', 'name'), col('ID', 'id'), col('Method', 'method'), col('Enabled', 'enabled'), col('Approval', 'requiresApproval')],
    async fetch(client, _ctx, { offset, limit }) {
      const response = await client.actions.list();
      return localPage('actions.list', response.data as Row[] | undefined, offset, limit);
    },
  }),
  get('actions', 'Show one action by name or act_ id.', 'ref', async (client, ref) => (await client.actions.get(ref)).data, [
    ['name', pick('name')],
    ['id', pick('id')],
    ['description', pick('description')],
    ['method', pick('method')],
    ['url', pick('urlTemplate')],
    ['enabled', pick('enabled')],
    ['requires approval', pick('requiresApproval')],
    ['governed', pick('governed')],
    ['impact', (row) => describeImpact(row.impact)],
    ['verify', (row) => describeVerify(row.verify)],
    ['current version', pick('currentVersionId')],
    ['created', pick('createdAt')],
  ]),
  (() => {
    const spec: CommandSpec = {
      path: ['actions', 'versions'],
      summary: "Show an action's version history.",
      args: [{ name: 'ref', description: 'Action name or act_ id.' }],
      paginated: true,
      async run(ctx) {
        const [ref] = requireArgs(ctx, spec);
        const limit = parseLimit(ctx.globals.limit) ?? DEFAULT_LIMIT;
        const cursor = decodeCursor(ctx.globals.cursor, 'actions.versions');
        const { client } = await connect(ctx.globals, ctx.rt);
        const response = await client.actions.versions(ref!);
        emitPage(ctx, localPage('actions.versions', response.data as unknown as Row[], cursor?.o ?? 0, limit), [
          col('Version', 'version'),
          col('ID', 'id'),
          col('Method', 'method'),
          col('URL', 'urlTemplate'),
        ]);
      },
    };
    return spec;
  })(),

  list({
    resource: 'invocations',
    summary: 'List action invocations, newest first.',
    options: {
      action: { type: 'string', description: 'Only invocations of this action (name or act_ id).' },
      status: { type: 'string', description: 'Only invocations in this status (e.g. unknown, failed, succeeded).' },
    },
    columns: [col('ID', 'id'), col('Action', 'actionName'), col('Status', 'status'), col('HTTP', 'responseStatus'), col('Created', 'createdAt')],
    async fetch(client, ctx, { offset, limit }) {
      const response = await client.actions.invocations({
        action: str(ctx.options.action),
        status: str(ctx.options.status) as never,
        limit,
        offset,
      });
      return offsetPage('invocations.list', response.data as Row[] | undefined, offset, response.pagination);
    },
  }),
  get('invocations', 'Show one invocation by inv_ id.', 'id', async (client, id) => (await client.actions.invocation(id)).data, [
    ['id', pick('id')],
    ['action', pick('actionName')],
    ['status', pick('status')],
    ['approval', pick('approvalId')],
    ['http status', pick('responseStatus')],
    ['duration ms', pick('durationMs')],
    ['retry of', pick('retryOf')],
    ['created', pick('createdAt')],
    ['completed', pick('completedAt')],
  ]),

  list({
    resource: 'runs',
    summary: 'List runs, newest first.',
    options: {
      status: { type: 'string', description: 'Only runs in this status.', choices: ['running', 'succeeded', 'failed', 'cancelled'] },
      search: { type: 'string', description: 'Substring match on run id, name or application.' },
      agent: { type: 'string', description: 'Only runs by this agent id.' },
      since: { type: 'string', description: 'Only runs started at or after this ISO 8601 time.' },
      until: { type: 'string', description: 'Only runs started before this ISO 8601 time.' },
    },
    columns: [col('ID', 'id'), col('Name', 'name'), col('Status', 'status'), col('Started', 'startedAt'), col('Ended', 'endedAt')],
    async fetch(client, ctx, { offset, limit }) {
      const response = await client.runs.list({
        status: str(ctx.options.status) as never,
        search: str(ctx.options.search),
        agentId: str(ctx.options.agent),
        startedAfter: str(ctx.options.since),
        startedBefore: str(ctx.options.until),
        limit,
        offset,
      });
      return offsetPage('runs.list', response.data as Row[] | undefined, offset, response.pagination);
    },
  }),
  get('runs', 'Show one run with its span tree.', 'id', async (client, id) => (await client.runs.get(id)).data, [
    ['id', pick('id')],
    ['name', pick('name')],
    ['status', pick('status')],
    ['started', pick('startedAt')],
    ['ended', pick('endedAt')],
    ['spans', (row) => (Array.isArray(row.spans) ? row.spans.length : undefined)],
  ]),

  list({
    resource: 'approvals',
    summary: 'List approval requests (the inbox: --status pending).',
    options: {
      status: { type: 'string', description: 'Only approvals in this status.', choices: ['pending', 'approved', 'denied', 'expired'] },
      origin: {
        type: 'string',
        description: 'Only decisions of this origin.',
        choices: ['human', 'policy', 'system', 'unknown', 'assistant', 'automated'],
      },
    },
    columns: [col('ID', 'id'), col('Title', 'title'), col('Status', 'status'), col('Created', 'createdAt'), col('Expires', 'expiresAt')],
    async fetch(client, ctx, { offset, limit }) {
      const response = await client.approvals.list({
        status: str(ctx.options.status) as never,
        decisionOrigin: str(ctx.options.origin) as never,
        limit,
        offset,
      });
      return offsetPage('approvals.list', response.data as Row[] | undefined, offset, response.pagination);
    },
  }),
  get('approvals', 'Show one approval by apr_ id.', 'id', async (client, id) => (await client.approvals.get(id)).data, [
    ['id', pick('id')],
    ['title', pick('title')],
    ['status', pick('status')],
    ['description', pick('description')],
    ['decided by', pick('decidedBy')],
    ['decision origin', pick('decisionOrigin')],
    ['decided', pick('decidedAt')],
    ['created', pick('createdAt')],
    ['expires', pick('expiresAt')],
  ]),

  list({
    resource: 'policies',
    summary: 'List approval policies for this environment (needs policies:read, API keys only today).',
    options: { action: { type: 'string', description: 'Only policies for this action name.' } },
    columns: [col('ID', 'id'), col('Name', 'name'), col('Priority', 'priority'), col('Effect', 'effect'), col('Enabled', 'enabled'), col('Version', 'version')],
    async fetch(client, ctx, { offset, limit }) {
      const response = await client.approvalPolicies.list({ actionName: str(ctx.options.action) });
      return localPage('policies.list', response.data as unknown as Row[], offset, limit);
    },
  }),
  get('policies', 'Show one approval policy.', 'id', async (client, id) => (await client.approvalPolicies.get(id)).data, [
    ['id', pick('id')],
    ['name', pick('name')],
    ['priority', pick('priority')],
    ['match', pick('match')],
    ['effect', pick('effect')],
    ['required approvals', pick('requiredApprovals')],
    ['enabled', pick('enabled')],
    ['version', pick('version')],
    ['updated', pick('updatedAt')],
  ]),
  (() => {
    const spec: CommandSpec = {
      path: ['policies', 'versions'],
      summary: "Show a policy's version history, newest first.",
      args: [{ name: 'id', description: 'The policy id.' }],
      paginated: true,
      async run(ctx) {
        const [id] = requireArgs(ctx, spec);
        const limit = parseLimit(ctx.globals.limit) ?? DEFAULT_LIMIT;
        const cursor = decodeCursor(ctx.globals.cursor, 'policies.versions');
        const { client } = await connect(ctx.globals, ctx.rt);
        const response = await client.approvalPolicies.versions(id!, { limit, before: cursor?.b });
        const next = response.pagination?.nextBefore;
        emitPage(
          ctx,
          {
            data: (response.data ?? []) as unknown as Row[],
            nextCursor: typeof next === 'number' ? encodeCursor({ l: 'policies.versions', b: next }) : null,
          },
          [col('Version', 'version'), col('Operation', 'operation'), col('Created', 'createdAt'), col('Actor', 'actor'), col('Note', 'changeNote')],
        );
      },
    };
    return spec;
  })(),

  list({
    resource: 'effects',
    summary: 'List governed effects with their receipt grades, newest first.',
    options: {
      action: { type: 'string', description: 'Only effects of this action (name or act_ id).' },
      outcome: {
        type: 'string',
        description: 'Only effects with this outcome.',
        choices: ['not_dispatched', 'pending', 'succeeded', 'failed', 'unknown'],
      },
      grade: { type: 'string', description: 'Only effects with this receipt grade.', choices: GRADES },
      unresolved: { type: 'boolean', description: 'Only effects still holding impact-limit capacity: pending, unknown or possibly partial.' },
    },
    columns: [
      col('ID', 'id'),
      col('Action', 'actionName'),
      col('Stage', 'stage'),
      col('Grade', 'grade'),
      col('Outcome', 'outcome'),
      col('Verified', 'verification'),
      col('Created', 'createdAt'),
    ],
    async fetch(client, ctx, { offset, limit }) {
      const response = await client.actions.effects({
        action: str(ctx.options.action),
        outcome: str(ctx.options.outcome) as never,
        grade: str(ctx.options.grade) as never,
        unresolved: ctx.options.unresolved === true ? true : undefined,
        limit,
        offset,
      });
      const rows = (response.data ?? []).map((effect) => ({ ...effect, actionName: effect.action.name }));
      return offsetPage('effects.list', rows as Row[], offset, response.pagination);
    },
  }),
  get('effects', 'Show one governed effect by eff_ id, with its receipt grade and evidence.', 'id', async (client, id) => (await client.actions.effect(id)).data, [
    ['id', pick('id')],
    ['invocation', pick('invocationId')],
    ['action', (row) => (row.action as { name?: string } | undefined)?.name],
    ['adapter', (row) => (row.adapter as { type?: string } | undefined)?.type],
    ['grade', (row) => describeGrade(row.grade)],
    ['stage', pick('stage')],
    ['outcome', pick('outcome')],
    ['partial effect', pick('partialEffect')],
    ['verification', pick('verification')],
    ['provider reference', pick('providerReference')],
    ['approval', pick('approvalId')],
    ['unresolved exposure', pick('unresolvedExposure')],
    ['created', pick('createdAt')],
    ['outcome at', pick('outcomeAt')],
  ]),

  list({
    resource: 'impact-limits',
    summary: 'List the impact limits shared by every agent in this environment.',
    options: {
      'include-archived': { type: 'boolean', description: 'Include archived limits.' },
    },
    columns: [
      col('ID', 'id'),
      col('Name', 'name'),
      col('Dimension', 'dimension'),
      { header: 'Unit', value: unitOf },
      col('Period', 'period'),
      col('Limit', 'limit'),
      col('Consumed', 'consumed'),
      col('Reserved', 'reserved'),
    ],
    async fetch(client, ctx, { offset, limit }) {
      const response = await client.impactLimits.list({ includeArchived: ctx.options['include-archived'] === true ? true : undefined });
      return localPage('impact-limits.list', (response.data ?? []) as unknown as Row[], offset, limit);
    },
  }),
  get('impact-limits', 'Show one impact limit by lim_ id.', 'id', async (client, id) => (await client.impactLimits.get(id)).data, [
    ['id', pick('id')],
    ['name', pick('name')],
    ['dimension', pick('dimension')],
    ['unit', unitOf],
    ['action', (row) => (row.scope as { actionName?: string | null } | undefined)?.actionName],
    ['resource prefix', (row) => (row.scope as { resourcePrefix?: string | null } | undefined)?.resourcePrefix],
    ['period', pick('period')],
    ['current period', pick('currentPeriod')],
    ['limit', pick('limit')],
    ['consumed', pick('consumed')],
    ['reserved', pick('reserved')],
    ['unknown exposure', pick('unknownExposure')],
  ]),
];
