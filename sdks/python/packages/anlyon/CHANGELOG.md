# Changelog

All notable changes to the `anlyon` package. Versions follow
[semantic versioning](https://semver.org/) for 0.x releases: a breaking change
bumps the minor version.

## 0.10.0 (unreleased)

### Breaking changes

The retired features' API endpoints no longer exist, so their client
namespaces are removed:

- `client.messages`, `client.schedules`, `client.queues`, `client.workflows`,
  `client.memory` (with `memory.collections` and `memory.wait_for_job`),
  `client.cache`, `client.files`, `client.sessions`, `client.context` and the
  URL groups and flow control namespaces, on `Client` and `AsyncClient`, and
  their resource classes (and `Async*` twins) in `anlyon.resources`.
- `anlyon.integrations.AnlyonSession`, the OpenAI Agents SDK session over the
  sessions API.
- `logs.for_message()` and `logs.for_schedule()`, and the `schedule_id` log
  filter. Execution logs are message (event-webhook delivery) logs only.
- `analytics.schedule_stats()` and `analytics.schedule_executions()`.
- Budgets no longer have the `memoryOps` and `cacheLookups` dimensions; the
  API rejects them in `dimension_caps`.

### Unchanged

`client.events`, `client.dlq`, the rest of `client.logs` and
`client.analytics`, `Receiver` and every governed-execution resource.
