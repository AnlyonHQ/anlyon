import { describe, expect, it } from "vitest";
import {
	actorLabel,
	describeEnvironments,
	describeRecords,
	EMPTY_SINK_FORM,
	eventLabel,
	eventTypesToRecords,
	exportPath,
	parseEventTypes,
	recordsToEventTypes,
	sinkDestination,
	sinkHealth,
	sinkHost,
	sinkRequest,
	withSinkType,
} from "./audit";

describe("sinkRequest", () => {
	it("sends only the fields a webhook uses, and no credentials", () => {
		expect(
			sinkRequest({
				...EMPTY_SINK_FORM,
				name: " SIEM ",
				url: " https://siem.example.com/a ",
				bucket: "left over from another type",
			}),
		).toEqual({
			name: "SIEM",
			type: "webhook",
			eventTypes: ["*"],
			startFrom: "now",
			includeHistory: false,
			config: { url: "https://siem.example.com/a" },
		});
	});

	it("drops empty optional S3 fields instead of sending empty strings", () => {
		const body = sinkRequest({
			...EMPTY_SINK_FORM,
			type: "s3",
			name: "Bucket",
			bucket: "acme-audit",
			region: "eu-west-1",
			accessKeyId: "AKIAEXAMPLE",
			secretAccessKey: "<secret>",
		});
		expect(body).toMatchObject({
			config: { bucket: "acme-audit", region: "eu-west-1" },
			credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "<secret>" },
		});
		expect(body.config).not.toHaveProperty("endpoint");
		expect(body.config).not.toHaveProperty("prefix");
	});

	it("builds Datadog and Splunk bodies", () => {
		expect(
			sinkRequest({
				...EMPTY_SINK_FORM,
				type: "datadog",
				name: "DD",
				apiKey: "<key>",
				site: "datadoghq.eu",
			}),
		).toMatchObject({
			config: { site: "datadoghq.eu" },
			credentials: { apiKey: "<key>" },
		});
		expect(
			sinkRequest({
				...EMPTY_SINK_FORM,
				type: "splunk",
				name: "S",
				url: "https://splunk.example.com:8088",
				token: "<token>",
				index: "security",
			}),
		).toMatchObject({
			config: { url: "https://splunk.example.com:8088", index: "security" },
			credentials: { token: "<token>" },
		});
	});

	it("reads event types separated by commas or spaces, defaulting to everything", () => {
		expect(parseEventTypes("approval.*, policy.updated  member.*")).toEqual([
			"approval.*",
			"policy.updated",
			"member.*",
		]);
		expect(parseEventTypes("  ")).toEqual(["*"]);
	});
});

describe("exportPath", () => {
	it("treats the end date as inclusive, in UTC days", () => {
		const path = exportPath("ws_1", {
			from: "2026-10-01",
			to: "2026-10-19",
			format: "csv",
		});
		const params = new URL(`https://x${path}`).searchParams;
		expect(path.startsWith("/workspaces/ws_1/audit/export?")).toBe(true);
		expect(params.get("from")).toBe("2026-10-01T00:00:00.000Z");
		expect(params.get("to")).toBe("2026-10-20T00:00:00.000Z");
		expect(params.get("format")).toBe("csv");
		expect(params.has("environmentId")).toBe(false);
	});

	it("passes the filters that are set", () => {
		const params = new URL(
			`https://x${exportPath("ws_1", { from: "2026-10-01", to: "2026-10-01", format: "json", environmentId: "env_1", type: " approval.* ", action: "refund" })}`,
		).searchParams;
		expect([
			params.get("environmentId"),
			params.get("type"),
			params.get("action"),
		]).toEqual(["env_1", "approval.*", "refund"]);
	});
});

describe("labels", () => {
	it("describes destinations and actors briefly", () => {
		expect(sinkDestination({ type: "s3", config: { bucket: "b" } })).toBe(
			"s3://b/anlyon-audit",
		);
		expect(
			sinkDestination({ type: "datadog", config: { site: "datadoghq.eu" } }),
		).toBe("datadoghq.eu");
		expect(actorLabel({ type: "api_key", id: "0123456789abcdef" })).toBe(
			"API key 01234567",
		);
		expect(actorLabel({ type: "system", id: null })).toBe("Anlyon");
		expect(
			actorLabel(
				{ type: "user", id: "user_ada" },
				{ user_ada: "Ada Lovelace" },
			),
		).toBe("Ada Lovelace");
		expect(actorLabel({ type: "user", id: "user_gone" })).toBe("A member");
	});

	it("names record types in words", () => {
		expect(eventLabel("approval.approved")).toBe("Approval approved");
		expect(eventLabel("api_key.rolled_back")).toBe("API key rolled back");
		expect(eventLabel("audit.dead_letter.redelivered")).toBe(
			"Audit dead letter redelivered",
		);
	});
});

describe("the records selector", () => {
	it("sends everything for All records, and prefixes for picked categories", () => {
		expect(recordsToEventTypes({ mode: "all" })).toEqual(["*"]);
		expect(
			recordsToEventTypes({
				mode: "categories",
				categories: ["approvals", "keys"],
			}),
		).toEqual(["approval.*", "api_key.*"]);
		expect(
			recordsToEventTypes({ mode: "categories", categories: ["members"] }),
		).toEqual(["member.*", "invitation.*", "group.*", "workspace.*"]);
	});

	it("never sends an empty list: no category picked means everything", () => {
		expect(recordsToEventTypes({ mode: "categories", categories: [] })).toEqual(
			["*"],
		);
	});

	it("passes advanced free text through as typed", () => {
		expect(
			recordsToEventTypes({
				mode: "custom",
				text: "policy.updated, approval.*",
			}),
		).toEqual(["policy.updated", "approval.*"]);
	});

	it("only offers patterns the API accepts", () => {
		const accepted = /^(\*|[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?)$/;
		const all = recordsToEventTypes({
			mode: "categories",
			categories: [
				"approvals",
				"actions",
				"policies",
				"members",
				"keys",
				"sso",
				"environments",
				"connections",
				"limits",
				"audit",
				"instance",
			],
		});
		for (const pattern of all) expect(pattern).toMatch(accepted);
		expect(all.length).toBeLessThanOrEqual(50);
	});

	it("reads a sink's types back into categories, or into free text when they do not line up", () => {
		expect(eventTypesToRecords(["*"])).toEqual({ mode: "all" });
		expect(eventTypesToRecords(["approval.*", "policy.*"])).toEqual({
			mode: "categories",
			categories: ["approvals", "policies"],
		});
		expect(eventTypesToRecords(["policy.updated"])).toEqual({
			mode: "custom",
			text: "policy.updated",
		});
	});

	it("describes records in words, never as a bare *", () => {
		expect(describeRecords(["*"])).toBe("All records");
		expect(describeRecords(["approval.*", "policy.*"])).toBe(
			"Approvals and Policies",
		);
		expect(describeRecords(["approval.*", "policy.*", "api_key.*"])).toBe(
			"Approvals, Policies and API keys",
		);
		expect(describeRecords(["policy.updated"])).toBe("Policy updated");
		expect(describeRecords(["api_key.*", "member.*"])).toBe(
			"API keys and Members",
		);
	});
});

describe("a sink in the list", () => {
	const base = { status: "active" as const, enabled: true, openDeadLetters: 0 };
	it("is Delivering, Paused or Failing", () => {
		expect(sinkHealth(base)).toBe("delivering");
		expect(sinkHealth({ ...base, enabled: false })).toBe("paused");
		expect(sinkHealth({ ...base, status: "disabled" })).toBe("paused");
		expect(sinkHealth({ ...base, status: "retrying" })).toBe("failing");
		expect(sinkHealth({ ...base, openDeadLetters: 2 })).toBe("failing");
	});

	it("shows the host, not the whole URL", () => {
		expect(
			sinkHost({
				type: "webhook",
				config: { url: "https://siem.example.com/ingest/anlyon/v2?x=1" },
			}),
		).toBe("siem.example.com");
		expect(
			sinkHost({ type: "s3", config: { bucket: "acme", region: "eu-west-1" } }),
		).toBe("acme (eu-west-1)");
		expect(
			sinkHost({ type: "datadog", config: { site: "datadoghq.eu" } }),
		).toBe("datadoghq.eu");
	});

	it("names environments instead of counting them", () => {
		expect(describeEnvironments(null)).toBe("All environments");
		expect(
			describeEnvironments(["e1"], [{ id: "e1", name: "Production" }]),
		).toBe("Production");
		expect(describeEnvironments(["e1", "e2"])).toBe("2 environments");
	});
});

describe("switching destination", () => {
	it("keeps the name and records and fills in that destination's defaults", () => {
		const form = {
			...EMPTY_SINK_FORM,
			name: "Archive",
			url: "https://old.example.com",
			records: {
				mode: "categories" as const,
				categories: ["approvals" as const],
			},
		};
		const s3 = withSinkType(form, "s3");
		expect(s3).toMatchObject({
			type: "s3",
			name: "Archive",
			url: "",
			prefix: "anlyon-audit",
			records: form.records,
		});
		expect(withSinkType(form, "splunk").sourcetype).toBe("anlyon:audit");
		expect(withSinkType(form, "datadog").service).toBe("anlyon");
	});
});
