# API contract policy

Status: Accepted  
Decision date: 2026-07-13

## Decision

`openapi.yaml` is the canonical contract for Anlyon's public HTTP API.

It is the core server's contract: every operation a core module serves (`src/core/edition/modules.ts`),
and the components and tags those operations use, and nothing else. A server extension
(`src/core/extensions/README.md`) that serves operations of its own carries their contract in its
directory, as a fragment of this document (`src/extensions/<name>/openapi.yaml`), with its share of
the SDK manifest, the examples, the breaking-change acknowledgements and the changelog at the same
relative paths. `scripts/contract.ts` merges the core document with each extension's share in name
order and never overwrites. The merged contract is what the server serves, and every gate below
judges it; with no extension it is this document alone. The core document must stand alone: every
`$ref` in it resolves inside it.

The backend may continue to use Hono and Zod internally, but a route is not public or release-ready until its OpenAPI operation exists and its implementation is proven against that operation. The TypeScript SDK, Python SDK, documentation, examples, and compatibility checks must consume or test against this same artifact.

This contract-first decision is intentional. The current Hono routes are hand-authored and do not carry enough response, authentication, error, example, or compatibility metadata to generate a trustworthy public contract from route code.

## Contract boundary

The canonical document covers:

- all supported `/api/v2` developer operations;
- bearer API-key authentication and required key scopes;
- session-only operations that are intentionally exposed to the dashboard;
- unauthenticated public callbacks/webhooks when they are part of the supported platform surface;
- standard errors, request IDs, pagination, idempotency, deprecation, and examples.

Better Auth's implementation endpoints under `/api/auth/*`, health endpoints, and `/api/internal/*` worker endpoints are operational/internal contracts and are not part of the public SDK contract. They require separate tests and must never appear as public SDK methods.

## Invariants

For every supported operation:

```text
backend route = OpenAPI operation = SDK surface = documentation = contract test
```

- OpenAPI path parameters use `{parameter}` while Hono implementation parameters use `:parameter`.
- API keys use `Authorization: Bearer <key>`.
- Browser sessions use the documented cookie authentication scheme and origin/CSRF protections.
- Every operation has a unique, stable `operationId`.
- Every operation declares its audience (`public`, `dashboard`, `webhook`, or `internal`) and authentication behavior.
- Every API-key operation declares the scopes it requires.
- Every mutation declares whether and how it supports `Idempotency-Key`.
- Every success and error response carries a request ID through the `X-Request-Id` header.
- Error codes are stable programmatic identifiers. Human-readable messages may improve without a version bump.

## Compatibility policy

The `/api/v2` contract follows additive evolution by default.

Non-breaking changes include optional request fields, new response fields, new operations, and new enum values only where the schema explicitly documents that clients must tolerate unknown values.

Breaking changes include removing or renaming operations/fields, making optional input required, narrowing accepted values, changing authentication or scope requirements, changing status/envelope semantics, or reinterpreting an existing field. A breaking change requires a new API version or a documented deprecation and migration window.

Deprecated operations and fields must include:

- an OpenAPI `deprecated: true` marker;
- a replacement and migration guide;
- an announced removal date;
- runtime deprecation headers where practical;
- SDK deprecation annotations.

## Change workflow

1. Edit `openapi.yaml` (or the extension's share, for an operation only an extension serves) first and run `pnpm api:contract:report`.
2. Review compatibility impact.
3. Implement the backend behavior and contract tests.
4. Update or generate both SDKs.
5. Update docs, changelog, and runnable examples.
6. Run the complete contract gate before merge.

`pnpm api:contract:check` validates route coverage, that each operation is in the document its modules say, and the complete OpenAPI quality policy. `pnpm api:contract:examples` deterministically materializes request and response examples for every operation at `docs/generated/api-examples.json` (built from the core document alone) and, for each extension, `src/extensions/<name>/docs/generated/api-examples.json` (what the merged contract adds or changes); CI compares those artifacts byte-for-byte with the contract and rejects invalid explicit or generated examples. OAuth redirects and `204` responses are validated as header/no-content contracts rather than forced into a JSON envelope.

The same gate compares every `x-anlyon-audience: public` operation with
`contracts/sdk-operation-support.json` and each extension's share of it. A new, removed, or reclassified public
operation fails until both official SDKs have been implemented, tested, audited,
and the sorted support snapshot is intentionally updated.

During the initial convergence period, `api:contract:report` reports existing drift without blocking unrelated development. Once route coverage reaches 100%, the same checker becomes the blocking `api:contract:check` CI gate. The allowed gap may only shrink during convergence.

## Response conventions to converge on

Successful singular responses:

```json
{
  "success": true,
  "data": {}
}
```

Successful collection responses:

```json
{
  "success": true,
  "data": [],
  "pagination": {
    "limit": 20,
    "nextCursor": null,
    "hasMore": false
  }
}
```

Errors:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request could not be validated.",
    "details": {}
  },
  "requestId": "req_..."
}
```

New collection APIs use cursor pagination. Existing page/offset APIs retain their behavior until explicitly versioned or migrated with a compatibility window.
