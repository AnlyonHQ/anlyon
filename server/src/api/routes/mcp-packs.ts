import { ALL_TOOLS, type ServerOptions } from "@anlyonhq/mcp-server";
import { CATALOGUE } from "../../core/connections/catalogue.ts";

export const PACK_SERVER_TOOLS: ReadonlySet<string> = new Set(["check_approval", "wait_for_approval"]);

const STATIC_TOOLS: ReadonlySet<string> = new Set(ALL_TOOLS.map((tool) => tool.name));

export interface PackServer {
  pack: string;
  name: string;
  displayName: string;
}

export const PACK_SERVERS: ReadonlyMap<string, PackServer> = new Map(
  CATALOGUE.filter((entry) => entry.operationsPack !== null && entry.verificationStatus !== "paused").map((entry) => {
    const pack = entry.operationsPack!;
    const name = pack.slice(pack.indexOf("/") + 1);
    return [name, { pack, name, displayName: entry.displayName }] as const;
  }),
);

export function packServer(name: string): PackServer | null {
  return PACK_SERVERS.get(name) ?? null;
}

export function isPackAction(server: PackServer, actionName: string): boolean {
  return actionName.startsWith(`${server.name}-`);
}

export function packServerOptions(server: PackServer, options: ServerOptions): ServerOptions {
  const hidden = options.hiddenTools;
  return {
    ...options,
    hiddenTools: (name) => (STATIC_TOOLS.has(name) && !PACK_SERVER_TOOLS.has(name)) || (hidden ? hidden(name) : false),
    actions: (actionName) => isPackAction(server, actionName) && (options.actions ? options.actions(actionName) : true),
    functions: false,
  };
}
