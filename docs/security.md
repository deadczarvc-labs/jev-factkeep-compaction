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

## What is left

- A secret outside the families — a password in free text, an internal token with no fixed prefix — is written as
  is. The transcript already holds it; the saved copy is a second place. The request to Jev catches more of them
  (names, flags, headers) but not a bare password in prose.
- The project folder can travel where `~/.claude` does not: a Docker build context without a `.dockerignore` entry,
  a cloud-synced project folder, a zip sent to someone. `.claude/fast-jev/` is worth adding to those ignore lists.
- Other tools and agents that read hidden folders of the project can read the saved outputs.
- Expiry runs only when the hook runs: a project not opened for months keeps its files until the next compaction
  there. An expired file is empty but keeps its name.
