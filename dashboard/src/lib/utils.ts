import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export async function copyToClipboard(
	text: string,
): Promise<{ success: boolean; error?: string }> {
	if (!navigator.clipboard) {
		const fallbackResult = fallbackCopyToClipboard(text);
		if (!fallbackResult.success) {
			return {
				success: false,
				error: "Clipboard API not available. Please copy manually.",
			};
		}
		return { success: true };
	}

	try {
		await navigator.clipboard.writeText(text);
		return { success: true };
	} catch (error) {
		const fallbackResult = fallbackCopyToClipboard(text);
		if (!fallbackResult.success) {
			if (error instanceof Error) {
				if (error.name === "NotAllowedError") {
					return {
						success: false,
						error:
							"Clipboard permission denied. Please enable clipboard access.",
					};
				}
				return { success: false, error: `Failed to copy: ${error.message}` };
			}
			return {
				success: false,
				error: "Failed to copy to clipboard. Please copy manually.",
			};
		}
		return { success: true };
	}
}

function fallbackCopyToClipboard(text: string): { success: boolean } {
	const textArea = document.createElement("textarea");
	textArea.value = text;
	textArea.style.position = "fixed";
	textArea.style.left = "-999999px";
	textArea.style.top = "-999999px";
	document.body.appendChild(textArea);
	textArea.focus();
	textArea.select();

	try {
		const successful = document.execCommand("copy");
		document.body.removeChild(textArea);
		return { success: successful };
	} catch {
		document.body.removeChild(textArea);
		return { success: false };
	}
}
