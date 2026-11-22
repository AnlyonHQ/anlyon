import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { absoluteActionUrl, consoleLink } from "../src/core/notifications/console-link.ts";

const serverRoot = join(import.meta.dirname, "..");

function files(dir: string, extensions: string[]): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return files(path, extensions);
		return extensions.some((extension) => name.endsWith(extension)) ? [path] : [];
	});
}

describe("links into the console", () => {
	const surfaces = files(join(serverRoot, "src"), [".ts"]);

	it.each(surfaces.map((path) => [relative(serverRoot, path).replaceAll("\\", "/"), path]))(
		"%s never names app.anlyon.com",
		(_name, path) => {
			expect(readFileSync(path, "utf8")).not.toContain("app.anlyon.com");
		},
	);

	it("usage alerts link to a console path or through consoleLink", () => {
		const source = readFileSync(join(serverRoot, "src/core/notifications/usage-alerts.ts"), "utf8");
		const actionUrls = [...source.matchAll(/actionUrl:\s*([^,\n]+)/g)].map((match) => match[1].trim());
		expect(actionUrls.length).toBeGreaterThan(0);
		for (const url of actionUrls) expect(url).toMatch(/^(consoleLink\()?"\/[^"]*"\)?$/);
	});

	it("makes a console path whole and leaves an absolute URL alone", () => {
		expect(consoleLink("/settings/billing")).toBe("https://console.anlyon.com/settings/billing");
		expect(absoluteActionUrl("/settings/billing")).toBe("https://console.anlyon.com/settings/billing");
		expect(absoluteActionUrl("https://example.com/x")).toBe("https://example.com/x");
		expect(absoluteActionUrl("//evil.example/x")).toBe("//evil.example/x");
	});

	it("email, Slack and Discord send every action URL through absoluteActionUrl", () => {
		for (const path of [
			"src/core/notifications/email-service.ts",
			"src/core/integrations/slack-service.ts",
			"src/core/integrations/discord-service.ts",
		]) {
			expect(readFileSync(join(serverRoot, path), "utf8")).toContain("absoluteActionUrl(notification.actionUrl)");
		}
	});
});
