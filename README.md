<div align="center">

# jev-factkeep-compaction

**Jev-guided context compaction for Claude Code that never erases a tool call: reproducible reads shrink to a
note, observations keep their errors, ids, codes and counts.**

[![CI](https://github.com/deadczarvc-labs/jev-factkeep-compaction/actions/workflows/ci.yml/badge.svg)](https://github.com/deadczarvc-labs/jev-factkeep-compaction/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/deadczarvc-labs/jev-factkeep-compaction?include_prereleases&sort=semver)](https://github.com/deadczarvc-labs/jev-factkeep-compaction/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Why facts are lost](docs/why-facts-are-lost.md) · [Evidence](docs/evidence.md) · [Install](#install-in-claude-code) · [Hermes port](https://github.com/deadczarvc/hermes-jev-compaction) · [Upstream (not maintained)](https://github.com/tamaratran/fast-jev-compaction)

</div>

## Why this fork

A fork of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction). The plugin keeps the
upstream id `fast-jev-compaction`, so it replaces an upstream install as is.

Upstream has had no commits since 2026-09-18 and is not maintained. The pull requests this fork sent there
(#118, #119, #120, #122) are closed; development continues here, and issues and pull requests are welcome in this
repository.

The upstream goal is to drop what re-running a tool would give back and never lose an exact error, path or command.
Upstream erases every call Jev scores as stale, observations of the world included. Here nothing is erased:

- a reproducible read of files (`Read`, `Grep`, `Glob`, `ls`, `cat`, `rg`, `git log`…) longer than 3000 chars
  shrinks to a one-line re-run note;
- any other result keeps its head, its fact lines (errors, HTTP codes, paths, versions, ids, endpoints, counts,
  receipts; up to 30% of its size), its tail and a pointer to the full output in the transcript; results up to
  6000 chars, dense dumps and error heads are never cut;
- a compaction frees what the context window needs (back to `compactAtPercent − 10` of it), result by result:
  the step that frees the most per fact lost goes first, reads give way first, and when that is not enough
  the oldest dropped results give way instead of the whole history falling back to the built-in summary;
- the Claude Code hook saves the full output of every result it reduces, with secret values masked, to
  `.claude/fast-jev/cache/<session>/<tool_use_id>.txt` in the project (git-ignored, kept 30 days; threat model:
  [docs/security.md](docs/security.md)) and points the note there, so what
  a stub does not keep is one Read away; before a fallback to the summary it saves every output with an index and
  tells the summarizer where they are (`saveFullOutputs`, default on).

| six blind held-out rounds, 25 transcripts | facts kept | tokens left after compaction (current rules) |
|---|---|---|
| upstream 0.3.0 | 36 / 336 | 7–10% |
| this fork | 304 / 336 (latest round, current rules: 50 / 50) | 45–50% |

Where and why upstream loses facts, with proofs and per-call data: [docs/why-facts-are-lost.md](docs/why-facts-are-lost.md).
Method and every round: [docs/evidence.md](docs/evidence.md).

## Optional metadata audit

The Claude hook can opt into one private local JSONL compaction audit with `auditLog: true`.
It defaults to false and adds no audit I/O while disabled. It observes existing outcomes and
`stats.jev`, not a new compaction route, provider, request-budget guard or pressure estimator.
`dense30-v1` counts canonical visible text/input/results before and after the actual return;
estimated tokens, separately sourced observed usage, and nullable unobserved values never imply
billing or host application. Every attempt has `begin`/one `final`; incomplete is UNKNOWN and
`host_applied` is null. Auto requests are not actual compactions.

The bundled native writer requires a built `dist` schema, a trusted absolute `auditNodePath`,
CLI process capability and, on Windows, a separately verified hidden `auditLauncherPath`.
Keep it disabled until the real-host loader and silent-window gates are verified. There is no
sandbox filesystem fallback. The sole target is
`<user-home>/.claude/fast-jev/cache/audit/compactions.jsonl`, with private access, an exclusive
append/retention lock, fsync/read-back ACK, strict content-free schema, and bounded whole-attempt
retention. Expiry is checked on writes or explicit maintenance, not while an idle host is stopped.
Failures report bounded enums and do not change the returned transcript or run summary twice.
See [hooks/README.md](hooks/README.md#optional-local-compaction-audit) and
[docs/security.md](docs/security.md#metadata-only-audit) for prerequisites and limits.

## About the engine

Claude Code plugin that replaces the compaction summary with Jev decisions:
every tool call and result is scored in one fast request, stale ones shrink to
their facts, everything kept stays verbatim. Also usable as an npm library.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized; secret
   values in them are masked first ([docs/security.md](docs/security.md)).
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit (long sessions), the calls are split into contiguous windows,
   halved until each window's state fits: a window keeps the goal, the first
   message, the pinned tail and its own messages in full. A call that fits no
   window gets the fact rails without Jev, so compaction never throws for size.
   On four real overflowing sessions (28–31k) every compaction went through
   with 2 windows; where the full state fits, windows agree with it on 99.7% of
   decisions. On a re-compaction, calls whose result is already reduced are
   final and not asked, and the hook remembers Jev's answers by `tool_use_id`
   for the life of the process (`knownAnswers`): asked again, Jev gave the same
   action on 711 of 711 calls, and remembering cuts the questions of a second
   compaction by 48% and its requests by 29%. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same state (or the window's state) is resent with every request;
   at most `maxConcurrentJevRequests` workers run concurrently (default 4), including
   their retry pauses. Complete score pairs are merged in planned batch order.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call and reduce the result;
   - else → keep a brief call (input fields cut to 200 chars) and reduce the result.

   Nothing is erased. How a result is reduced depends on what it is:
   - A **reproducible read** is a read of files: `Read`, `Grep`, `Glob`, `ls`, `cat`, `rg`, `git log`…, and not
     logs, JSONL ledgers, followed streams or file metadata (`wc`, `stat`, `du`, `df`, `ls -l`, `Get-ChildItem`),
     alone or inside a compound command. It shrinks to a one-line re-run note, but only when it is longer than
     3000 chars and shows no failure, timeout or background-job marker.
   - Any other result is an **observation**, which a re-run would not give back. It keeps:
     - its head, cut on a line boundary;
     - its fact lines (errors, HTTP codes, paths, versions, ids, endpoints, counts, receipts), up to 30% of its size;
       a line longer than 200 chars is split into pieces first, so a fact deep inside it still counts;
     - its tail;
     - a note naming the `tool_use_id` whose full output stays in the session transcript.

   Three kinds of observation are never cut:
   - one of 6000 chars or less;
   - a dense dump of 32k chars or less, where fact lines are at least half the text;
   - an error result's first 2000 chars.
7. The rules come in tiers (`RAIL_TIERS`: tier 1 is tier 0 without keeping reads, tiers 2–3 cut observations
   further). A compaction must reach `minReduction` (default 0.30; the hook passes what the window needs, see
   `pressure` in `hooks/fast-jev.ts`). Result by result, the step to a stricter tier that frees the most chars per
   fact-like token lost (numbers, hex ids, paths) is taken first, until the reduction is reached. When even the
   strictest tier is not enough — repeated compactions of a long session fill the window with kept facts — the
   oldest dropped results keep only their fact lines, then become one-line notes; pinned calls and calls Jev decided
   to keep are never touched. `stats.railTier` reports the strictest tier used (4 = the last resort).
   Untouched messages are returned as the same objects, and no result is ever left without its call.

Malformed requested answers, a batch without any complete score pair, a round
without fresh scores or a missing key throw; the caller (or the Claude Code hook)
decides what to fall back to. With the default partial policy, validated complete
pairs survive missing answers or terminal transport errors in other batches;
unresolved original call/result pairs stay verbatim and are not cached.

## Install and usage

```sh
npm install fast-jev-compaction   # upstream package; for this fork build a checkout: npm install && npm run build
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to the selected provider's own environment namespace (TypeSafe by default).
Custom endpoints require an explicit key. Never commit the key or
put it in a source file.

### Jev endpoint and its API key

The library and Claude Code plugin share one explicit provider policy and the same System One
builder/parser. `provider` defaults to `typesafe`; neither key presence, a token prefix nor a URL
selects another provider. `allowThirdPartyEgress` defaults to `false`; only literal boolean `true`
permits a third-party destination, before any credential lookup or HTTP.

| Provider | Full endpoint | Default model | Only ambient key | Third-party consent |
| --- | --- | --- | --- | --- |
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` | Not required for the existing default |
| `openrouter` | `https://openrouter.ai/api/v1/systemone` | `jev-latest` | `OPENROUTER_API_KEY` | Required |
| `vercel` | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` | Required |
| `custom` | Explicit full System One-compatible URL | `jev-latest` | None; explicit `apiKey` only | Required except for explicit loopback |

> OpenRouter and Vercel AI Gateway are disabled by default. Selecting `provider` together with
> `allowThirdPartyEgress: true` permits sending fitted history, goal and questions to an additional
> third party and its model-serving provider. Secret redaction does not remove all confidential data.
> Do not enable this for history that cannot be shared with the selected service; use its separate key.
> No no-training, zero-retention or free-service guarantee is made. There is no automatic recipient or
> credential switch. `baseUrl` is a full endpoint here, not an SDK prefix.

```ts
// TypeSafe default, unaffected by ambient OpenRouter/Gateway keys.
await compactMessages(transcript, {});

// Explicitly keep third-party routes off; also remove any foreign baseUrl/apiKey.
await compactMessages(transcript, { provider: 'typesafe', allowThirdPartyEgress: false });

// Requires OPENROUTER_API_KEY; compatible System One, not chat/completions or alpha Decisions.
await compactMessages(transcript, { provider: 'openrouter', allowThirdPartyEgress: true });

// Requires AI_GATEWAY_API_KEY; noul request/response, not the native evaluation API.
await compactMessages(transcript, { provider: 'vercel', allowThirdPartyEgress: true });

// Explicit local proxy and its own key: no ambient key, no remote consent required.
await compactMessages(transcript, {
  provider: 'custom', baseUrl: 'http://127.0.0.1:8321/v1/systemone',
  apiKey: process.env.LOCAL_JEV_API_KEY,
});
```

Named providers accept only an absent `baseUrl` or their exact endpoint above: SDK prefixes,
alternate paths, ports, query/fragment additions and trailing slashes are rejected, not normalized.
For example, the official SDK appends `/v1/systemone` to `https://openrouter.ai/api`; this builder
appends nothing. Explicit models are preserved: TypeSafe accepts `jev-*`; OpenRouter also accepts
`typesafe/jev-*` and `~typesafe/jev-latest`; Vercel accepts only `typesafe-ai/jev`. All models must be
nonempty, at most 128 characters, and contain no whitespace or control characters.

Migration from a generic remote `baseUrl` configuration is intentional: add `provider: 'custom'`,
`allowThirdPartyEgress: true` and the service's explicit `apiKey`. A loopback configuration also needs
`provider: 'custom'` and an explicit key, but not remote consent. Custom HTTPS URLs require consent
unless their written authority is `127.0.0.1`, `localhost` or `[::1]`, optionally with a port.
Normalized aliases such as `127.1` are not trusted loopback. Non-loopback HTTP and userinfo are rejected.
Custom mode is an escape hatch, not proof of API compatibility or a keyless backend.

An explicit `apiKey` wins even when empty, suppressing ambient fallback; missing keys fail before
HTTP (`JevClient` keeps this failure in `ask`, not construction). Arbitrary explicit token issuers
cannot be verified locally. Failed requests never switch provider, key or model. Native fetch uses
`redirect: 'error'` and retains the round AbortSignal; an injected transport must honor these controls.
The host's `$.http.fetch` has no declared redirect/cancellation control: third-party hook release
requires a separate host known-positive and redirect-negative probe. This is not yet verified;
only library native-fetch confinement has been exercised. See [docs/security.md](docs/security.md).

Plugin options are merged with settings and snapshotted per registration. Change provider/model/URL
only with a plugin reload and cached-answer reset (`forgetAnswers` in tests); no cross-provider cache
reuse is supported. Remove an old explicit `model: 'jev-latest'` when moving to Vercel, or set
`typesafe-ai/jev`; the legacy value produces a controlled error rather than being replaced.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `provider` | `typesafe` | `typesafe`, `openrouter`, `vercel` or `custom`; never inferred |
| `allowThirdPartyEgress` | `false` | Literal boolean opt-in for third-party history transfer |
| `apiKey` | Selected provider's namespace | Key for the selected service; explicit even if empty; custom has no ambient fallback |
| `model` | Provider-specific | `jev-latest`, except Vercel's `typesafe-ai/jev`; explicit values validated, never rewritten |
| `baseUrl` | Provider-specific | Exact full named endpoint, or explicit custom URL; HTTPS or written loopback HTTP, no userinfo |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `compactionTimeoutMs` | `120000` | One deadline for all Jev batches, retries and response bodies, in ms. The plugin accepts numbers ≥ 1000. Accepted fresh pairs can survive the deadline under the partial policy; without them the round fails. Native fetch is aborted when supported; late responses cannot affect the snapshot or cache. |
| `maxJevAttempts` | `3` | Total attempts per logical batch INCLUDING the first, integer `1..4`; `1` disables retries, not the deadline or concurrency limit |
| `maxConcurrentJevRequests` | `4` | Integer `1..8`; a retry pause occupies the same worker slot |
| `partialAnswers` | `retain-unscored` | Keep valid complete score pairs and retain unresolved original pairs; `rollback` rejects an incomplete fresh round |
| `retrySleep` | cancelable native timer | Injectable backoff `(ms, {signal}) => Promise<void>`, separate from `deadlineSleep`; the hook supplies `$.clock.sleep` |
| `nowMs` | `async () => Date.now()` | Injectable clock for absolute guards; the hook supplies `$.clock.now` |
| `truncateHeadChars` | `200` | Characters of a reduced tool result's head kept before its fact lines |
| `secrets` | `[]` (the API key in `compactMessages` and the hook) | Values masked exactly in everything sent to Jev, before the history is cut to fit |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of planned requests (`stats.requests`). Only when
Jev jobs are planned, the frozen `stats.jev` payload is present:
`{completion, terminalCode, attempts, retries, parsed, scoredCalls, unscoredCalls}`.
`completion` is `complete` or `partial`; `terminalCode` is `none`, `network`,
`http_4xx`, `http_5xx`, `rate_limited`, `deadline`, `contract` or `unknown`.
`attempts` counts actual sends and `retries` counts actual sends after the first;
`parsed` counts validated responses, including partial ones. Scored plus unscored
calls cover only calls in planned jobs, excluding cache, pinned, reduced and floor
provenance. A failed round throws `JevRoundError` with safe `code`, frozen `counts`
and optional `contractKind`, not a compaction result or raw transport data.

Retries are core-only, deterministic waits of 1000/2000/4000 ms for at most four
attempts. Only typed network failures and HTTP 429 or integer 500-599 are transient;
JSON/envelope/answer failures, unknown exception messages and other statuses are
not retried. `Retry-After` may lengthen a wait, but a server wait over 30000 ms is
never shortened. A delay that cannot fit the remaining round budget stops without
sleeping or sending again. Every attempt keeps the same state/questions and
endpoint/model/key; there is no provider fallback. Invalid new options raise
`RangeError` before I/O, without rounding fractions or treating zero as unlimited.

Unscored decisions use internal retention constants, not Jev probabilities; their
UI label is `unscored`. No half pair is merged with cache or a prior attempt.
Fresh valid scores are published to the caller's mutable `knownAnswers` only after
decisions/rails succeed. Late workers cannot change the frozen snapshot, cache or
offload. The deadline covers Jev, not fitting, rails, offload or the summary path.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code type reference (generated by 2.1.284).

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add deadczarvc-labs/jev-factkeep-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The marketplace and plugin keep the upstream names, so this fork replaces an upstream install: remove the
upstream marketplace first (`claude plugin marketplace remove fast-jev-compaction`).

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the transcript line reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails). Only the fallback,
which takes minutes, also shows a toast.

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Codex

Codex compacts a chat into the user messages plus a summary its server encrypts: every tool output leaves the
context, and what the summary kept cannot be checked. Right after that, before the next model request, Codex runs
`SessionStart` hooks whose matcher is `compact` and adds what they return to the context.
[`codex/fact-sheet.ts`](codex/fact-sheet.ts) is such a hook. It reads the session rollout and saves each long tool
output in full, secret values masked, under `<CODEX_HOME>/fast-jev/cache/<session>/` (30 days). It returns a fact
sheet sized at 5% of the model's window: the newest outputs verbatim within half of it, older ones as their fact lines
(the regex fact patterns of the Claude Code hook; a reproducible read becomes a re-run line), the oldest as one line each, and the path of `facts.md`, which lists them all.
It makes no Jev call and takes tens of milliseconds.

Choose exactly one installation method. Registering both the plugin and the manual hook runs recovery twice
on the same compaction. This project does not edit your `~/.codex/hooks.json` or its trust records.

### Option 1: Codex plugin loader

Build the runtime from this checkout before installing it through a local marketplace:

```sh
npm install
npm run build:codex
codex plugin marketplace add /absolute/path/to/checkout
codex plugin add fast-jev-compaction@fast-jev-compaction
```

The plugin route requires a Codex build that executes bundled lifecycle hooks. Codex CLI 0.159.1 and
app runtime 0.160.0 currently report `plugin_hooks removed false`: they can discover an enabled plugin
and list its hook without running it. On those builds use the existing manual option below instead;
plugin installation or discovery alone is not proof of recovery in the next model request.

On a host that supports bundled hooks, restart Codex, then review and trust the plugin hook in `/hooks`.
The compatibility manifest is
[`.codex-plugin/plugin.json`](.codex-plugin/plugin.json); its explicit hooks path loads only
[`.codex-plugin/hooks.json`](.codex-plugin/hooks.json), not the Claude hook configuration.
It registers one `SessionStart` command with matcher `compact`, timeout 30 seconds and
`additionalContextLimit` 70000. The command runs the emitted `codex-dist/codex/fact-sheet.js` with Node;
no TypeScript loader or Jev API key is needed at runtime. Both source and emitted hooks read the release
version from `.claude-plugin/plugin.json`, not the library version in `package.json`.

Disable or remove any existing manual fact-sheet hook before enabling the plugin. Check `/hooks` for one
enabled recovery registration; a saved log by itself does not prove that Codex loaded its context into the next
model request. See the [Codex plugin guide](https://developers.openai.com/plugins/build/plugins) for loader setup.

### Option 2: manual hook, without the plugin

Run `npm install` in a checkout, then add a group at the **end** of `SessionStart` in `~/.codex/hooks.json`
(Codex keys hook trust by position, so a group inserted earlier un-trusts the ones after it) and trust it in `/hooks`:

```json
{
  "matcher": "compact",
  "hooks": [{
    "type": "command",
    "command": "node --import file:///<checkout>/node_modules/tsx/dist/loader.mjs <checkout>/codex/fact-sheet.ts",
    "timeout": 30,
    "statusMessage": "Restoring tool-output facts after compaction",
    "additionalContextLimit": 70000
  }]
}
```

`additionalContextLimit` (tokens) must cover the sheet, up to 200k chars, or Codex swaps its middle for a preview.
`FJC_CODEX_SAVE_OUTPUTS=0` saves nothing; `FJC_CODEX_BUDGET` sets the size in chars.

On 4 held-out Codex rollouts (59 preregistered facts) the sheet kept 59/59 in context, against 53/59 for the newest raw
outputs of the same size, and 59/59 with the saved files ([evidence](docs/evidence.md#codex)).

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
