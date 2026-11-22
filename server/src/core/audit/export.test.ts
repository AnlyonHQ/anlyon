import { describe, expect, it } from "vitest";
import { AUDIT_SCHEMA, type AuditExportEvent } from "./event-schema.ts";
import { CSV_COLUMNS, csvCell, csvRow, exportChunks, toReadableStream } from "./export.ts";

function event(id: string, data: Record<string, unknown> = {}): AuditExportEvent {
  return {
    schema: AUDIT_SCHEMA,
    id,
    sequence: 1,
    type: "action.succeeded",
    category: "invocation",
    occurredAt: "2026-10-19T00:00:00.000Z",
    workspaceId: "w",
    environmentId: "e",
    actor: { type: "api_key", id: "key_1" },
    resource: { type: "invocation", id: "inv_1" },
    outcome: "succeeded",
    data,
    context: { requestId: "req_1" },
  };
}

async function* chunks(...batches: AuditExportEvent[][]) {
  for (const batch of batches) yield batch;
}

async function collect(generator: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const part of generator) out += part;
  return out;
}

const META = { generatedAt: "2026-10-19T00:00:00.000Z", workspaceId: "w", filters: { from: "a", to: "b" } };

describe("CSV cells", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('say "hi", then\nleave')).toBe('"say ""hi"", then\nleave"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
  });

  it("defuses values a spreadsheet would run as a formula", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("writes data as JSON in one cell and one value per column", () => {
    const line = csvRow(event("aud_1", { actionName: "refund" }));
    expect(line.startsWith("aud_1,1,2026-10-19T00:00:00.000Z,action.succeeded,invocation,succeeded,w,e,api_key,key_1,,invocation,inv_1,req_1,,")).toBe(true);
    expect(line.endsWith('"{""actionName"":""refund""}"')).toBe(true);
  });
});

describe("the export stream", () => {
  it("produces one valid JSON document across chunks, with the count", async () => {
    const text = await collect(exportChunks("json", META, chunks([event("aud_1")], [event("aud_2"), event("aud_3")])));
    const parsed = JSON.parse(text);
    expect(parsed.schema).toBe("anlyon.audit.export.v1");
    expect(parsed.filters).toEqual({ from: "a", to: "b" });
    expect(parsed.events.map((e: AuditExportEvent) => e.id)).toEqual(["aud_1", "aud_2", "aud_3"]);
    expect(parsed.count).toBe(3);
  });

  it("is still valid JSON when nothing matches", async () => {
    const parsed = JSON.parse(await collect(exportChunks("json", META, chunks())));
    expect(parsed.events).toEqual([]);
    expect(parsed.count).toBe(0);
  });

  it("writes a CSV header then one CRLF-terminated row per record", async () => {
    const text = await collect(exportChunks("csv", META, chunks([event("aud_1"), event("aud_2")])));
    const lines = text.split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
  });

  it("streams as bytes", async () => {
    const response = new Response(toReadableStream(exportChunks("json", META, chunks([event("aud_1")]))));
    expect(JSON.parse(await response.text()).count).toBe(1);
  });
});
