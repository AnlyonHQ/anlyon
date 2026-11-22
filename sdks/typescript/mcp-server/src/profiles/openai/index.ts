/**
 * The OpenAI presentation: how ChatGPT sees the hosted MCP server. The route
 * selects it by the OAuth client's registered chatgpt.com redirect; Codex
 * registers a loopback redirect and is served the default presentation.
 *
 * A pure transformation over what the server already returns: description
 * overlays, the security schemes mirrored under `_meta` for hosts that read
 * them there, trimmed outputs, and an OAuth hint on auth failures. No business
 * logic, no data access, no state. Every other client gets the default
 * presentation, which is the server unchanged.
 *
 * Deleting this directory (and the route lines that select it) removes the
 * ChatGPT behaviour and nothing else.
 */

import type { Presentation } from '../../server.ts';
import { overlayDescription } from './descriptions.ts';
import { trimResult } from './outputs.ts';
import { withAuthChallenge } from './auth-challenge.ts';

export interface OpenAiPresentationConfig {
  /** RFC 9728 protected-resource metadata URL of the host's MCP resource. */
  resourceMetadataUrl: string;
}

export function openAiPresentation(config: OpenAiPresentationConfig): Presentation {
  return {
    tools: (tools) =>
      tools.map((tool) => ({
        ...tool,
        description: overlayDescription(tool.name, tool.description),
        _meta: { ...tool._meta, securitySchemes: tool.securitySchemes },
      })),
    result: (toolName, result) => trimResult(toolName, result),
    failure: (_toolName, error, result, scopes) => withAuthChallenge(error, result, scopes, config.resourceMetadataUrl),
  };
}

export { RESTRICTED_DATA_WARNING, DESCRIPTION_OVERLAYS } from './descriptions.ts';
