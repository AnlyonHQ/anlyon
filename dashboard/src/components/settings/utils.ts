export function maskSecret(secret: string): string {
	if (!secret) return "";
	const prefix = secret.slice(0, 8);
	return `${prefix}${"•".repeat(Math.min(secret.length - 8, 24))}`;
}
