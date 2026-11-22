import type { AuditExportEvent } from "./event-schema.ts";

export const EXPORT_SCHEMA = "anlyon.audit.export.v1" as const;

export const CSV_COLUMNS = [
  "id", "sequence", "occurredAt", "type", "category", "outcome", "workspaceId", "environmentId",
  "actorType", "actorId", "actorOnBehalfOf", "resourceType", "resourceId", "requestId", "ip", "data",
] as const;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(event: AuditExportEvent): string {
  const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    id: event.id,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    type: event.type,
    category: event.category,
    outcome: event.outcome,
    workspaceId: event.workspaceId,
    environmentId: event.environmentId,
    actorType: event.actor.type,
    actorId: event.actor.id,
    actorOnBehalfOf: event.actor.onBehalfOf ?? null,
    resourceType: event.resource?.type ?? null,
    resourceId: event.resource?.id ?? null,
    requestId: event.context?.requestId ?? null,
    ip: event.context?.ip ?? null,
    data: event.data,
  };
  return CSV_COLUMNS.map((column) => csvCell(values[column])).join(",");
}

export interface ExportMeta {
  generatedAt: string;
  workspaceId: string;
  filters: Record<string, unknown>;
}

export async function* exportChunks(
  format: "json" | "csv",
  meta: ExportMeta,
  source: AsyncIterable<AuditExportEvent[]>,
): AsyncGenerator<string> {
  let count = 0;
  if (format === "csv") {
    yield `${CSV_COLUMNS.join(",")}\r\n`;
    for await (const chunk of source) {
      count += chunk.length;
      yield chunk.map((event) => `${csvRow(event)}\r\n`).join("");
    }
    return;
  }
  const head = JSON.stringify({ schema: EXPORT_SCHEMA, ...meta });
  yield `${head.slice(0, -1)},"events":[`;
  for await (const chunk of source) {
    const body = chunk.map((event) => JSON.stringify(event)).join(",");
    if (body) yield `${count > 0 ? "," : ""}${body}`;
    count += chunk.length;
  }
  yield `],"count":${count}}`;
}

export function toReadableStream(chunks: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}
