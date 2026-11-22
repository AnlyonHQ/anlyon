export function matchEventType(patterns: string[], type: string): boolean {
  return patterns.some((pattern) => matchOne(pattern, type));
}

function matchOne(pattern: string, type: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === "*") return true;
  if (trimmed === type) return true;

  if (trimmed.endsWith(".*")) {
    const prefix = trimmed.slice(0, -1);
    return type.startsWith(prefix) && type.length > prefix.length;
  }

  return false;
}
