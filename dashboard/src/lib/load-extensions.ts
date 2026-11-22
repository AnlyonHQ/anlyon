import { type ConsoleExtension, registerExtension } from "./extensions";

const modules = import.meta.glob<{ default?: ConsoleExtension }>(
	"../extensions/*/index.{ts,tsx}",
	{ eager: true },
);

export function loadExtensions(
	disabled: boolean = import.meta.env.VITE_ANLYON_EXTENSIONS === "none",
): void {
	if (disabled) return;
	for (const path of Object.keys(modules).sort()) {
		const extension = modules[path]?.default;
		if (extension) registerExtension(extension);
	}
}
