# Evidence: facts kept by compaction

The formal account of why upstream loses facts, with the per-call data behind it, is in
[why-facts-are-lost.md](why-facts-are-lost.md).

## Method

- Transcripts are real Claude Code subagent transcripts (15–60 tool calls each), one per session, never reused
  across rounds.
- A fact is a verbatim substring (≤ 80 chars) of one tool result that re-running the tool would not give back:
  an error, HTTP code, pid, id, counter, timing, state. Facts were preregistered, with their sha256 logged,
  before any engine ran, by an agent that had not read the rules.
- "Kept" means the fact is still inside its own tool result after compaction.
- All runs used real Jev decisions (`jev-1.13.0`, TypeSafe System One). Each run was repeated; the kept sets were
  identical.
- Statistics: exact McNemar on paired facts (b = kept only by the fork, c = kept only by upstream),
  Clopper–Pearson 95% intervals.
- Token reduction is estimated with the library's tokenizer-free estimate.

## Rounds

Every round before round 4 exposed one class of loss. Each was fixed with a general rule, not by matching the
lost strings.

| round | transcripts / facts | fork kept | upstream kept | class of loss found | rule added |
|---|---|---|---|---|---|
| 0 | 4 / 50 | 41/50 | 5/50 | facts in the middle of long results | observations ≤ 3000 chars kept whole; line-aligned cuts; fact budget |
| 1 | 4 / 50 | 44/50 | 7/50 | a log tail treated as a reproducible read; 3–6k results cut | logs are observations; observations ≤ 6000 chars kept whole |
| 2 | 4 / 57 | 50/57 | 7/57 | failed or short reads turned into re-run notes; dense tables cut | failed reads are observations; dense dumps ≤ 20k kept; 30% fact budget; rail tiers |
| 3 | 4 / 54 | 49/54 | 7/54 | short `ls -la` / `wc -c` reads turned into re-run notes | reads ≤ 3000 chars kept |
| **4** | **5 / 75** | **70/75** | **8/75** | observation lines inside long, otherwise reproducible results | none yet |

- Against upstream every round was one-sided (c = 0): no fact kept by upstream was lost by the fork. Round 4:
  b = 62, c = 0, p = 4.3e-19.
- Round 4 is the only round run on the final rules (0.3.0-astra.6): 70/75 = 0.933, 95% CI 0.851–0.978. The
  preregistered target of 94% (71/75) was missed by one fact.
- The five facts lost in round 4:
  - two came from compound commands such as `wc -l f && sed -n 1,140p f` or `cat card; ls -la dir`, longer than
    3000 chars and treated as reproducible reads;
  - three sat in 11–29k results (a script's verbose output, a Mnemosyne recall, a status dump) where no fact line
    matched.

## Final rules on all earlier rounds (in-sample)

16 transcripts, 211 facts, real Jev:

| engine | facts kept | pooled token reduction | worst transcript |
|---|---|---|---|
| upstream 0.3.0 | 26/211 | 0.908 | 0.808 |
| fork 0.3.0-astra.6 | 211/211 | 0.557 | 0.302 |

## Price

Compression is lower: about 42–44% of the tokens remain after compaction, against 7–9% with upstream. The
rail tiers keep every compaction above the hook's 25% fallback to the built-in summary, which would lose every
fact.

## Hermes Agent

The same rules run in the Hermes Agent context engine
([deadczarvc/hermes-jev-compaction](https://github.com/deadczarvc/hermes-jev-compaction)). On every round it
kept the same facts as the fork (round 4: 70/75, against 13/75 for its previous version).
