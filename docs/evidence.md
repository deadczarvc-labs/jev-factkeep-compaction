# Evidence: facts kept by compaction

The formal account of why upstream loses facts, with the per-call data behind it, is in
[why-facts-are-lost.md](why-facts-are-lost.md).

## Method

**Transcripts**

- Real Claude Code subagent transcripts, 15–60 tool calls each, one per session within a round.
- No transcript is used in more than one round.
- Round 5 drew new transcripts from sessions sampled before, because no new session of the right size existed.

**Facts**

- A fact is a verbatim substring (≤ 80 chars) of one tool result that re-running the tool would not give back:
  an error, HTTP code, pid, id, counter, timing or state.
- Facts were preregistered, with their sha256 logged, before any engine ran.
- The agent that chose them had not read the rules.
- "Kept" means the fact is still inside its own tool result after compaction.

**Runs and statistics**

- All runs used real Jev decisions (`jev-1.13.0`, TypeSafe System One).
- Each run was repeated, and the kept sets were identical.
- Exact McNemar on paired facts: b = kept only by the fork, c = kept only by upstream.
- Clopper–Pearson 95% intervals.
- Token reduction uses the library's tokenizer-free estimate.

## Rounds

Every blind round tested the fork version that existed before it. Rounds 0–4 each exposed one class of loss, and
each class was fixed with a general rule, not by matching the lost strings.

| round | transcripts / facts | fork version | fork kept | upstream kept | class of loss found | rule added after it |
|---|---|---|---|---|---|---|
| 0 | 4 / 50 | astra.2 | 41/50 | 5/50 | facts in the middle of long results | observations ≤ 3000 chars kept whole; line-aligned cuts; fact budget |
| 1 | 4 / 50 | astra.3 | 44/50 | 7/50 | a log tail treated as a reproducible read; 3–6k results cut | logs are observations; observations ≤ 6000 chars kept whole |
| 2 | 4 / 57 | astra.4 | 50/57 | 7/57 | failed or short reads turned into re-run notes; dense tables cut | failed reads are observations; dense dumps ≤ 20k kept; 30% fact budget; rail tiers |
| 3 | 4 / 54 | astra.5 | 49/54 | 7/54 | short `ls -la` / `wc -c` reads turned into re-run notes | reads ≤ 3000 chars kept |
| 4 | 5 / 75 | astra.6 | 70/75 | 8/75 | metadata inside compound reads; facts deep in very long lines; a 29k dense table | metadata reads (`wc`, `stat`, `du`, long listings) are observations; long lines split into pieces; dense dumps ≤ 32k kept |
| **5** | **4 / 50** | **astra.7** | **50/50** | **2/50** | none | — |
| **all** | **25 / 336** | | **304/336** | **36/336** | | |

- Every round was one-sided against upstream (c = 0): no fact kept by upstream was lost by the fork.
- Pooled: fork 304/336 = 0.905 (95% CI 0.868–0.934), upstream 36/336 = 0.107 (0.076–0.145); b = 268, c = 0,
  p = 2^-267 ≈ 4e-81.
- At the transcript level the fork kept more on 25 of 25, sign test p = 2^-25 ≈ 3e-8.

**Round 5, the current rules (0.3.0-astra.7).**

- The preregistered target is ⌈0.94 · 50⌉ = 47 facts, with compression ≥ 0.25 on every transcript.
- Kept: 50/50, 95% CI 0.929–1.000.
- One-sided exact binomial test against 0.94: p = 0.045.
- Compression: 0.504 pooled, minimum 0.380.
- McNemar against upstream: p = 7.1e-15.
- Limits:
  - Jev dropped every unpinned call on all four transcripts, so the round measures the keeping rules, not Jev's
    decisions;
  - the sessions had been sampled before, although the transcripts were new.

## Current rules on the earlier rounds (in-sample)

Rounds 0–4 cover 21 transcripts and 286 facts. The rules were tuned on them.

| engine | facts kept | reduction |
|---|---|---|
| upstream 0.3.0 | 34/286 | 0.91–0.93 (tokens, by round) |
| fork 0.3.0-astra.7, replayed with the recorded Jev decisions | 286/286 | 0.551 (chars), worst transcript 0.316 |
| Hermes port, live Jev | 286/286 | 0.519 (tokens) |

## Price

Compression is lower than upstream:

- about 45–50% of the tokens remain after compaction, against 7–10% with upstream;
- a compaction frees what the context window needs rather than a fixed share, so a fallback to the built-in
  summary, which would lose every fact, happens only when even the last resort cannot make room.

## Repeated compactions of one session

A long session is compacted again and again, and every compaction must free room in the context window. The rounds
above compact each transcript once. This section replays sessions compaction by compaction.

**Model** (`sim_v2.mts`): messages arrive one by one; when the context reaches 60% of the window, the rails run on
it with Jev's recorded decisions; the hook's gate decides; a rejected compaction falls back to the built-in summary,
after which only the first and the last 6 messages remain. The window is the transcript's size divided by `m`, so
`m` is the session's length in windows. A fact is kept when its needle is still in its own result at the end.

- **0.3.0-astra.9**: fixed minimum reduction (30% rails floor, 25% gate).
- **0.3.0-astra.10**: the minimum follows the window (back to 50% of it, accepted at 55%), result-by-result
  choice of what to cut, oldest results give way instead of a fallback.

In-sample (the 336 facts above; the new rules were tuned on them):

| session length | astra.9 | astra.10 | one-shot ceiling |
|---|---|---|---|
| 0.8 window | 333 (99.1%) | 335 (99.7%) | — |
| 1 window | 311 (92.6%) | 326 (97.0%) | 331 (98.5%) |
| 1.2 windows | 273 (81.3%), 4 fallbacks | 303 (90.2%), 0 | 320 (95.2%) |
| 1.5 windows | 172 (51.2%), 17 fallbacks | 265 (78.9%), 3 | 301 (89.6%) |

The harness is [`docs/data/sim_v2.mts`](data/sim_v2.mts). The ceiling compacts the whole session once, after the fact, to the same final size. No choice of what to cut does
better with facts kept in the context, so 99% holds only for sessions up to about 0.8 of the window.

Blind round 6 (4 new transcripts, 56 facts preregistered with the verdict rule before any run):

| session length | astra.10 | astra.9 | fallbacks astra.10 / astra.9 |
|---|---|---|---|
| 0.8 window | 56/56 (95% CI 0.936–1.000) | 56/56 | 0 / 0 |
| 1 window | 55/56 | 42/56 | 0 / 1 |
| 1.2 windows | 46/56 | 40/56 | 0 / 1 |
| 1.5 windows | 38/56 | 34/56 | 3 / 5 |

- At one window: b = 13, c = 0, exact one-sided McNemar p = 1.2e-4. 12 of the 13 come from a single astra.9 fallback
  on one transcript; per transcript astra.10 is never worse (4 of 4) and better on 2.
- 56/56 at 0.8 of the window does not rule out a true share below 99% (lower bound 0.936).
- Past one window, facts are lost to room, not to fallbacks.

### Saved outputs (0.3.0-astra.11)

The hook saves the full output of every result it reduces to a file and names the file in the note. A fact then is
either in the context or one Read away. Counting both (a fallback loses the notes, so facts saved before it count as
lost):

| session length | in-sample 336: in context | + saved | blind round 6, 56: in context | + saved |
|---|---|---|---|---|
| 0.8 window | 335 | 336 | 56 | 56 |
| 1 window | 326 | 336 | 55 | 56 |
| 1.2 windows | 303 | 336 | 46 | 56 |
| 1.5 windows | 265 | 324 (96.4%) | 37 | 56 |

- The 12 in-sample facts still lost at 1.5 windows all follow the 3 fallbacks. Before a fallback the hook now saves
  every output with an index and asks the summarizer to keep the path; the simulation cannot tell whether the
  summary keeps it, so those facts are counted as lost.
- Round 6 is not fully blind for this row: one of its facts (a failed `ls` inside a compound command) was lost to a
  re-run note, and re-run notes were made to point to the saved output after that was seen.

Blind round 7 (0.3.0-astra.13, 4 new transcripts, 55 preregistered facts): in context or saved 55/55 at every session
length from 0.8 to 1.5 windows; in context alone 55 / 53 / 48 / 47. No fallback.

## Hermes Agent

The same rules run in the Hermes Agent context engine
([deadczarvc/hermes-jev-compaction](https://github.com/deadczarvc/hermes-jev-compaction)). On every round it kept
the same facts as the fork:

- round 4: 70/75, against 13/75 for its previous version;
- round 5: 50/50, against 4/50.

## Codex

The Codex adapter (`codex/fact-sheet.ts`, see the README) was checked on Codex rollouts the author had not looked at,
with the same method: facts preregistered blind to the adapter, then one run. Here the question is what the model
still has after a Codex compaction, which drops every tool output: the fact sheet in context, the saved files, and, as a
baseline, the newest raw outputs cut to the same size.

| round | adapter | rollouts / facts | sheet in context | raw tail, same size | sheet or saved | McNemar |
|---|---|---|---|---|---|---|
| 8 | fixed 18k chars, fact lines first | 4 / 55 | 14/55 | 13/55 | 55/55 | b = 4, c = 3, p = 1 |
| 9 | 5% of the window, newest verbatim first | 4 / 59 | 59/59 | 53/59 | 59/59 | b = 6, c = 0, p = 0.031 |

Round 8 failed its hypothesis: at 18k chars against 0.2–0.9M chars of output, the sheet reached back about 35 calls,
like the raw tail, and fact lines for older calls took the room the newest outputs needed. Round 9 sized the sheet from
the model's window (165 680 chars for an 828k-token window) and filled it newest first, verbatim before fact lines.
All six facts it kept and the tail lost come from one rollout, the one with the most output (563k chars); in the other
three the budget covered the facts either way. The hook ran in 36–114 ms.

### Line selection: compressibility against regex (rounds 10–12)

The sheet reduces most calls to their fact lines, chosen so far by the regex fact patterns. An alternative scores each
200-char chunk by its deflate size with the preceding 32 KB of the same output as dictionary (a minimum-description-length
proxy): ids, hashes, verdicts and errors do not compress against what came before, repeated rows and boilerplate do.
The rule was fixed before any run. "Hybrid" = regex fact lines within half the budget, then those chunks.

| round | data | budget per output | regex | compressibility | hybrid | result |
|---|---|---|---|---|---|---|
| 10 (screening, seen facts) | 421 facts, 41 transcripts | 10% | 39.2% | 51.8% | — | +12.6 pts, cluster CI [+6.0, +19.7] |
| 11 (blind) | 196 facts, 21 transcripts | 10% | 33.7% | 41.8% | — | +8.2 pts, p = .072, CI [0.0, +16.4]: not confirmed |
| 12 (blind, larger) | 404 facts, 23 transcripts, 12 sessions | 10% | 40.6% | 51.2% | 52.0% | +10.6 and +11.4 pts, p = 8e-4 and 2e-5 (Holm), CI by session [+4.3, +17.4] and [+6.4, +17.1] |

In the whole sheet (600 facts of rounds 11–12, preregistered) the hybrid keeps 91.0% against 90.2% at 165k chars
(CI [−0.5, +2.8], non-inferior at the same size) and 73.5% against 72.0% at 50k (not significant): most facts sit in
outputs the sheet keeps verbatim, and the selector only acts on the rest. The sheet uses the hybrid since then. Against a
simple baseline at the same size (one line per call plus the newest outputs verbatim) the sheet keeps +22.7 pts at 50k
and +9.8 at 165k.

### Clustering and power

Facts from one transcript or session are correlated. On the Codex rounds 8–9 the intra-transcript correlation was about
0.16 with ~14 facts per transcript, a design effect of ~3: the naive intervals and McNemar p-values in rounds 8–9 (and,
to a lesser degree, in the earlier rounds, whose correlation was not measured) are too narrow by up to ~√3. Round 9's
p = .031 comes from one rollout and is weak evidence. Rounds 10–12 report bootstrap intervals clustered by transcript or
session; their correlation was small (0.01–0.04). A four-transcript round can only detect effects of 40–50 points; round
12 was sized for a 10-point effect.

### What agents act on: the hybrid is reverted

Rounds 10–12 scored facts an experimenter picked. A second label scores what the agent itself used: a token with a
digit, first introduced by a tool output, that appears later in the agent's own text or tool inputs (automatic; 6.2% of
new digit tokens; 85 transcripts, 35 sessions). On that label, with compaction at 50% and 75% of each session:

| where | hybrid − regex | 95% CI (clustered by session) |
|---|---|---|
| lines, 10% of an output | −2.9 pts | [−5.0, −0.9] |
| Codex sheet, 50k chars, compaction at 75% | −1.6 | [−3.2, +0.6] |
| Codex sheet, 165k chars | +0.5 / +0.6 | [0.0, +1.1] / [+0.1, +1.5] |
| Hermes-style stubs, rail tiers 0–3 | −1.6 … −6.7 | all below 0 |

The rule written before this check kept the hybrid only if no cell fell more than 1 pt below regex; the 50k cell did, so
the sheet is back on regex fact lines. Compressibility ranks repetitive lines low (grep hits sharing a path, listings),
and those are often exactly what the agent opens next. Rounds 10–12 stand as measured, for the facts they measured.
