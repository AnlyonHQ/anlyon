# Changelog

All notable changes to the `anlyon-langchain` package. Versions follow
[semantic versioning](https://semver.org/) for 0.x releases: a breaking change
bumps the minor version.

## 0.5.0 (unreleased)

### Breaking changes

- Removed `AnlyonVectorStore`, `AnlyonRetriever` and
  `AnlyonChatMessageHistory`. They were built on the memory and sessions APIs,
  which no longer exist.

### Unchanged

`action_tools` and `AnlyonTracer`.
