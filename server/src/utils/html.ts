export function escapeHtml(input: unknown): string {
  if (input === null || input === undefined) return "";
  const s = typeof input === "string" ? input : String(input);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
