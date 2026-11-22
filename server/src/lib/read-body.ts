export async function readBodyLimited(
  response: Response,
  maxBytes: number
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) {
    const text = typeof response.text === "function" ? await response.text() : "";
    const buf = Buffer.from(text, "utf8");
    if (buf.byteLength <= maxBytes) return { text, bytes: buf.byteLength, truncated: false };
    return { text: buf.subarray(0, maxBytes).toString("utf8"), bytes: maxBytes, truncated: true };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const room = maxBytes - bytes;
      if (value.byteLength > room) {
        if (room > 0) chunks.push(value.subarray(0, room));
        bytes += Math.max(room, 0);
        truncated = true;
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return { text: Buffer.concat(chunks).toString("utf8"), bytes, truncated };
}
