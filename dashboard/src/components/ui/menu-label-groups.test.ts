import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
	});
}

describe("menu labels from ui/menu", () => {
	it("sit inside a menu group wherever they are used", () => {
		const offenders = sourceFiles(SRC).filter((file) => {
			const text = readFileSync(file, "utf8");
			if (!/from "@\/components\/ui\/menu"/.test(text)) return false;
			const usesLabel = /<(MenuGroupLabel|DropdownMenuLabel)\b/.test(text);
			const usesGroup =
				/<(MenuGroup|DropdownMenuGroup|MenuRadioGroup|DropdownMenuRadioGroup)\b/.test(
					text,
				);
			return usesLabel && !usesGroup;
		});
		expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
	});
});
