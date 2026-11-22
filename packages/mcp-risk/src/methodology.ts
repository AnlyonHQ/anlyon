import type { MethodologyEntry } from "./types.ts";

export const METHODOLOGY: MethodologyEntry[] = [
  {
    id: "class-name-verb",
    title: "The verb in the tool name",
    description:
      'The first known verb in the tool name sets its class: read words such as "get", "list" and "search" give read; change words such as "create", "update" and "add" give write; money words ("refund", "charge", "payout"), send words ("send", "notify", "reply") and final words ("merge", "publish", "transfer") give irreversible; removal words ("delete", "remove", "cancel", "archive", "revoke") give destructive. "post" followed by "message" or "email" is a send. In a name that is not a read, a money or send word right after a plain verb ("create_refund") and a second verb after "and" also count. A money word followed by "method", "link" or "setting" is configuration, not a payment.',
  },
  {
    id: "class-description-verb",
    title: "The first verb of the description",
    description:
      'The first verb of the description\'s first sentence, after words like "Use this tool to", is read with the same word lists. It sets the class when the name has no known verb, and otherwise can only raise it.',
  },
  {
    id: "class-final-wording",
    title: "Wording that says a change is final",
    description:
      'A description that says "cannot be undone", "irreversible" or "permanently delete" raises the class to at least irreversible.',
  },
  {
    id: "class-money-input",
    title: "An amount and a currency in the input",
    description:
      "An input field named amount with a currency field beside it, at the top level or one object down (amount_money.amount), raises a tool that is not a read to irreversible, because it moves money. Fields such as unit_amount on a price or amount_off on a coupon do not count: they define a number for later.",
  },
  {
    id: "class-recipient-input",
    title: "Recipients in the input",
    description:
      'An input field named "to" or "recipients", at the top level or one object down, raises a tool that is not a read to irreversible, because what it sends cannot be taken back.',
  },
  {
    id: "class-code-input",
    title: "A statement or command in the input",
    description:
      'A top-level string input named "sql", "statement", "command", "cmd", "script", "code", "javascript" or "shell" raises a read to write, because what it runs can change anything it can reach.',
  },
  {
    id: "class-default-write",
    title: "No known verb",
    description:
      "A tool whose name and description name no known verb is counted as a write. A read has to be named, because a read is allowed by default in the permissions block.",
  },
  {
    id: "class-annotations",
    title: "Annotations can only raise a class",
    description:
      "MCP annotations are the server's own hints. destructiveHint: true raises the class to destructive, and readOnlyHint: false raises a read to a write. readOnlyHint: true and destructiveHint: false never lower a class: where they disagree with the tool's own words, the scan reports an annotation conflict instead.",
  },
  {
    id: "tag-private-data",
    title: "Reads private data",
    description:
      'A tool tagged private-data reads files, documents, notes, mail, messages, databases, secrets, calendars, contacts or repositories. It is set when the tool reads (its class is read, or its verb is a read word) and its name or the first sentence of its description names one of these ("read_file", "list_emails", "Get recent messages"), or its input names a file, directory, folder, repository, calendar, database, table, secret or mailbox. A run verb ("execute", "query") with a "sql" or "statement" input also sets it. Read verbs that only check what they are given ("validate", "explain") do not.',
  },
  {
    id: "tag-untrusted-input",
    title: "Reads text someone else wrote",
    description:
      'A tool tagged untrusted-input brings text into the conversation that someone other than the user can write: web pages, inbound email, messages, issues and pull requests, comments, tickets and posts. It is set when the tool reads and its name or first sentence names one of these, when it reads a URL input, when its name says "scrape", "crawl" or "browse", when a browser verb such as "navigate" loads a URL, or when the server marks it openWorldHint: true. An absent openWorldHint is not counted.',
  },
  {
    id: "tag-outbound",
    title: "Can send data out",
    description:
      'A tool tagged outbound can carry data somewhere other people or other systems see it. It is set when its name sends, posts, publishes, shares or forwards ("send_email", "slack_post_message"), when a change verb writes a comment, issue, pull request, message, email, reply or post, when a tool that is not a read or destructive has a destination input (to, cc, bcc, recipients, channel, chat_id, phone), or when a tool that is not destructive takes a URL (url, uri, href, endpoint, webhook, callback_url), because a request to a URL carries whatever is put in it. A read tagged outbound is asked about in the permissions block rather than allowed.',
  },
  {
    id: "exfil-paths",
    title: "Exfiltration paths across a setup",
    description:
      "In a config audit, every combination of a private-data tool, an untrusted-input tool and an outbound tool, on any of the servers, is reported as a path: text from the untrusted tool can ask the agent to read private data with the first and send it out with the last. The three may be one tool. The audit names the tools of every path and the smallest set of tools to deny that breaks them all, which is every tool of the tag with the fewest tools, since a path survives exactly while each tag keeps one tool. Ties go to outbound, then untrusted input. The server page shows the same three counts for one server.",
  },
  {
    id: "hidden-unicode",
    title: "Hidden Unicode",
    description:
      "Characters a person cannot see but a model reads: zero-width characters (U+200B to U+200D, U+2060 to U+2064, U+FEFF, U+180E), bidirectional controls (U+200E, U+200F, U+061C, U+202A to U+202E, U+2066 to U+2069), and tag characters (U+E0000 to U+E007F), which can spell out ASCII text. Checked in the name, titles, description and every string and property name in the input schema. Evidence shows each character as U+XXXX and, for tag characters, the text they spell.",
  },
  {
    id: "model-directed-text",
    title: "Text addressed to the model",
    description:
      'Phrases that address the model rather than describe the tool: tags such as "<IMPORTANT>" or "<SYSTEM>", "ignore previous instructions", "do not tell the user" and similar instructions to keep something from the user, and "before using this tool, read". These are the patterns of published tool-poisoning examples. Checked in the titles, description and input schema strings.',
  },
  {
    id: "sensitive-path",
    title: "References to secrets on disk",
    description:
      "Paths where keys and secrets usually live: ~/.ssh, id_rsa and other SSH key names, .env files, ~/.aws and AWS key names, credentials files and .git-credentials, MCP client configs (mcp.json, claude_desktop_config.json, ~/.cursor/), .netrc, .npmrc, .pypirc, .pgpass, .gnupg, Docker and Kubernetes configs, and /etc/passwd or /etc/shadow.",
  },
  {
    id: "credentials-mention",
    title: 'The word "credentials"',
    description:
      'The word "credential" or "credentials" outside a path. Many tools mention credentials for ordinary reasons, so this is information only.',
  },
  {
    id: "tool-shadowing",
    title: "Mentions of other tools or servers",
    description:
      'A tool that names a tool this server does not list (for example "the send_email tool", "mcp_tool_send_email" or "mcp__other__send_email"), or uses wording such as "other servers", "all other tools" or "when this tool is available". A description that steers how the model uses another server\'s tools is how tool shadowing works. A name counts when it is written as an identifier (send_email, sendEmail) or in quotes, next to the word "tool". Mentions of the server\'s own tools are not reported.',
  },
  {
    id: "base64-blob",
    title: "Base64 strings",
    description:
      "A run of 40 or more base64 characters that mixes upper case, lower case and digits, or ends in = padding, outside a URL. When it decodes to readable text, the text is shown, and the finding is high when that text contains model-directed phrases.",
  },
  {
    id: "long-description",
    title: "Long descriptions",
    description:
      "A description over 2,000 characters. Long descriptions are not wrong in themselves, but they are where extra instructions are easiest to miss, so the length is shown.",
  },
  {
    id: "annotation-conflict",
    title: "Annotations that disagree with the tool",
    description:
      'Where the server\'s annotations disagree with its own definition: readOnlyHint: true on a tool whose name, description or input give a higher class (a tool named "delete_*", for example), destructiveHint: false on a tool whose words say it removes something, destructiveHint: true on a tool named as a read, readOnlyHint: false on a tool named as a read, and readOnlyHint and destructiveHint both true.',
  },
  {
    id: "install-script-network",
    title: "Install scripts that reach the network",
    description:
      'A "preinstall", "install" or "postinstall" script in the package.json that contains curl, wget, fetch or http. npm runs these scripts on install, before the server is started. Read from the published package manifest; the package is never run.',
  },
  {
    id: "install-script",
    title: "Install scripts",
    description:
      'A "preinstall", "install" or "postinstall" script in the package.json that does not reach the network by these patterns. Information only: npm runs it on install.',
  },
  {
    id: "duplicate-tool-name",
    title: "Duplicate tool names",
    description:
      "Two or more tools with the same name in one tools/list. A client keeps one of them, and which one depends on the client.",
  },
  {
    id: "remote-posture",
    title: "Remote endpoint posture",
    description:
      "For every registry entry with a remote endpoint, a scheduled probe records, without credentials: whether the endpoint answers, the HTTP status of an anonymous initialize, whether tools/list is served without credentials, the protocol version it answers with, whether a 401 carries WWW-Authenticate and a resource_metadata pointer, whether /.well-known/oauth-protected-resource (RFC 9728) is published and the authorization servers it names, whether the legacy HTTP+SSE transport is listed, and, from the first authorization server's RFC 8414 or OpenID metadata, whether it offers dynamic client registration (a registration_endpoint) or client ID metadata documents (client_id_metadata_document_supported). It sends initialize, notifications/initialized, tools/list and metadata GETs only, never a credential, never a tool call. Each change of these facts is kept as history and shown in the changes feed.",
  },
  {
    id: "unauth-remote-writes",
    title: "Tools that change things, listed to anyone",
    description:
      "The endpoint served tools/list to a client with no credentials, and the list has write, irreversible or destructive tools. High when any of them is irreversible or destructive. A listed tool is not proof that a call works without credentials, and the probe never calls a tool to find out; it is what the endpoint shows to anyone on the internet.",
  },
  {
    id: "remote-auth-metadata-missing",
    title: "Credentials asked for, no protected resource metadata",
    description:
      "The anonymous initialize answered 401 or 403, and the endpoint publishes no RFC 9728 protected resource metadata: no resource_metadata parameter in WWW-Authenticate and no document at /.well-known/oauth-protected-resource for the endpoint's path or the host root. The MCP authorization specification asks servers to publish it so clients can find the authorization server.",
  },
  {
    id: "definition-hash",
    title: "The definition hash",
    description:
      "Each scan records the sha256 of the server's normalised tool definitions (name, title, description, input schema and annotations, with keys sorted and tools sorted by name). A different hash means a tool definition changed, and the change is shown as a diff.",
  },
  {
    id: "claude-code-permissions",
    title: "The Claude Code permissions block",
    description:
      "A block for .claude/settings.json with one mcp__<server>__<tool> rule per tool: read tools in allow, write and irreversible tools in ask, destructive tools in deny. A read tagged outbound goes in ask. It is built from the same classes and tags as the scan, as a starting point to review, and the tags behind each rule are listed beside it.",
  },
  {
    id: "scope",
    title: "What a scan is and is not",
    description:
      "A scan reads tool definitions only: the tools/list a server publishes and its package manifest. It never runs the package, calls a tool or signs in. Every finding is evidence with a place and an excerpt, found by fixed rules with no model in the loop, and the same definitions always give the same result. No finding is not a safety guarantee: a check only sees the patterns it looks for, and a scan is a point in time.",
  },
];
