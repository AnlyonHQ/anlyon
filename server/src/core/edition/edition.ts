import { z } from "zod";
import { cloudEditionDeclaredBy } from "../extensions/manifest.ts";

export const EDITIONS = ["cloud", "community", "team", "enterprise"] as const;
export type Edition = (typeof EDITIONS)[number];

export const SELF_HOSTED_EDITIONS = ["community", "team", "enterprise"] as const;
export type SelfHostedEdition = (typeof SELF_HOSTED_EDITIONS)[number];

export class EditionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditionConfigError";
  }
}

export const CLOUD_NEEDS_EXTENSION =
  "EDITION=cloud is the edition of anlyon.com's own build, which carries the cloud extension; this build does not. " +
  "Set EDITION to community, team or enterprise (a licence key, set in the console, unlocks the licensed features).";

export interface EditionDecision {
  edition: Edition;
  declaredBy: readonly string[];
  ignoredSetting?: string;
}

export interface EditionInputs {
  setting: string | undefined;
  declaredBy: readonly string[];
  testOverride?: boolean;
}

const settingSchema = z.enum(EDITIONS);

export function decideEdition({ setting, declaredBy, testOverride = false }: EditionInputs): EditionDecision {
  const value = setting?.trim() || undefined;
  if (testOverride) {
    const parsed = settingSchema.safeParse(value ?? "cloud");
    if (!parsed.success) throw new EditionConfigError(`EDITION must be one of ${EDITIONS.join(", ")}, not "${value}".`);
    return { edition: parsed.data, declaredBy: [] };
  }
  if (declaredBy.length > 0) {
    return { edition: "cloud", declaredBy, ...(value && value !== "cloud" ? { ignoredSetting: value } : {}) };
  }
  if (value === undefined) return { edition: "community", declaredBy: [] };
  if (value === "cloud") throw new EditionConfigError(CLOUD_NEEDS_EXTENSION);
  if (!(SELF_HOSTED_EDITIONS as readonly string[]).includes(value)) {
    throw new EditionConfigError(`EDITION must be community, team or enterprise, not "${value}".`);
  }
  return { edition: value as SelfHostedEdition, declaredBy: [] };
}

const TEST_OVERRIDE = Symbol.for("anlyon.edition.testOverride");
type WithOverride = typeof globalThis & { [TEST_OVERRIDE]?: boolean };

export function useEditionTestOverride(on: boolean): void {
  (globalThis as WithOverride)[TEST_OVERRIDE] = on;
}

function testOverrideOn(): boolean {
  return (globalThis as WithOverride)[TEST_OVERRIDE] === true;
}

let decision: EditionDecision | null = null;

export function editionDecision(): EditionDecision {
  if (!decision) {
    const testOverride = testOverrideOn();
    decision = decideEdition({
      setting: process.env.EDITION,
      declaredBy: testOverride ? [] : cloudEditionDeclaredBy(),
      testOverride,
    });
  }
  return decision;
}

export function currentEdition(): Edition {
  return editionDecision().edition;
}

export function isLicensedEdition(value: Edition = currentEdition()): boolean {
  return value === "team" || value === "enterprise";
}

export function isCloudEdition(value: Edition = currentEdition()): boolean {
  return value === "cloud";
}
