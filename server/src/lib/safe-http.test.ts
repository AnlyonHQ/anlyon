import { describe, expect, it } from "vitest";
import { isLinkLocalOrMetadata, safeFetch, SsrfBlockedError } from "./safe-http.ts";

describe("isLinkLocalOrMetadata", () => {
  it("refuses the IPv4 metadata and link-local addresses", () => {
    for (const ip of ["169.254.169.254", "169.254.0.1", "0.0.0.0", "100.100.100.200", "168.63.129.16", "::ffff:168.63.129.16"]) {
      expect(isLinkLocalOrMetadata(ip), ip).toBe(true);
    }
  });

  it("refuses IPv6 spellings of them: mapped (dotted and hex), SIIT, compatible and NAT64", () => {
    for (const ip of [
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "::FFFF:A9FE:A9FE",
      "0:0:0:0:0:ffff:a9fe:a9fe",
      "::ffff:0:a9fe:a9fe",
      "::a9fe:a9fe",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::169.254.169.254",
      "::ffff:6464:64c8",
    ]) {
      expect(isLinkLocalOrMetadata(ip), ip).toBe(true);
    }
  });

  it("refuses IPv6 link-local, the unspecified address and AWS's IPv6 metadata endpoint", () => {
    for (const ip of ["fe80::1", "febf::1", "::", "fd00:ec2::254", "fd00:0ec2:0000:0000:0000:0000:0000:0254"]) {
      expect(isLinkLocalOrMetadata(ip), ip).toBe(true);
    }
  });

  it("allows ordinary private addresses, which the private network setting is for", () => {
    for (const ip of ["10.0.0.5", "192.168.1.10", "172.16.0.1", "127.0.0.1", "::1", "fd12:3456::1", "fd00:ec2::253", "::ffff:10.0.0.5", "::ffff:a00:5"]) {
      expect(isLinkLocalOrMetadata(ip), ip).toBe(false);
    }
  });

  it("fails closed on something that is not an address", () => {
    expect(isLinkLocalOrMetadata("not-an-ip")).toBe(true);
  });
});

describe("safeFetch with private networks allowed", () => {
  for (const url of [
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://100.100.100.200/latest/meta-data/",
    "http://168.63.129.16/machine?comp=goalstate",
    "http://169.254.169.254/latest/meta-data/",
  ]) {
    it(`refuses ${url} before connecting`, async () => {
      await expect(safeFetch(url, { method: "GET" }, { allowPrivateNetwork: true })).rejects.toBeInstanceOf(SsrfBlockedError);
    });
  }
});
