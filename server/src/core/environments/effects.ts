export type EffectClass =
  | "read"
  | "agent_write"
  | "intake"
  | "operator"
  | "external";

export function haltBlocks(effect: EffectClass): boolean {
  return effect === "external" || effect === "agent_write";
}

export function haltBlocksIntakeFrom(principal: {
  authType: string | undefined;
  scopes: string[] | null;
}): boolean {
  if (principal.authType === "session") return false;

  if (principal.scopes?.includes("messages:ingest")) return false;

  return true;
}
