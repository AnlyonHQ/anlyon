import { createHash } from "node:crypto";
import { ValidationError } from "../../../utils/errors.ts";
import type {
  DispatchRequest,
  EffectAdapter,
  Interpretation,
  Observation,
  PreviewDraft,
  ReconcileRequest,
} from "../adapter.ts";

export interface GitHubFileConfig {
  owner: string;
  repo: string;
  branch: string;
  pathPrefix: string | null;
  allowDefaultBranch: boolean;
}

const API = "https://api.github.com";
export const GITHUB_MAX_TEXT_BYTES = 64 * 1024;
export const GITHUB_MAX_RESPONSE_BYTES = 1024 * 1024;
export const GITHUB_LOOKUP_MAX_PAGES = 5;
const PREVIEW_TEXT_LIMIT = 20_000;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,200}(?<!\/)$/;

export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

export function effectTrailer(effectId: string): string {
  return `Anlyon-Effect: ${effectId}`;
}

function checkPath(path: string, prefix: string | null): void {
  if (!path || path.length > 500 || path.startsWith("/") || path.endsWith("/") || path.includes("\0") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new ValidationError("path must be a relative file path without empty, '.' or '..' segments.");
  }
  if (prefix && !path.startsWith(prefix)) throw new ValidationError(`This action may only change files under ${prefix}.`);
}

function parsePathPrefix(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ValidationError("pathPrefix must be a string.");
  if (raw === "") return null;
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed === "" || trimmed.startsWith("/") || trimmed.includes("\0") ||
      trimmed.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new ValidationError("pathPrefix must be a relative directory without empty, '.' or '..' segments.");
  }
  return `${trimmed}/`;
}

function decodeText(base64: string): string {
  const bytes = Buffer.from(base64.replace(/\n/g, ""), "base64");
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").compare(bytes) !== 0 || text.includes("\0")) {
    throw new ValidationError("The existing file is not UTF-8 text; this action supports text files only.");
  }
  return text;
}

function clip(text: string): { text: string; truncated: boolean } {
  return text.length > PREVIEW_TEXT_LIMIT ? { text: text.slice(0, PREVIEW_TEXT_LIMIT), truncated: true } : { text, truncated: false };
}

function contentsUrl(config: GitHubFileConfig, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${API}/repos/${config.owner}/${config.repo}/contents/${encoded}`;
}

const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "anlyon-effects" };

export const githubFileAdapter: EffectAdapter<GitHubFileConfig> = {
  type: "github.file_update",
  version: "1",
  title: "GitHub file update",
  successDefinition: "A commit on the configured branch, created by this write and carrying `Anlyon-Effect: <effect id>`, exists.",
  successEvidence: "provider_record",
  hosts: ["api.github.com"],
  maxResponseBytes: GITHUB_MAX_RESPONSE_BYTES,
  capabilities: {
    idempotency: {
      supported: false,
      retentionSeconds: null,
      description: "GitHub's contents API has no idempotency key. Duplicate writes are prevented by the blob-SHA precondition instead.",
    },
    outcomeLookup: {
      supported: true,
      description: "By a commit on the branch whose message carries this effect's trailer. Finding one confirms success; not finding one never proves the write failed, so it stays unknown until an operator resolves it.",
    },
    conditionalMutation: {
      supported: true,
      description: "The write sends the blob SHA shown at review. GitHub refuses it if the file changed since, so a stale review cannot overwrite newer content.",
    },
    asynchronousCompletion: { supported: false, description: "The commit exists when GitHub answers." },
    compensation: {
      supported: true,
      actionHint: "Invoke this action again with the previous content and `compensates` set to this effect. That is a new governed effect.",
      description: "Reverted by a new, separately reviewed file update.",
    },
    sameKeyReplay: {
      supported: false,
      windowSeconds: null,
      description: "Not supported: GitHub has no idempotency key, and the blob-SHA precondition cannot tell a restored file from an unwritten one. Reconcile, or resolve with evidence.",
    },
    reversible: { supported: true, description: "The previous content remains in git history and can be restored by a new effect." },
    unsupported: ["Creating or deleting files", "Binary files", `Files over ${GITHUB_MAX_TEXT_BYTES} bytes`, "More than one file per effect"],
    impactDimensions: ["resource_mutations"],
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content", "message"],
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      message: { type: "string" },
    },
  },

  parseConfig(raw) {
    const config = (raw ?? {}) as Record<string, unknown>;
    const owner = typeof config.owner === "string" ? config.owner : "";
    const repo = typeof config.repo === "string" ? config.repo : "";
    const branch = typeof config.branch === "string" ? config.branch : "";
    if (!NAME.test(owner) || !NAME.test(repo)) throw new ValidationError("github.file_update needs an explicit `owner` and `repo`.");
    if (!BRANCH.test(branch)) {
      throw new ValidationError("github.file_update needs an explicit designated `branch`. The repository default is never assumed.");
    }
    const pathPrefix = parsePathPrefix(config.pathPrefix);
    const extra = Object.keys(config).filter((key) => !["owner", "repo", "branch", "pathPrefix", "allowDefaultBranch"].includes(key));
    if (extra.length) throw new ValidationError(`github.file_update config does not accept: ${extra.join(", ")}`);
    return { owner, repo, branch, pathPrefix, allowDefaultBranch: config.allowDefaultBranch === true };
  },

  checkCredential(credential) {
    if (credential.trim().length < 20) throw new ValidationError("The GitHub credential is not a token.");
  },

  authHeaders(credential) {
    return { Authorization: `Bearer ${credential}` };
  },

  normalize(config, input) {
    const path = typeof input.path === "string" ? input.path : "";
    checkPath(path, config.pathPrefix);
    if (typeof input.content !== "string") throw new ValidationError("content must be a string.");
    const content = input.content;
    if (Buffer.byteLength(content, "utf8") > GITHUB_MAX_TEXT_BYTES) {
      throw new ValidationError(`content exceeds ${GITHUB_MAX_TEXT_BYTES} bytes.`);
    }
    if (content.includes("\0")) throw new ValidationError("content must be text.");
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message || message.length > 200 || message.includes("Anlyon-Effect:")) {
      throw new ValidationError("message must be 1-200 characters and must not contain an Anlyon-Effect trailer.");
    }
    const repository = `${config.owner}/${config.repo}`;
    return {
      target: {
        account: repository,
        resourceType: "github.file",
        resourceId: `${config.branch}:${path}`,
        resourceKey: `github:${repository}@${config.branch}:${path}`,
        display: { Repository: repository, Branch: config.branch, Path: path },
      },
      request: { repository, branch: config.branch, path, content, message, contentBlobSha: gitBlobSha(content) },
    };
  },

  describeImpact() {
    return [{ dimension: "resource_mutations", amount: 1, bound: "exact" }];
  },

  async preparePreview(ctx, operation): Promise<PreviewDraft> {
    const req = operation.request as { branch: string; path: string; content: string; message: string; contentBlobSha: string };
    const repo = await ctx.transport.request({ method: "GET", url: `${API}/repos/${ctx.config.owner}/${ctx.config.repo}`, headers });
    if (repo.status !== 200) throw new ValidationError(`Repository ${operation.target.account} is not readable (HTTP ${repo.status}).`);
    const defaultBranch = (repo.json as Record<string, unknown> | null)?.default_branch;
    if (defaultBranch === req.branch && !ctx.config.allowDefaultBranch) {
      throw new ValidationError(`${req.branch} is the repository's default branch; this action is limited to a designated test branch.`);
    }
    const file = await ctx.transport.request({
      method: "GET",
      url: `${contentsUrl(ctx.config, req.path)}?ref=${encodeURIComponent(req.branch)}`,
      headers,
    });
    if (file.status === 404) throw new ValidationError(`${req.path} does not exist on ${req.branch}. This action updates existing files only.`);
    const body = (file.json ?? {}) as Record<string, unknown>;
    if (file.status !== 200 || body.type !== "file" || typeof body.sha !== "string") {
      throw new ValidationError(`${req.path} on ${req.branch} is not a readable file (HTTP ${file.status}).`);
    }
    if (typeof body.size === "number" && body.size > GITHUB_MAX_TEXT_BYTES) {
      throw new ValidationError(`${req.path} is larger than ${GITHUB_MAX_TEXT_BYTES} bytes.`);
    }
    if (body.encoding !== "base64" || typeof body.content !== "string") {
      throw new ValidationError(`${req.path} content is not available as text.`);
    }
    const before = decodeText(body.content);
    if (body.sha === req.contentBlobSha) throw new ValidationError(`${req.path} already has exactly this content.`);
    const shownBefore = clip(before);
    const shownAfter = clip(req.content);
    return {
      blocks: [
        {
          type: "fields",
          title: "File update",
          fields: [
            { label: "Repository", value: operation.target.account },
            { label: "Branch", value: req.branch },
            { label: "Path", value: req.path },
            { label: "Commit message", value: req.message },
            { label: "Reviewed blob", value: body.sha },
          ],
        },
        {
          type: "text_diff",
          title: "Content change",
          path: req.path,
          before: shownBefore.text,
          after: shownAfter.text,
          truncated: shownBefore.truncated || shownAfter.truncated,
        },
      ],
      preconditions: { blobSha: body.sha, branch: req.branch, path: req.path },
      evidence: {
        source: "provider_lookup",
        observedAt: new Date(),
        impliedOutcome: null,
        providerIds: { blobSha: body.sha },
        summary: `${req.path}@${req.branch} is blob ${body.sha} at review.`,
        details: { bytes: Buffer.byteLength(before, "utf8") },
      },
    };
  },

  async dispatch(ctx, request: DispatchRequest): Promise<Observation> {
    const req = request.operation.request as { path: string; content: string; message: string; branch: string };
    const response = await ctx.transport.request({
      method: "PUT",
      url: contentsUrl(ctx.config, req.path),
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `${req.message}\n\n${effectTrailer(request.effectId)}`,
        content: Buffer.from(req.content, "utf8").toString("base64"),
        sha: request.preconditions.blobSha,
        branch: req.branch,
      }),
    });
    return { kind: "response", status: response.status, json: response.json, bodyText: response.bodyText, observedAt: new Date() };
  },

  interpret(request, observation): Interpretation {
    if (observation.kind === "transport_error") {
      return {
        outcome: observation.requestSent ? "unknown" : "failed",
        partialEffect: "none",
        providerReference: null,
        evidence: [{
          source: "system",
          observedAt: observation.observedAt,
          impliedOutcome: observation.requestSent ? "unknown" : "failed",
          providerIds: {},
          summary: observation.requestSent
            ? "The file update may have reached GitHub; no response was received."
            : "The file update never left Anlyon.",
          details: { error: observation.message },
        }],
      };
    }
    const body = (observation.json ?? {}) as Record<string, unknown>;
    if (observation.status === 200 || observation.status === 201) {
      const commit = (body.commit ?? {}) as Record<string, unknown>;
      const content = (body.content ?? {}) as Record<string, unknown>;
      const commitSha = typeof commit.sha === "string" ? commit.sha : null;
      const expected = (request.operation.request as { contentBlobSha: string }).contentBlobSha;
      return {
        outcome: commitSha ? "succeeded" : "unknown",
        partialEffect: "none",
        providerReference: commitSha,
        evidence: [{
          source: "provider_response",
          observedAt: observation.observedAt,
          impliedOutcome: commitSha ? "succeeded" : "unknown",
          providerIds: {
            ...(commitSha ? { commitSha } : {}),
            ...(typeof content.sha === "string" ? { blobSha: content.sha } : {}),
          },
          summary: commitSha ? `GitHub created commit ${commitSha}.` : "GitHub answered without a commit id.",
          details: { blobMatchesRequest: content.sha === expected },
        }],
      };
    }
    const conflict = observation.status === 409 || observation.status === 422;
    const unknown = observation.status >= 500 || (conflict && request.kind === "replay");
    return {
      outcome: unknown ? "unknown" : "failed",
      partialEffect: "none",
      providerReference: null,
      evidence: [{
        source: "provider_response",
        observedAt: observation.observedAt,
        impliedOutcome: unknown ? "unknown" : "failed",
        providerIds: {},
        summary: unknown && conflict
          ? `GitHub refused the replay (HTTP ${observation.status}). The original write may have landed; reconciliation decides.`
          : unknown
          ? `GitHub answered HTTP ${observation.status}; the commit may or may not exist.`
          : conflict
            ? `GitHub refused the write (HTTP ${observation.status}): the file no longer matches the reviewed version.`
            : `GitHub refused the write (HTTP ${observation.status}).`,
        details: {
          status: observation.status,
          staleVersion: conflict,
          message: typeof body.message === "string" ? body.message.slice(0, 300) : null,
        },
      }],
    };
  },

  async reconcile(ctx, request: ReconcileRequest): Promise<Interpretation> {
    const req = request.operation.request as { path: string; branch: string; contentBlobSha: string };
    const trailer = effectTrailer(request.effectId);
    const since = new Date((request.firstDispatchedAt ?? request.now).getTime() - 5 * 60_000).toISOString();
    const ours: Array<Record<string, unknown>> = [];
    let exhaustive = false;
    for (let page = 1; page <= GITHUB_LOOKUP_MAX_PAGES; page++) {
      const commits = await ctx.transport.request({
        method: "GET",
        url: `${API}/repos/${ctx.config.owner}/${ctx.config.repo}/commits?sha=${encodeURIComponent(req.branch)}&path=${encodeURIComponent(req.path)}&since=${encodeURIComponent(since)}&per_page=100&page=${page}`,
        headers,
      });
      if (commits.status !== 200 || !Array.isArray(commits.json)) {
        return lookupUnknown(request.now, `Commit history could not be read (HTTP ${commits.status}).`);
      }
      const items = commits.json as Array<Record<string, unknown>>;
      for (const item of items) {
        const message = ((item.commit ?? {}) as Record<string, unknown>).message;
        if (typeof message === "string" && message.split("\n").some((line) => line.trim() === trailer)) ours.push(item);
      }
      if (items.length < 100) {
        exhaustive = true;
        break;
      }
    }
    if (ours.length > 1) {
      return {
        outcome: "unknown",
        partialEffect: "possible",
        providerReference: null,
        evidence: [{
          source: "provider_lookup", observedAt: request.now, impliedOutcome: "unknown",
          providerIds: Object.fromEntries(ours.map((c, i) => [`commit${i + 1}`, String(c.sha)])),
          summary: `${ours.length} commits carry this effect's trailer; the evidence is contradictory.`, details: {},
        }],
      };
    }
    if (ours.length === 1) {
      const sha = String(ours[0].sha);
      return {
        outcome: "succeeded",
        partialEffect: "none",
        providerReference: sha,
        evidence: [{
          source: "provider_lookup", observedAt: request.now, impliedOutcome: "succeeded",
          providerIds: { commitSha: sha },
          summary: `Commit ${sha} on ${req.branch} carries this effect's trailer.`, details: {},
        }],
      };
    }

    const file = await ctx.transport.request({
      method: "GET",
      url: `${contentsUrl(ctx.config, req.path)}?ref=${encodeURIComponent(req.branch)}`,
      headers,
    });
    const currentSha = typeof (file.json as Record<string, unknown> | null)?.sha === "string"
      ? String((file.json as Record<string, unknown>).sha) : null;
    const holdsRequested = currentSha !== null && currentSha === req.contentBlobSha;
    const unchanged = currentSha !== null && currentSha === (request.preconditions.blobSha ?? null);
    return {
      outcome: "unknown",
      partialEffect: holdsRequested ? "possible" : "none",
      providerReference: null,
      evidence: [{
        source: "provider_lookup", observedAt: request.now, impliedOutcome: holdsRequested ? "unknown" : null,
        providerIds: currentSha ? { blobSha: currentSha } : {},
        summary: [
          exhaustive
            ? `No commit on ${req.branch} since ${since} carries this effect's trailer.`
            : `No commit carrying this effect's trailer in the ${GITHUB_LOOKUP_MAX_PAGES * 100} most recent commits to this file; the search stopped there.`,
          holdsRequested
            ? "The file holds the requested content, which does not prove Anlyon made the change."
            : unchanged
              ? "The file still holds the reviewed content, which does not prove the write never landed (it may have been restored)."
              : "The file holds other content.",
          "Branch history can hide a commit that landed, so this stays unknown: resolve it with evidence.",
        ].join(" "),
        details: { exhaustive, searchedPages: exhaustive ? undefined : GITHUB_LOOKUP_MAX_PAGES, holdsRequested, unchanged },
      }],
    };
  },
};

function lookupUnknown(now: Date, summary: string): Interpretation {
  return {
    outcome: "unknown",
    partialEffect: "none",
    providerReference: null,
    evidence: [{ source: "provider_lookup", observedAt: now, impliedOutcome: null, providerIds: {}, summary, details: {} }],
  };
}
