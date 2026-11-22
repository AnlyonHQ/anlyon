import { afterEach, describe, expect, it } from "vitest";
import { registerExtension, resetExtensions } from "./extensions";
import {
	configuredEdition,
	consoleEdition,
	isSelfHosted,
	runtimeConfig,
} from "./runtime-config";

afterEach(() => {
	resetExtensions();
	delete runtimeConfig.edition;
});

describe("the console's edition", () => {
	it("is community with neither an extension nor /config.js", () => {
		expect(consoleEdition()).toBe("community");
		expect(isSelfHosted()).toBe(true);
	});

	it("is the self-hosted edition /config.js names", () => {
		for (const edition of ["community", "team", "enterprise"] as const) {
			runtimeConfig.edition = edition;
			expect(consoleEdition()).toBe(edition);
		}
	});

	it("is never cloud because /config.js says so", () => {
		expect(configuredEdition({ edition: "cloud" })).toBe("community");
		runtimeConfig.edition = "cloud";
		expect(consoleEdition()).toBe("community");
		expect(isSelfHosted()).toBe(true);
	});

	it("is cloud when an extension declares it, whatever /config.js says", () => {
		registerExtension({ id: "hosted", edition: "cloud" });
		expect(consoleEdition()).toBe("cloud");
		runtimeConfig.edition = "team";
		expect(consoleEdition()).toBe("cloud");
		expect(isSelfHosted()).toBe(false);
	});

	it("is not changed by an extension that declares nothing", () => {
		registerExtension({ id: "other" });
		runtimeConfig.edition = "enterprise";
		expect(consoleEdition()).toBe("enterprise");
	});
});
