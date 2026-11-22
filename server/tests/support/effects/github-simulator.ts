import { randomBytes } from "node:crypto";
import { gitBlobSha } from "../../../src/core/effects/adapters/github-file.ts";

export type GitHubFault =
  | "lose_response_after_commit"
  | "connect_refused"
  | "http_502_after_commit"
  | "http_502_before_commit"
  | "hide_commits";

interface SimCommit { sha: string; message: string; path: string; branch: string; date: string }

function networkError(code: string): Error {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return error;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export class GitHubSimulator {
  readonly tokens = new Set<string>(["ghp_simulatorToken000000000000000000"]);
  readonly repos = new Map<string, { defaultBranch: string }>();
  readonly files = new Map<string, { content: string; sha: string }>();
  readonly commits: SimCommit[] = [];
  readonly hosts: string[] = [];
  readonly faults: { write: GitHubFault[]; lookup: GitHubFault[] } = { write: [], lookup: [] };
  writes = 0;

  addRepo(full: string, defaultBranch = "main") {
    this.repos.set(full, { defaultBranch });
    return this;
  }

  setFile(full: string, branch: string, path: string, content: string) {
    this.files.set(`${full}@${branch}:${path}`, { content, sha: gitBlobSha(content) });
    return this;
  }

  externalWrite(full: string, branch: string, path: string, content: string, message = "external edit") {
    this.setFile(full, branch, path, content);
    this.commits.push({ sha: randomBytes(20).toString("hex"), message, path, branch, date: new Date().toISOString() });
  }

  rewriteHistory(drop: (commit: SimCommit) => boolean) {
    const kept = this.commits.filter((c) => !drop(c));
    this.commits.length = 0;
    this.commits.push(...kept);
    return this;
  }

  file(full: string, branch: string, path: string) {
    return this.files.get(`${full}@${branch}:${path}`);
  }

  fault(where: "write" | "lookup", fault: GitHubFault) {
    this.faults[where].push(fault);
    return this;
  }

  fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> => {
    const u = new URL(url);
    this.hosts.push(u.hostname);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (!this.tokens.has((headers.authorization ?? "").replace(/^Bearer /, ""))) return json(401, { message: "Bad credentials" });
    const method = (init.method ?? "GET").toUpperCase();
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return json(404, { message: "Not Found" });
    const full = `${m[1]}/${m[2]}`;
    const repo = this.repos.get(full);
    if (!repo) return json(404, { message: "Not Found" });
    const rest = m[3] ?? "";

    if (method === "GET" && rest === "") return json(200, { full_name: full, default_branch: repo.defaultBranch });

    if (rest.startsWith("/contents/")) {
      const path = rest.slice("/contents/".length).split("/").map(decodeURIComponent).join("/");
      if (method === "GET") {
        const branch = u.searchParams.get("ref") ?? repo.defaultBranch;
        const file = this.file(full, branch, path);
        if (!file) return json(404, { message: "Not Found" });
        return json(200, {
          type: "file", path, sha: file.sha, size: Buffer.byteLength(file.content), encoding: "base64",
          content: Buffer.from(file.content, "utf8").toString("base64").replace(/.{60}/g, "$&\n"),
        });
      }
      if (method === "PUT") return this.put(full, path, JSON.parse(init.body ?? "{}"));
    }

    if (method === "GET" && rest === "/commits") {
      const fault = this.faults.lookup.shift();
      const branch = u.searchParams.get("sha") ?? repo.defaultBranch;
      const path = u.searchParams.get("path");
      const since = u.searchParams.get("since");
      const list = fault === "hide_commits" ? [] : this.commits
        .filter((c) => c.branch === branch && (!path || c.path === path) && (!since || c.date >= since))
        .reverse();
      const perPage = Number(u.searchParams.get("per_page") ?? 30);
      const page = Number(u.searchParams.get("page") ?? 1);
      return json(200, list.slice((page - 1) * perPage, page * perPage)
        .map((c) => ({ sha: c.sha, commit: { message: c.message, author: { date: c.date } } })));
    }

    return json(404, { message: "Not Found" });
  };

  private put(full: string, path: string, body: { message: string; content: string; sha?: string; branch: string }): Response {
    const fault = this.faults.write.shift();
    if (fault === "connect_refused") throw networkError("ECONNREFUSED");
    if (fault === "http_502_before_commit") return json(502, { message: "Server Error" });
    const current = this.file(full, body.branch, path);
    if (!current) return json(404, { message: "Not Found" });
    if (body.sha !== current.sha) {
      return json(409, { message: `${path} does not match ${body.sha}`, documentation_url: "https://docs.github.com/rest/repos/contents#create-or-update-file-contents" });
    }
    const content = Buffer.from(body.content, "base64").toString("utf8");
    this.setFile(full, body.branch, path, content);
    const commit = { sha: randomBytes(20).toString("hex"), message: body.message, path, branch: body.branch, date: new Date().toISOString() };
    this.commits.push(commit);
    this.writes++;
    if (fault === "lose_response_after_commit") throw networkError("ECONNRESET");
    if (fault === "http_502_after_commit") return json(502, { message: "Server Error" });
    return json(200, { content: { path, sha: this.file(full, body.branch, path)!.sha }, commit: { sha: commit.sha, message: commit.message } });
  }
}
