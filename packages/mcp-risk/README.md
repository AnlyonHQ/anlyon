# @anlyon-dev/risk

The MCP risk engine: a risk class (`read`, `write`, `irreversible`, `destructive`) for every
MCP tool from its definition alone, the findings behind it, and the hash of a tool list. Pure
TypeScript with no runtime dependencies. The same engine runs Anlyon Radar
([radar.anlyon.com](https://radar.anlyon.com)), the public risk index of MCP servers.

`src` and `tests` are kept identical to the engine Radar runs. To change how a tool is classed,
open an issue with the tool definition and the class you expect; a fix lands in both at once.


## Why it is here

When an operator adopts a tool from an upstream MCP server, the console suggests the
class Radar shows for that tool, and pins the adopted version to the hash Radar writes into
`mcp-lock.json`. One engine means a tool never reads `destructive` on Radar and `write` in the
console, and a lockfile and a pin always agree on whether a tool changed.

Suggestions stay suggestions, as with the risk an OpenAPI import suggests: nothing this engine says
is applied without the operator choosing it.

