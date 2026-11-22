import { ValidationError } from "../../utils/errors.ts";
import type { SecretPolicy } from "./secrets.ts";
import { secretPlacements, urlTemplateAuthority } from "./template.ts";

export function hostAllowed(host: string, allowed: string[]): boolean {
  const normalised = host.toLowerCase().split(":")[0];
  return allowed.some((entry) => {
    const want = entry.toLowerCase().trim();
    if (want.startsWith(".")) return normalised.endsWith(want);
    return normalised === want;
  });
}

export function assertSecretDestinationsAllowed(
  urlTemplate: string,
  headers: Record<string, unknown> | null | undefined,
  bodyTemplate: Record<string, unknown> | null | undefined,
  policies: Map<string, SecretPolicy>,
): void {
  const host = urlTemplateAuthority(urlTemplate).split("@").pop() ?? "";
  const placements = secretPlacements(urlTemplate, headers, bodyTemplate);

  for (const [name, used] of placements) {
    const policy = policies.get(name);
    if (!policy) continue;

    if (policy.allowedHosts && policy.allowedHosts.length > 0 && !hostAllowed(host, policy.allowedHosts)) {
      throw new ValidationError(
        `Secret ${name} may only be sent to ${policy.allowedHosts.join(", ")}, and this action addresses ${host || "an unparseable host"}.`
      );
    }

    if (policy.allowedPlacements && policy.allowedPlacements.length > 0) {
      const allowed = new Set(policy.allowedPlacements);
      const disallowed = [...used].filter((placement) => !allowed.has(placement));
      if (disallowed.length > 0) {
        throw new ValidationError(
          `Secret ${name} may only appear in the ${policy.allowedPlacements.join(" or ")} of a request, not the ${disallowed.join(" or ")}.`
        );
      }
    }
  }
}
