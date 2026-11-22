/**
 * Action Packs resource: `client.packs.plan` and `client.packs.install`. The rules and the install
 * logic live in packs-core.ts, shared with the console; this supplies the transport.
 */
import type { HttpClient } from '../core/http-client';
import { ActionsResource } from './actions';
import { ApprovalPoliciesResource } from './approval-policies';
import { ImpactLimitsResource } from './impact-limits';
import { SecretsResource } from './secrets';
import { installPack, planPack, type PackInstallOptions, type PackInstallResult, type PackTransport } from './packs-core';

export * from './packs-core';

async function readOrNull<T>(read: () => Promise<{ data?: T }>): Promise<T | null> {
  try {
    return (await read()).data ?? null;
  } catch (error) {
    const status = (error as { status?: number }).status;
    const code = (error as { code?: string }).code;
    if (status === 404 || code === 'NOT_FOUND' || code === 'SECRET_NOT_FOUND' || code === 'ACTION_NOT_FOUND') return null;
    throw error;
  }
}

export class PacksResource {
  private readonly transport: PackTransport;

  constructor(http: HttpClient) {
    const secrets = new SecretsResource(http);
    const actions = new ActionsResource(http);
    const policies = new ApprovalPoliciesResource(http);
    const limits = new ImpactLimitsResource(http);
    this.transport = {
      getSecret: (name) => readOrNull(() => secrets.get(name)),
      putSecret: (name, request) => secrets.put(name, request),
      getAction: (name) => readOrNull(() => actions.get(name)),
      createAction: (request) => actions.create(request as never),
      updateAction: (name, request) => actions.update(name, request as never),
      listPolicies: async (actionName) => (await policies.list({ actionName })).data ?? [],
      createPolicy: (request) => policies.create(request),
      listLimits: async () => (await limits.list()).data ?? [],
      createLimit: (request) => limits.create(request),
    };
  }

  /** What `install` would do, with nothing sent. Reads the workspace to decide. */
  async plan(manifest: unknown, options: PackInstallOptions = {}): Promise<PackInstallResult> {
    return planPack(this.transport, manifest, options);
  }

  /** Install the pack. Refuses before writing anything; what it would write is all or nothing up to the first API error. */
  async install(manifest: unknown, options: PackInstallOptions = {}): Promise<PackInstallResult> {
    return installPack(this.transport, manifest, options);
  }
}
