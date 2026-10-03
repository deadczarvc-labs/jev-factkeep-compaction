# Secrets: what leaves for Jev, what is saved, and what can leak

Since 0.3.0-astra.11 the Claude Code hook writes the full output of every tool result it reduces to a file, so a fact
the stub does not keep is one Read away. Tool outputs can carry secrets (an `env` dump, a config read, a token in an
error). This note is the threat model for those files and what 0.3.0-astra.12 does about it. The scoring request
sent to Jev carries the same history; since 0.3.0-astra.24 it is masked too (see «What leaves for Jev»).

## Before and after

| | before | after |
|---|---|---|
| Full outputs on disk | the session transcript (`~/.claude/projects/…/*.jsonl`), deleted after 30 days by default | the same, plus `<cwd>/.claude/fast-jev/cache/<session>/<tool_use_id>.txt` |
| In backups | if your backup excludes transcripts (`*.jsonl`), it holds no full outputs | exclude `**/cache` too and the saved outputs stay out |
| In git | — | `<cwd>/.claude/fast-jev/cache/.gitignore` with `*` |
| In search indexes | — | exclude `.claude` and `cache` folders from local indexers |
| Lifetime | 30 days (transcript cleanup) | 30 days: older saved outputs are emptied |

## What the hook does

- **Masks secret values** before writing (`src/secrets.ts`, `redactSecrets`): 36 value-based families —
  OpenAI/Anthropic/OpenRouter `sk-…`, Stripe keys and webhook secrets, GitHub and GitLab tokens, npm, PyPI, Shopify,
  Hugging Face, Google API keys and `ya29.` access tokens, Slack tokens and webhooks, Discord webhooks
  (`discord.com` and `discordapp.com`), AWS access keys and secret keys, Azure account keys and SAS signatures
  (`sig=` only with `sv=` in the same query, or a host `*.core.windows.net`), JWTs, `Bearer …` tokens, private key blocks (PEM, PGP, PuTTY, cut short too), age keys,
  Perplexity, xAI, Groq, Sakana, Keenable, SendGrid, Telegram bot tokens, the password in `scheme://user:pass@host`.
  A match that is one repeated character (`sk-xxxxxxxx…`) is a placeholder and stays. The transcript keeps the
  original; the saved copy does not become one more place a key lives.
- **Writes under `cache/`**, which backups and indexers skip, with a `.gitignore` that ignores everything.
- **Expires**: once a day, saved outputs older than 30 days are overwritten with nothing (`$.fs` cannot delete a
  file; the empty file keeps its name, a `tool_use_id`).
- **Sanitizes names**: session ids and `tool_use_id`s keep only `[A-Za-z0-9_.-]`, so no id can write outside the
  session folder.
- **Caps** every file at 4 MiB.
- **Opt-out**: `saveFullOutputs: false` writes nothing.

## What leaves for Jev

### API key and a single destination

`provider` defaults to `typesafe`, with full endpoint `https://api.typesafe.ai/v1/systemone` and
only `TYPESAFE_API_KEY`. OpenRouter uses `https://openrouter.ai/api/v1/systemone` and only
`OPENROUTER_API_KEY`; Vercel uses `https://ai-gateway.vercel.sh/typesafe/v1/systemone` and only
`AI_GATEWAY_API_KEY`. Neither credentials, a token prefix nor a hostname selects a provider.
All use the same redacting System One body and numeric `noul` response contract. There is no native
evaluation adapter or automatic recipient, model or key switch after an error.

OpenRouter, Vercel and remote custom endpoints require literal `allowThirdPartyEgress: true`,
after the final plugin options merge and before any key lookup or HTTP. Strings such as `"true"`
are invalid. Consent permits sharing fitted history, goal and questions with the service and its
model provider; masking does not remove all private, personal or commercial information. It makes
no no-training, zero-retention or free-service promise. Account/BYOK/fallback provisioning is not done.

An explicit `apiKey` takes precedence even when empty. Otherwise library code reads only the selected
namespace, and the hook uses one literal `$.env.get` then only the same `settings.env` entry.
Custom requires an explicit full compatible URL and key; no ambient namespace is available. Remote
custom needs consent; only written loopback `127.0.0.1`, `localhost` or `[::1]`, optionally with a
port, avoids it for HTTP or HTTPS. Normalized aliases are not trusted loopback. The issuer of an
arbitrary explicit token cannot be proved locally: this prevents automatic mixing, not manual misuse.

The shared `checkBaseUrl` in `src/request.ts` checks the endpoint before building a request;
the pure provider resolver invokes it before credential reads. Named endpoints must match exactly,
not an SDK prefix or a normalized URL with a different path, port, slash, query or fragment. Custom
absolute `https://` URLs need the consent policy above; `http://` is allowed only on `127.0.0.1`, `localhost` or
`[::1]`, with or without a port. Non-loopback HTTP, other schemes, malformed URLs and userinfo
are rejected with `baseUrl must be https:// or a loopback http:// URL`, without the URL or
credentials in the error message. The hook falls back to the existing built-in summary, just
as when the key is missing; it does not resend the key to another Jev provider.

URL validation and consent do not prove an HTTPS recipient trustworthy. The body masking below
does not hide the Authorization header's key from the selected server. Native `JevClient` fetch
uses `redirect: 'error'`, retains the round AbortSignal and rejects before fetch when already aborted.
Loopback tests exercise a successful System One response and a poisoned 307 redirect: the first
recipient is contacted once, the second receives neither a request body nor Authorization.
Injected transports must honor these controls themselves.

The host's `$.http.fetch` declarations expose neither redirects nor cancellation; no fake control
is added through a cast. Its confinement is UNKNOWN until a separate real-host known-positive and
redirect-negative probe. Third-party hook routes remain disabled by default and are not release-ready
without that gate; only native library opt-in confinement is verified here. Authenticated provider
compatibility/account availability also remains unverified. Any live probe requires separate approval,
synthetic state and the chosen service's own key, never a real transcript.

Configuration errors are deterministic and do not echo URLs, keys or raw options. The hook checks
even empty/pinned-only history before compaction/cache/offload and delegates once to the existing
built-in summary on failure. Fallback output preservation remains unchanged. Transport snapshots
are frozen per registration; a provider/model/URL change requires reload and cached-answer reset.
The low-level `buildJevRequest` still accepts compatible full URLs without a consent gate because it
does not send HTTP; caller-owned transports must enforce consent themselves. HTTP error-body safety
and retry/partial handling belong to the separate transport-error changes, not this provider policy.

Every compaction sends Jev a state: the conversation's texts and tool inputs (results are replaced by a short note).
Before 0.3.0-astra.24 that state went out as is, so a key pasted into a prompt or written by a tool call reached the
scoring service. Since astra.24 two layers mask it; the rules are adapted from upstream fast-jev-compaction#98
(socialadsmentor):

1. `compact` (`stateGroups`) builds every state from a masked view of the history, before tool inputs are truncated
   and texts abridged to fit: a key cut in half by a limit would no longer match its family. Exact values the caller
   holds are masked too (`secrets`; the hook and `compactMessages` pass their own API key).
2. `buildJevRequest` masks the request body once more: every string with its field name in view (`{"password": …}`)
   and every object key. This is the only layer for a caller that builds its own state.

On top of the families, what leaves the machine also loses (`redactForEgress`). A secret name has a last
segment in `password`, `passwd`, `pwd`, `pass`, `passphrase`, `secret`, `token`, `apikey`, `credential(s)`, or it is
one of `api_key`, `access_key`, `secret_key`, `private_key`, `client_secret`, `encryption_key`, `master_key`,
`signing_key`, `account_key`, `shared_access_key`, `SecretString`, `SecretBinary`, `SecretAccessKey`, `Cookie`,
`Set-Cookie`, `Authorization`, `Proxy-Authorization` (any case or style; a leading `_` is allowed, as in
`_authToken`). A compound `*_key` is a secret only with one of those prefixes, so `primary_key`, `foreign_key`,
`partition_key`, `sort_key`, `cache_key`, `idempotency_key` and `public_key` stay, and so does a keyword that is not
the last segment (`token_type`, `max_tokens`, `secret_name`, `password_policy`). Bare `key` is not a secret. Bare
`auth` is, only when the value is base64 of 16 characters or more.

A quoted value (`"`, `'`, `\"`, `\'`) is a literal and is masked, except a reference or a path. A dotenv line
(optional `export`, an `UPPER_SNAKE` name, `=` with no spaces, at the start of the line) masks the rest of the line
up to ` #`. Other unquoted values that are code stay (`const token = accessToken;`, a type, a call, member access).
A reference is the whole string: `${VAR}`, `${{ … }}`, `$VAR`, `%VAR%`, `<name>`, `{{ … }}`. A path is relative with
two or more segments, or absolute (`/`, `~/`, `C:\`), of letters of any alphabet, digits and `_.@-`, with no `+`
or `=` and no opaque segment of 20 characters or more.

Flags `--(segment-){0,2}(password|passwd|pass|passphrase|secret|token|api-key|apikey)(-segment){0,3}` mask the value
after `=` or a space (`--secret-string`, `--secret-access-key`), quoted or not. So do `az keyvault secret set
--value`, `aws ssm put-parameter --value`, and `gh secret set --body` or `-b`. ODBC `PWD={…}` and `Password={…}`
lose the braced value. `Cookie` and `Set-Cookie` lose each pair of 8 characters or more; `-b` and `--cookie` count
only on `curl`. Also, as before: any `Authorization` header value; `curl -u`, `mysql -p`, `docker login -p`,
`sshpass -p`, `redis-cli -a`, `-passout pass:`, `-storepass`, `ldapsearch -w`, `cmdkey /pass:`,
`ConvertTo-SecureString "…"`; `.netrc` passwords; `prefix_<40+ random>` keys. A pure hex string of any length is
not random, so a sha512 stays. Tool names stay. These name rules are kept out of the saved copies, which an agent
reads back and which must not lose ordinary values like `cache_key=…`.

The Hermes engine (deadczarvc/hermes-jev-compaction) masks its scoring request with Hermes' own redactor.

## Measured

- 5995 tool outputs from the evaluation transcripts (25 subagent transcripts and four 1500-message tails of real
  sessions): 0 values of a known family; 6 field-name hits (`api_key: …`), all code references (`env.X`,
  `process.env.X`), a placeholder or a test marker.
- Masking changed 0 of the 5995 outputs and removed none of the 392 preregistered facts (the astra.12 families;
  not re-measured for the astra.24 set: UNKNOWN).
- Tests: every family is masked with the text around it kept; placeholders, field names and ordinary facts are left
  alone; a hostile `tool_use_id` stays inside the session folder; expired files are emptied, fresh ones kept. The
  sample keys are built at run time, so no key-shaped literal sits in the repository.

## Metadata-only audit

The optional Claude hook audit is disabled by default (`auditLog: false`, no audit process or
filesystem I/O), independently of saved tool outputs. It stores only schema-allowlisted enums,
validated/redacted bounded identifiers, timestamps and finite nullable numeric counters at
`<user-home>/.claude/fast-jev/cache/audit/compactions.jsonl`. It never collects transcript content,
tool names or scores, raw exceptions, inputs/outputs, cwd/goal/commands, headers, endpoint URLs or
user-selected model strings. Before/after estimates are measured in memory on the same original
visible-text/input/canonical-result domain; only numbers reach disk. Existing known-value/family
redaction is a second barrier for identifiers, not a guarantee of recognizing arbitrary secrets.

The standalone bundled Node script owns the filesystem; no Node filesystem import is reachable
from the hook or pure `src/index.ts` graph. Its argv has only the explicitly trusted runtime,
bundled script and fixed operation; the sanitized event arrives through bounded stdin. Windows
requires a separately verified hidden launcher. Unavailable capabilities, unsafe paths, lock
contention, corruption and I/O refusal degrade to bounded enums, never a sandbox read-modify-write
fallback. No raw payload/path/error is written to stderr or stdout. Compaction and UI fault
isolation remain independent of sink success.

Private real-parent checks reject traversal, symlinks, junctions and hard-linked target files.
New POSIX directories/files use 0700/0600. Windows access is restricted to current-user and SYSTEM
ACLs, read back before ACK; unexpected explicit principals fail closed. This is a local-user trust
boundary, not protection against the same user or an administrator replacing trusted runtimes.
Metadata lengths and scoped session identifiers remain sensitive: exclude this cache from backups,
indexes and sharing. No network or telemetry sink, daemon, install hook or new dependency is added.

One exclusive sidecar lock covers append, dedupe, whole-attempt pruning and tail repair. A live or
unverifiable stale lock is never stolen by age or PID alone. After a writer crash, recovery must
independently prove the exact owner/start identity absent; this version does not guess a recovery.
A partial final line is discarded only under that lock; malformed complete lines or unknown schema
stop writes without overwriting the file. ACK means fsync plus exact event read-back. Windows ACL
checks and durability are exercised offline; a real hook-loader and silent-window/focus probe
remains a separate enablement gate.

Retained limits are 4096 bytes/record, 1048576 bytes/file, 500 attempt groups, 2592000000 ms age.
Equality at the age cutoff survives. Writes and explicit `--maintenance` prune; maintenance reports
`retention_checked_at`. No timer guarantees deletion on an idle/stopped host. Disable does not delete
prior records. Readers treat begin-without-final as UNKNOWN/incomplete, keep auto requests out of
compaction counts, and never equate returned/precompute with applied (`host_applied: null`).

## What is left

- A secret outside the families — a password in free text, an internal token with no fixed prefix — is written as
  is. The transcript already holds it; the saved copy is a second place. The request to Jev catches more of them
  (names, flags, headers) but not a bare password in prose.
- The project folder can travel where `~/.claude` does not: a Docker build context without a `.dockerignore` entry,
  a cloud-synced project folder, a zip sent to someone. `.claude/fast-jev/` is worth adding to those ignore lists.
- Other tools and agents that read hidden folders of the project can read the saved outputs.
- Expiry runs only when the hook runs: a project not opened for months keeps its files until the next compaction
  there. An expired file is empty but keeps its name.
