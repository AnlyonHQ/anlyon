/**
 * Workspace selection tools.
 *
 * An API key names its workspace in its own row, so these are meaningless for a
 * stdio caller and only appear on the OAuth path: a token names a person, and a
 * person can be in several workspaces. The binding lives in a table rather than
 * in a token claim exactly so it can be changed here  a claim inside an issued
 * token cannot move without dragging the user back through a browser.
 *
 * These call /api/oauth/* rather than going through the SDK client, because the
 * endpoints are not part of the public SDK surface: they answer "which
 * workspace?" for a caller who does not have one yet, which is the one question
 * every /api/v2 route already assumes has been answered.
 */

import { ADDITIVE, READ_ONLY, type McpTool } from './types.ts';
import { resolveApiBaseUrl, resolveApiKey } from '../auth.ts';
import { invalidateActionToolsForCaller } from './dynamic-actions.ts';
import { invalidateFunctionToolsForCaller } from './dynamic-functions.ts';

/** Mirrors the SDK's own default so both agree on where the API lives. */
const DEFAULT_BASE_URL = 'https://api.anlyon.com';

const baseUrl = () => resolveApiBaseUrl() ?? DEFAULT_BASE_URL;

interface Environment {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
}

interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: string;
  environments: Environment[];
}

async function callApi<T>(path: string, init?: RequestInit): Promise<T> {
  const credential = resolveApiKey();
  if (!credential) throw new Error('Not authenticated.');

  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential}`,
      ...init?.headers,
    },
  });

  const body = (await response.json().catch(() => null)) as
    | { success?: boolean; data?: T; error?: { message?: string } }
    | null;

  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Request failed with ${response.status}`);
  }
  return body?.data as T;
}

export const workspaceTools: McpTool[] = [
  {
    name: 'list_workspaces',
    annotations: READ_ONLY,
    scopes: [],
    description:
      'List the Anlyon workspaces you can act in, with their environments, and show which one this connection is currently using. Use this before select_workspace, or when a call reports that no workspace is selected.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const { workspaces } = await callApi<{ workspaces: Workspace[] }>('/api/oauth/workspaces');
      return {
        workspaces: workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          role: workspace.role,
          environments: workspace.environments.map((environment) => ({
            id: environment.id,
            name: environment.name,
            isDefault: environment.isDefault,
          })),
        })),
        hint: 'Pass a workspaceId to select_workspace to switch. Everything after that acts in the new workspace.',
      };
    },
  },
  {
    name: 'select_workspace',
    annotations: { ...ADDITIVE, idempotentHint: true },
    scopes: ['anlyon:workspace.switch'],
    description:
      'Point this connection at a different Anlyon workspace. Applies immediately and persists, so it survives reconnecting and token renewal. No need to sign in again. Only affects this client, not your other connected apps.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string',
          description: 'Workspace to switch to. Get one from list_workspaces.',
        },
        environmentId: {
          type: 'string',
          description: "Environment within that workspace. Defaults to the workspace's default environment.",
        },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    handler: async (_client, args) => {
      const workspaceId = args.workspaceId as string;
      const { workspaces } = await callApi<{ workspaces: Workspace[] }>('/api/oauth/workspaces');

      const target = workspaces.find((workspace) => workspace.id === workspaceId);
      if (!target) {
        throw new Error(
          `You are not a member of workspace ${workspaceId}. Call list_workspaces to see the ones you can use.`,
        );
      }

      const environmentId =
        (args.environmentId as string | undefined) ??
        (target.environments.find((environment) => environment.isDefault) ?? target.environments[0])?.id;
      if (!environmentId) {
        throw new Error(`Workspace ${target.name} has no environments.`);
      }
      if (!target.environments.some((environment) => environment.id === environmentId)) {
        throw new Error(`Environment ${environmentId} does not belong to ${target.name}.`);
      }

      await callApi<unknown>('/api/oauth/workspace-binding', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, environmentId }),
      });

      const credential = resolveApiKey();
      if (credential) {
        invalidateActionToolsForCaller(credential);
        invalidateFunctionToolsForCaller(credential);
      }

      const environment = target.environments.find((candidate) => candidate.id === environmentId);
      return {
        selected: { workspaceId, workspace: target.name, environmentId, environment: environment?.name },
        note: 'Applies to every following call on this connection.',
      };
    },
  },
];
