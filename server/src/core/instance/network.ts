import { isCloudEdition } from "../edition/edition.ts";
import type { PrivateDestinationPolicy } from "./registry.ts";
import { instanceSetting } from "./settings.ts";

export const PRIVATE_DESTINATIONS_SETTING = "network.private_destinations";

export function privateDestinationPolicy(): PrivateDestinationPolicy | "cloud" {
  if (isCloudEdition()) return "cloud";
  return instanceSetting(PRIVATE_DESTINATIONS_SETTING) === "workspace" ? "workspace" : "off";
}

export function privateDestinationsOffered(): boolean {
  return privateDestinationPolicy() === "workspace";
}

export function privateDestinationsRefusal(subject: "audit sinks" | "secret stores"): string | null {
  switch (privateDestinationPolicy()) {
    case "workspace":
      return null;
    case "off":
      return `An instance admin has turned off private network destinations on this install, so ${subject} must use public addresses (Settings, Instance, Network).`;
    case "cloud":
      return subject === "audit sinks"
        ? "Private network destinations are available on self-hosted deployments only."
        : "Private network access for secret stores is a self-hosted setting. On Anlyon's hosted service a store must be reachable at a public address.";
  }
}
