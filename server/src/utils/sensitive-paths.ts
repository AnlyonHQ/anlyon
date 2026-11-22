const TOKEN_SEGMENTS: RegExp[] = [
  /(\/api\/v2\/invitations\/)(?!pending(?:[/?#]|$))[^/?#\s"']+/g,
  /(\/invite\/)[^/?#\s"']+/g,
];

export function redactSensitivePath(value: string): string {
  let out = value;
  for (const pattern of TOKEN_SEGMENTS) out = out.replace(pattern, "$1[token]");
  return out;
}
