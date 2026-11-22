# @anlyon/feature-flags

Which features this build ships, and at what release stage. One table, read by
the dashboard and the API, so hiding a feature and removing its endpoints is a
single edit instead of two that drift apart.

## Stages

| stage | dashboard | API |
| --- | --- | --- |
| `unavailable` | hidden from nav; routes redirect to `/dashboard` | endpoints answer `404` |
| `beta` | visible, labelled **Beta** | served |
| `release-candidate` | visible, labelled **RC** | served |
| `generally-available` | visible, unlabelled | served |

Promoting a feature is a one-line edit to `FEATURE_STAGES` in `src/index.ts`,
then a deploy of whatever consumes it. Both apps have to be deployed for a
change to be visible end to end.

## What this is not

Stages describe the **build**, not the viewer. There is no flag service, no
per-user or per-workspace targeting, and no runtime toggle -- everyone on a
given deploy sees the same thing, and the whole table is readable in the
browser bundle. A staged rollout to some workspaces needs per-request state
and belongs elsewhere.

## Product stage

`PRODUCT_STAGE` (same file) is the one product-wide switch: it says what
*Anlyon as a whole* is, not what any single feature is. The dashboard reads it
for the persistent "Beta" badge and the public-beta banner; the API can read it
later for response headers. `productStageLabel()` returns the same
`Beta`/`RC`/`null` wording as the per-feature markers, so flipping
`PRODUCT_STAGE` to `generally-available` at GA makes every beta marker disappear
with one edit. `BETA_POLICY_URL` points at the page that defines what beta means
for a paying customer.

## Using it

The package is dependency-free and framework-free on purpose: the same file
runs in a browser bundle and in the API process. It answers *whether*; each
consumer owns *how to refuse*, because that part is framework-specific.

```ts
import { isFeatureEnabled, featureStageLabel } from "@anlyon/feature-flags";
```

- **Dashboard** — `src/lib/feature-flags.ts` turns a disabled feature into a
  router redirect; `<FeatureStageBadge>` renders the Beta/RC marker; the
  navigation leaves out a disabled feature's pages (`src/components/shell/nav-config.ts`).
- **API** — `src/api/middleware/feature-gate.ts` turns a disabled feature into
  a `404`, mounted ahead of auth on the affected router.

Adding a feature means adding a key here, gating its routes on both sides, and
tagging its nav entry. A key with no call sites gates nothing.
