import { getExtensions } from "./extensions";

export type Edition = "cloud" | "community" | "team" | "enterprise";
export type SelfHostedEdition = Exclude<Edition, "cloud">;

const SELF_HOSTED_EDITIONS: readonly SelfHostedEdition[] = [
	"community",
	"team",
	"enterprise",
];

export interface RuntimeConfig {
	apiBaseUrl?: string;
	edition?: Edition;
}

declare global {
	interface Window {
		__ANLYON_CONFIG__?: RuntimeConfig;
	}
}

export const runtimeConfig: RuntimeConfig =
	typeof window === "undefined" ? {} : (window.__ANLYON_CONFIG__ ?? {});

export function configuredEdition(
	config: RuntimeConfig = runtimeConfig,
): SelfHostedEdition {
	const value = config.edition;
	if (value && (SELF_HOSTED_EDITIONS as readonly string[]).includes(value)) {
		return value as SelfHostedEdition;
	}
	return "community";
}

export function consoleEdition(): Edition {
	if (getExtensions().some((extension) => extension.edition === "cloud")) {
		return "cloud";
	}
	return configuredEdition();
}

export function isSelfHosted(): boolean {
	return consoleEdition() !== "cloud";
}
