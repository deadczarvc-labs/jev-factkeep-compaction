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
- the rail tiers keep every compaction above the hook's 25% fallback to the built-in summary, which would lose
  every fact.

## Hermes Agent

The same rules run in the Hermes Agent context engine
([deadczarvc/hermes-jev-compaction](https://github.com/deadczarvc/hermes-jev-compaction)). On every round it kept
the same facts as the fork:

- round 4: 70/75, against 13/75 for its previous version;
- round 5: 50/50, against 4/50.
