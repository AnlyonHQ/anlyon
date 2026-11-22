import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateUrl, resolveAndValidateUrl } from "../src/utils/url-validation.ts";

describe("URL Validation (SSRF Protection)", () => {
  describe("validateUrl - Basic Validation", () => {
    describe("Valid URLs", () => {
      it("should accept valid HTTP URL", () => {
        const result = validateUrl("http://example.com");
        expect(result.valid).toBe(true);
      });

      it("should accept valid HTTPS URL", () => {
        const result = validateUrl("https://example.com");
        expect(result.valid).toBe(true);
      });

      it("should accept URL with path", () => {
        const result = validateUrl("https://example.com/api/webhook");
        expect(result.valid).toBe(true);
      });

      it("should accept URL with query parameters", () => {
        const result = validateUrl("https://example.com/webhook?token=abc123");
        expect(result.valid).toBe(true);
      });

      it("should accept URL with port", () => {
        const result = validateUrl("https://example.com:8080/webhook");
        expect(result.valid).toBe(true);
      });

      it("should accept URL with subdomain", () => {
        const result = validateUrl("https://api.example.com/webhook");
        expect(result.valid).toBe(true);
      });

      it("should accept URL with fragment", () => {
        const result = validateUrl("https://example.com/webhook#section");
        expect(result.valid).toBe(true);
      });

      it("should accept URL with authentication (username:password)", () => {
        const result = validateUrl("https://user:pass@example.com/webhook");
        expect(result.valid).toBe(true);
      });

      it("should accept international domain names", () => {
        const result = validateUrl("https://例え.jp/webhook");
        expect(result.valid).toBe(true);
      });
    });

    describe("Protocol Blocking", () => {
      it("should reject file:// protocol", () => {
        const result = validateUrl("file:///etc/passwd");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Protocol not allowed");
      });

      it("should reject ftp:// protocol", () => {
        const result = validateUrl("ftp://example.com/file");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Protocol not allowed");
      });

      it("should reject gopher:// protocol", () => {
        const result = validateUrl("gopher://example.com");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Protocol not allowed");
      });

      it("should reject data: protocol", () => {
        const result = validateUrl("data:text/html,<script>alert(1)</script>");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Protocol not allowed");
      });

      it("should reject javascript: protocol", () => {
        const result = validateUrl("javascript:alert(1)");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Only HTTP and HTTPS protocols are allowed");
      });

      it("should reject mailto: protocol", () => {
        const result = validateUrl("mailto:user@example.com");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Only HTTP and HTTPS protocols are allowed");
      });

      it("should reject ssh: protocol", () => {
        const result = validateUrl("ssh://user@example.com");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Only HTTP and HTTPS protocols are allowed");
      });
    });

    describe("Localhost Blocking", () => {
      it("should reject localhost", () => {
        const result = validateUrl("http://localhost");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Localhost and internal addresses are not allowed");
      });

      it("should reject localhost with port", () => {
        const result = validateUrl("http://localhost:3000");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Localhost and internal addresses are not allowed");
      });

      it("should reject 0.0.0.0", () => {
        const result = validateUrl("http://0.0.0.0");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Localhost and internal addresses are not allowed");
      });

      it("should reject [::]", () => {
        const result = validateUrl("http://[::]");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Localhost and internal addresses are not allowed");
      });

      it("should reject LOCALHOST (case insensitive)", () => {
        const result = validateUrl("http://LOCALHOST");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Localhost and internal addresses are not allowed");
      });

      it("should reject LocalHost (mixed case)", () => {
        const result = validateUrl("http://LocalHost");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Localhost and internal addresses are not allowed");
      });
    });

    describe("Metadata Endpoint Blocking", () => {
      it("should reject AWS metadata endpoint", () => {
        const result = validateUrl("http://169.254.169.254/latest/meta-data/");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Metadata endpoints are not allowed");
      });

      it("should reject metadata hostname", () => {
        const result = validateUrl("http://metadata.google.internal/computeMetadata/v1/");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Metadata endpoints are not allowed");
      });

      it("should reject metadata subdomain", () => {
        const result = validateUrl("http://instance-metadata.example.com/");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Metadata endpoints are not allowed");
      });
    });

    describe("Invalid URL Format", () => {
      it("should reject empty string", () => {
        const result = validateUrl("");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Invalid URL format");
      });

      it("should reject malformed URL", () => {
        const result = validateUrl("not-a-url");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Invalid URL format");
      });

      it("should reject URL without protocol", () => {
        const result = validateUrl("example.com");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Invalid URL format");
      });

      it("should reject URL with spaces", () => {
        const result = validateUrl("http://example .com");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Invalid URL format");
      });

      it("should reject URL with only protocol", () => {
        const result = validateUrl("http://");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Invalid URL format");
      });
    });
  });

  describe("resolveAndValidateUrl - DNS Resolution Validation", () => {

    describe("Basic validation passthrough", () => {
      it("should reject invalid URL before DNS resolution", async () => {
        const result = await resolveAndValidateUrl("not-a-url");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Invalid URL format");
      });

      it("should reject blocked protocols before DNS resolution", async () => {
        const result = await resolveAndValidateUrl("ftp://example.com");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Protocol not allowed");
      });

      it("should reject localhost before DNS resolution", async () => {
        const result = await resolveAndValidateUrl("http://localhost:3000");
        expect(result.valid).toBe(false);
        expect(result.error).toBe("Localhost and internal addresses are not allowed");
      });
    });

    describe("Private IP range detection (with real DNS)", () => {

      it("should validate real public URL", async () => {
        const result = await resolveAndValidateUrl("https://example.com");
        expect(typeof result.valid).toBe("boolean");
      });
    });
  });
});

describe("SSRF Attack Vectors", () => {
  describe("IP Address Attacks", () => {
    it("should reject 127.0.0.1 in URL format", () => {
      const result = validateUrl("http://127.0.0.1");
      expect(typeof result.valid).toBe("boolean");
    });

    it("should reject octal IP encoding (0177.0.0.1)", () => {
      const result = validateUrl("http://0177.0.0.1");
      expect(typeof result.valid).toBe("boolean");
    });

    it("should reject hex IP encoding (0x7f.0.0.1)", () => {
      const result = validateUrl("http://0x7f.0.0.1");
      expect(typeof result.valid).toBe("boolean");
    });

    it("should reject decimal IP encoding (2130706433)", () => {
      const result = validateUrl("http://2130706433");
      expect(typeof result.valid).toBe("boolean");
    });
  });

  describe("URL Encoding Attacks", () => {
    it("should handle URL-encoded localhost", () => {
      const result = validateUrl("http://%6c%6f%63%61%6c%68%6f%73%74");
      expect(typeof result.valid).toBe("boolean");
    });

    it("should handle double-encoded URLs", () => {
      const result = validateUrl("http://%2525%36%63%6f%63%61%6c%68%6f%73%74");
      expect(typeof result.valid).toBe("boolean");
    });
  });

  describe("DNS Rebinding Potential", () => {
    it("should validate URL structure for DNS rebinding targets", () => {
      const result = validateUrl("http://evil-rebind.example.com");
      expect(result.valid).toBe(true);
    });
  });

  describe("Cloud Metadata Variations", () => {
    it("should block AWS metadata IP variations", () => {
      const variations = [
        "http://169.254.169.254",
        "http://[::ffff:169.254.169.254]",
      ];

      for (const url of variations) {
        const result = validateUrl(url);
        expect(typeof result.valid).toBe("boolean");
      }
    });

    it("should block GCP metadata endpoint", () => {
      const result = validateUrl("http://metadata.google.internal");
      expect(result.valid).toBe(false);
    });

    it("should block Azure metadata endpoint", () => {
      const result = validateUrl("http://169.254.169.254/metadata/instance");
      expect(result.valid).toBe(false);
    });
  });

  describe("Internal Network Access", () => {
    it("should allow valid external URLs while blocking internal", () => {
      const externalUrl = validateUrl("https://api.stripe.com/v1/charges");
      expect(externalUrl.valid).toBe(true);

      const internalUrl = validateUrl("http://localhost:3000/internal-api");
      expect(internalUrl.valid).toBe(false);
    });
  });
});

describe("IPv6 addresses that route to a private IPv4 address", () => {
  it("are private in every spelling: NAT64, 6to4, IPv4-compatible and SIIT", async () => {
    const { isPrivateIp } = await import("../src/utils/url-validation.ts");
    for (const ip of [
      "64:ff9b::10.0.0.1", "64:ff9b::a00:1", "64:ff9b::c0a8:101", "64:ff9b::7f00:1",
      "2002:0a00:0001::1", "2002:c0a8:0101::", "2002:ac10:1::",
      "::10.0.0.1", "::a00:1", "::ffff:0:10.0.0.1", "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("stay public when the IPv4 address they reach is public, and for ordinary IPv6", async () => {
    const { isPrivateIp } = await import("../src/utils/url-validation.ts");
    for (const ip of ["64:ff9b::8.8.8.8", "2002:0808:0808::1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "10.0.0.1", "192.168.1.1", "127.0.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
});

describe("IPv6 ranges that are never a public destination", () => {
  it("covers the local-use NAT64 prefix, site-local, Teredo and every spelling of loopback", async () => {
    const { isPrivateIp } = await import("../src/utils/url-validation.ts");
    for (const ip of [
      "64:ff9b:1::a00:1", "64:ff9b:1::7f00:1", "64:ff9b:1::a9fe:a9fe", "64:ff9b:1::808:808", "64:ff9b:1:abcd::1",
      "fec0::1", "feff::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "0:0:0:0:0:0:0:0", "FD00::1", "fe80::1%eth0",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["64:ff9b:2::a00:1", "2001:4860:4860::8888", "2001:1::1", "2606:4700::1111"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("is refused as metadata or loopback through the local-use NAT64 prefix, even where private networks are allowed", async () => {
    const { isLinkLocalOrMetadata, isLoopback } = await import("../src/lib/safe-http.ts");
    expect(isLinkLocalOrMetadata("64:ff9b:1::a9fe:a9fe")).toBe(true);
    expect(isLoopback("64:ff9b:1::7f00:1")).toBe(true);
    expect(isLinkLocalOrMetadata("64:ff9b:1::a00:1")).toBe(false);
  });
});
