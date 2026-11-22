import { describe, expect, it } from "vitest";
import { REDACTED, redactCutTail, redactValues, secretForms } from "../src/utils/redaction.ts";
import { redactSecrets } from "../src/core/actions/template.ts";
import { redact } from "../src/core/effects/transport.ts";

const KEY = "sk_live_51Nabc+/def==ghi&jkl";

describe("a secret echoed by a provider", () => {
  it("is removed as sent, URL-encoded, base64-encoded and JSON-escaped", () => {
    const quoted = 'p"ss\\word\nvalue-1234';
    for (const echoed of [KEY, encodeURIComponent(KEY), Buffer.from(KEY).toString("base64"), Buffer.from(KEY).toString("base64url")]) {
      const out = redactValues(`{"error":"bad key ${echoed} given"}`, [KEY]);
      expect(out).toBe('{"error":"bad key [REDACTED] given"}');
    }
    expect(redactValues(JSON.stringify({ echo: quoted }), [quoted])).toBe('{"echo":"[REDACTED]"}');
  });

  it("is removed by both executors' redaction", () => {
    const body = `token=${encodeURIComponent(KEY)}`;
    expect(redactSecrets(body, new Map([["STRIPE", KEY]]))).toBe("token=[REDACTED]");
    expect(redact(body, [KEY])).toBe("token=[REDACTED]");
  });

  it("leaves text alone when there is nothing to match, and never matches a value too short to be a credential", () => {
    expect(redactValues("nothing to see", [KEY])).toBe("nothing to see");
    expect(secretForms("abc")).toEqual([]);
    expect(redactValues("abc abc", ["abc"])).toBe("abc abc");
  });
});

describe("a secret inside a longer encoded value", () => {
  it("is removed from a Basic credential whatever the user name's length", () => {
    for (const user of ["u", "us", "usr", "user", "api-user-12345"]) {
      const basic = Buffer.from(`${user}:${KEY}`).toString("base64");
      const out = redactValues(`authorization: Basic ${basic}`, [KEY]);
      expect(out).toContain(REDACTED);
      const decoded = Buffer.from(out.replace("authorization: Basic ", "").replace(REDACTED, ""), "base64").toString("latin1");
      expect(decoded).not.toContain(KEY.slice(2, -2));
      expect(out).not.toContain(Buffer.from(KEY).toString("base64").slice(4, 20));
    }
  });

  it("does not match ordinary text for a short secret", () => {
    expect(redactValues("abcdefghijklmnop", ["wxyz"])).toBe("abcdefghijklmnop");
  });
});

describe("two secrets, one containing the other", () => {
  it("removes the longer whole, in either order", () => {
    const short = "tok_abcd1234";
    const long = `${short}_XYZ98765`;
    expect(redactValues(`a ${long} b`, [short, long])).toBe("a [REDACTED] b");
    expect(redactValues(`a ${long} b`, [long, short])).toBe("a [REDACTED] b");
  });
});

describe("a response cut at its size limit", () => {
  const body = (tail: string) => `${"x".repeat(1000)}${tail}`;

  it("loses its end, and with it the leading part of a secret it ends with", () => {
    const out = redactCutTail(body(`{"debug":"authorization was ${KEY.slice(0, 14)}`), [KEY]);
    expect(out.endsWith(REDACTED)).toBe(true);
    expect(out).not.toContain(KEY.slice(0, 8));
    const encoded = encodeURIComponent(KEY);
    expect(redactCutTail(body(`x=${encoded.slice(0, 20)}`), [KEY])).not.toContain(encoded.slice(0, 8));
  });

  it("reads the same whether or not it ends inside a secret", () => {
    const right = redactCutTail(body(KEY.slice(0, 12)), [KEY]);
    const wrong = redactCutTail(body(`${KEY.slice(0, 11)}Z`), [KEY]);
    const none = redactCutTail(body("0123456789ab"), [KEY]);
    expect(right).toBe(wrong);
    expect(right).toBe(none);
    expect(right).toBe(`${"x".repeat(1000 + 12 - 256)}${REDACTED}`);
  });

  it("removes far enough back for a secret longer than the least it removes", () => {
    const long = `sk_${"q7".repeat(400)}`;
    const out = redactCutTail(body(long.slice(0, 700)), [long]);
    expect(out).not.toContain("q7q7");
  });

  it("still removes a whole secret before the cut, and one that straddles where the end is removed", () => {
    expect(redactCutTail(`key ${KEY} ${"y".repeat(600)}`, [KEY])).toBe(`key ${REDACTED} ${"y".repeat(600 - 256)}${REDACTED}`);
    const straddling = redactCutTail(`${"y".repeat(300)}${KEY}${"z".repeat(250)}`, [KEY]);
    expect(straddling).not.toContain(KEY.slice(0, 6));
  });

  it("is left whole when the request carried no secret, and reduced to the mark when shorter than what is removed", () => {
    expect(redactCutTail("short", [])).toBe("short");
    expect(redactCutTail("short", [KEY])).toBe(REDACTED);
  });
});
