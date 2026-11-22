import type { ModuleDefinition } from "../../../../edition/modules.ts";

export default {
  "alpha-tool-module": { kind: "cloud", editions: ["cloud"], paths: ["/api/v2/alpha-tool/*"], summary: "Test module." },
} satisfies Record<string, ModuleDefinition>;
