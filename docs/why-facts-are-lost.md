# Why fast-jev-compaction 0.3.0 loses facts

This note analyses upstream `main` at
[`e3f262a`](https://github.com/tamaratran/fast-jev-compaction/tree/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0) (plugin
0.3.0). It shows where the engine loses facts, why tuning the threshold or rewording the questions cannot repair
it, and what this fork changes. Every number below is recomputed by [`data/anatomy.py`](data/anatomy.py) from two
tables with no transcript content: [`data/calls.csv`](data/calls.csv) and [`data/facts.csv`](data/facts.csv).

## Summary

1. The engine asks Jev whether the **contents** of a tool result are still needed, but Jev never sees those
   contents: the state replaces every result with `ok, <n> chars (omitted)`. So the decision about a result cannot
   depend on what the result says (Proposition 1). Measured: `keepResult` separates results that carry facts from
   the others with an AUC of 0.567.
2. On real transcripts `keepResult` never reaches the 0.5 threshold. Across 933 unpinned calls the maximum is 0.27.
   `keepCall` reaches it once. The decision rule therefore degenerates to "erase every unpinned call together with
   its result".
3. Retention equals the pinning rate: 34 of 286 preregistered facts survived, and they are exactly the 34 whose call
   was pinned. The rule applied to the recorded Jev scores reproduces the observed output on 286 of 286 facts.
4. Rewording the questions shifts the scores up but leaves them blind. With the premise *"the assistant can always
   re-run a tool"* removed, and then also the clause *"re-running the tool would not do"*, facts kept go from 34
   to 34 to 35 of 286, and the AUC goes to 0.519 and 0.488.
5. The fork keeps every call, decides reproducibility locally, and reduces non-reproducible results with an
   operator that reads them. On six blind held-out rounds it kept 304 of 336 facts against 36:
   - exact McNemar p ≈ 4e-81;
   - better on 25 of 25 transcripts, sign test p = 3e-8;
   - the current rules kept 50 of 50 on the latest round, against 2 of 50 for upstream.

## 1. The engine as a function

Notation: $\theta$ is `keepThreshold` (0.5), $h$ is `truncateHeadChars` (300), $k$ is `preserveRecentMessages` (6).
Links point at the lines of `e3f262a`.

For each tool call $i = 1, \dots, N$:

- $\tau_i$ is the tool, $u_i$ the input, $X_i$ the result text, $L_i = |X_i|$ its length, $e_i$ the error flag.
- A call is **pinned**, $i \in P$, when its call or its result sits in the first message or in the last $k$
  messages ([`state.ts#L50-L56`](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/src/state.ts#L50-L56)).

**What Jev sees.** The state $S$ holds:

- the conversation text $T$, abridged;
- for every call, $z_i = (\tau_i, \tilde u_i, L_i, e_i)$, where $\tilde u_i$ is the input cut to 1000, 200 or 60
  characters.

The result itself is replaced by a note
([`state.ts#L105-L106`](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/src/state.ts#L105-L106)):

```ts
return `${call.isError ? 'error' : 'ok'}, ${call.resultChars} chars (omitted)`;
```

The context line that opens the state ends with *"Whatever is not kept is deleted permanently, but the assistant can
always re-run a tool or re-read a file"*
([`state.ts#L11-L12`](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/src/state.ts#L11-L12)).

**What Jev is asked**
([`compact.ts#L56-L66`](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/src/compact.ts#L56-L66)).
There are two `noul` questions per call:

- $q^C_i$: *"Tool call $i$ ($\tau_i$) should stay in the history: knowing this call was made, with its input, still
  matters for what the assistant does next"*;
- $q^R_i$: *"The full output of tool call $i$ ($\tau_i$, $L_i$ chars) should stay in the history verbatim: the
  assistant still needs its contents and re-running the tool would not do"*.

Jev returns $p^C_i = J(S, q^C_i)$ and $p^R_i = J(S, q^R_i)$.

**The rule**
([`compact.ts#L101-L115`](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/src/compact.ts#L101-L115)):

```math
a_i =
\begin{cases}
\text{keep} & i \in P \ \text{ or } \ p^R_i \ge \theta \\
\text{drop\_result} & p^C_i \ge \theta > p^R_i \\
\text{drop\_call} & \text{otherwise}
\end{cases}
```

**The output.** Each action produces:

- `keep` returns $X_i$ unchanged;
- `drop_result` keeps the first $h$ characters plus a note when $L_i > h + 120$
  ([`compact.ts#L135-L140`](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/src/compact.ts#L135-L140));
- `drop_call` removes the call and its result
  ([`#L171`](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/src/compact.ts#L171),
  [`#L190`](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/src/compact.ts#L190)).

**When a fact survives.** Take a fact $\varphi$ that sits in $X_i$ at offset $o$ and has length $\ell$. It survives
compaction exactly when

$$
K(\varphi) = \mathbb 1[i \in P] + \mathbb 1[i \notin P]\Big(\mathbb 1[p^R_i \ge \theta] + \mathbb 1[p^R_i < \theta \le p^C_i]\,\mathbb 1[o + \ell \le h \ \lor\ L_i \le h + 120]\Big) = 1 .
$$

## 2. Defect 1: the keep-result decision cannot depend on the result

**Proposition 1.** $p^R_i$ and $p^C_i$ are functions of $S$. $X_i$ enters $S$ only through $L_i$ and $e_i$. So two
calls whose results differ in content but agree in length, error flag, tool, input and surrounding text get the same
two scores. Now fix what Jev sees and ask whether the result contains a fact $\varphi$. For every such fact,

$$
\Pr\big(a_i = \text{keep} \mid \varphi \subset X_i,\ S\big) = \Pr\big(a_i = \text{keep} \mid S\big).
$$

The contents of $X_i$ can reach the decision only through $T$, when the assistant has already restated them in its
own text, and then the result is no longer the only copy.

That is what we observed first: on a 22-call transcript the engine itself kept 0 of 10 content facts. The facts that
survived did so because the agent had copied them into its own messages.

**Measured.** We looked at 933 unpinned calls from 21 real Claude Code transcripts. 214 of them carry at least one
preregistered fact; 719 carry none. $p^R$ barely separates the two groups:

- AUC 0.567, with a 95% cluster bootstrap over transcripts of 0.516–0.625;
- median 0.15 for fact-bearing results against 0.14 for the rest.

A threshold sweep on $p^R$ shows what any choice of $\theta$ can buy:

| to keep this share of fact-bearing results | threshold | fact-bearing kept | all other results kept |
|---|---|---|---|
| 50% | 0.15 | 0.509 | 0.413 |
| 80% | 0.12 | 0.893 | 0.892 |
| 90% | 0.11 | 0.939 | 0.951 |
| 94% | 0.10 | 0.967 | 0.974 |

The ROC lies on the diagonal. Lowering $\theta$ keeps facts only by keeping everything, which is no compaction.

## 3. Defect 2: $p^R$ never reaches the threshold

Distribution of the recorded scores over the 933 unpinned calls:

| score | [0, 0.1) | [0.1, 0.2) | [0.2, 0.3) | [0.3, 0.4) | [0.4, 0.5) | ≥ 0.5 |
|---|---|---|---|---|---|---|
| $p^R$, fact-bearing | 7 | 187 | 20 | 0 | 0 | 0 |
| $p^R$, other | 19 | 673 | 27 | 0 | 0 | 0 |
| $p^C$, all | 0 | 31 | 545 | 315 | 41 | 1 |

- The maximum $p^R$ is 0.27, so the `keep` branch is unreachable for unpinned calls.
- $p^C \ge 0.5$ happens once in 933, so `drop_result` fires once.
- The other 932 unpinned calls are erased together with their results.

**Why so low.** $q^R$ is a conjunction of two claims:

- $A$: the assistant still needs the contents;
- $B$: a re-run would not do.

For any coherent probability, $\Pr(A \wedge B) \le \min(\Pr A, \Pr B)$. The state context asserts that the assistant
can always re-run a tool, so it tells Jev that $B$ is false. We tested this with two ablations on the same 21
transcripts, one real Jev request each:

| variant | median $p^R$ | max $p^R$ | $p^R \ge 0.5$ | AUC fact-bearing vs other | facts kept |
|---|---|---|---|---|---|
| upstream | 0.14 | 0.27 | 0 / 933 | 0.567 | 34 / 286 |
| premise removed from the context | 0.20 | 0.38 | 0 / 933 | 0.519 | 34 / 286 |
| premise and clause $B$ removed | 0.28 | 0.55 | 4 / 933 | 0.488 | 35 / 286 |

- The wording does depress the scores.
- Removing it lifts them uniformly and removes what little separation there was.
- Almost no facts come back. Defect 1 holds whatever the wording.

## 4. Defect 3: erasure by default, and truncation keeps the wrong end

- **`drop_call` deletes the result along with the call.** A result is destroyed because the *call* scored low, not
  because anything established that its contents were reproducible.
- **Head-only truncation misses most facts.** 214 of the facts sit in results longer than $h + 120 = 420$ chars:
  - only 39.7% of them lie within the first 300 characters;
  - the quartiles of their relative position $o / L$ are 0.04, 0.28 and 0.86;
  - so a quarter of the facts sit in the last 14% of their output, where exit codes, totals, receipts and final
    status lines live;
  - with facts placed uniformly, head retention would be $\mathbb E[h / L] = 0.223$.

## 5. Consequence: retention equals the pinning rate

$p^R < \theta$ on every unpinned call, and $p^C < \theta$ on all but one, so

$$
\mathbb E[K] = \Pr(i \in P) + \varepsilon, \qquad \varepsilon = \Pr(i \notin P,\ p^C_i \ge \theta)\cdot\Pr(\text{fact in the head}) \approx 0 .
$$

On the 286 preregistered facts:

- 34 facts had their call pinned, and all were kept;
- 251 facts were erased by `drop_call`;
- 1 fact was cut by head truncation.

Kept: 34/286 = 0.119 (Clopper–Pearson 0.084–0.162), exactly the pinned share. Applied to the recorded scores, the
rule reproduces the observed output on 286/286 facts.

$P$ covers the first message and the last $k = 6$ messages, so it holds a bounded number of calls: 62 of 995 calls
in our 21 transcripts, about 3 per transcript. For facts spread over $N$ calls, retention therefore falls like
$O(1/N)$. The longer the session, the more
compaction matters and the fewer facts survive.

## 6. What does not fix it

| change | why it does not help |
|---|---|
| lower `keepThreshold` | By Proposition 1 the ROC is the diagonal: a fact-bearing result is kept only at the rate everything is kept (§2). |
| reword the questions | Ablation (§3): the scores move up together, 34 → 35 facts. |
| larger `truncateHeadChars` | It only affects `drop_result`, which fires for 1 call in 933, and never reaches tail facts (§4). |
| show Jev the results | Possible in principle, but the results are most of the tokens (up to 507k chars in one of these transcripts), far over the 25k-token state budget that allows one request per compaction. |

## 7. What this fork changes

Jev's scores still decide **which calls are reduced**; that is where the compression comes from. They no longer
decide **which facts survive**.

1. **Nothing is erased.** A dropped call stays, with its input fields cut to 200 chars.
2. **Reproducibility is a local predicate** $\rho(\tau_i, u_i, X_i)$. It is true for reads of files and listings
   (`Read`, `Grep`, `Glob`, `ls`, `cat`, `rg`, `git log`…) when all of these hold:
   - longer than 3000 chars;
   - no failure, timeout or background-job marker;
   - not a log, JSONL ledger, `journalctl`, `docker logs`, `-Tail` / `-Wait` or `tail -f`;
   - no command reports file metadata (`wc`, `stat`, `du`, `df`, `ls -l`, `Get-ChildItem`): counts, sizes and
     modification times are measurements taken at one moment.

   When $\rho = 1$, the upstream premise really holds: a re-run gives the content back. So the result shrinks to a
   one-line re-run note.
3. **Observations are reduced by an operator that reads them.** When $\rho = 0$:

   $$R(X) = \mathrm{head}(X) \cup F(X) \cup \mathrm{tail}(X) \cup \text{pointer},$$

   - $F(X)$ is the set of lines that match fact patterns: errors, HTTP codes, paths, versions, ids, endpoints, counts
     and receipts of non-idempotent calls. It is bounded by $0.3\,|X|$. A line longer than 200 chars (for example a
     JSON string with escaped newlines) is split into pieces first, so a fact deep inside it is still a candidate.
   - Head and tail are cut on line boundaries.
   - The pointer names the `tool_use_id` whose full output stays in the session transcript.
   - Never cut: observations up to 6000 chars, dense dumps up to 32k chars (fact lines ≥ 50%), and the first 2000
     chars of an error.
4. **Rail tiers.** The engine uses the strictest tier whose reduction is at least 0.30. That keeps it above the
   hook's 0.25 fallback to the built-in summary, which would lose every fact.

## 8. Evidence

**Method.**

- Each round used new transcripts (15–60 tool calls, one per session within a round, never reused). Round 5 drew
  new transcripts from sessions sampled before.
- Sections 2–6 use the 286 facts of rounds 0–4, for which the per-call tables are published.
- Facts were preregistered before any engine ran, by an agent that had not read the rules, with sha256 logged.
- A fact is a verbatim substring of one result that re-running the tool would not give back.
- "Kept" means the fact is still inside its own result.
- Jev was `jev-1.13.0`, real requests.

Every round tested the branch version that existed **before** that round (blind):

| round | transcripts | facts | upstream kept | branch version | branch kept |
|---|---|---|---|---|---|
| 0 | 4 | 50 | 5 | astra.2 | 41 |
| 1 | 4 | 50 | 7 | astra.3 | 44 |
| 2 | 4 | 57 | 7 | astra.4 | 50 |
| 3 | 4 | 54 | 7 | astra.5 | 49 |
| 4 | 5 | 75 | 8 | astra.6 | 70 |
| 5 | 4 | 50 | 2 | astra.7 (this code) | 50 |
| **pooled** | **25** | **336** | **36 (0.107, CI 0.076–0.145)** | | **304 (0.905, CI 0.868–0.934)** |

- Pooled exact McNemar: $b = 268$ facts kept only by the branch, $c = 0$ kept only by upstream, $p = 2^{-267} \approx 4\times10^{-81}$.
- Facts cluster within transcripts. At the transcript level the branch kept more on 25 of 25, sign test $p = 2^{-25} \approx 3\times10^{-8}$.
- Round 5 is the blind test of the current rules. The preregistered bar was 47 of 50, with compression ≥ 0.25 on every transcript.
  - Kept: 50/50, CI 0.929–1.000; one-sided test against 0.94, $p = 0.045$.
  - Compression: 0.504 pooled, minimum 0.380.
  - Jev dropped every unpinned call in that round, so it measures the keeping rules, not Jev's decisions.
- On rounds 0–4 the current rules keep 286/286; that figure is in-sample.
- The price is compression: about half of the tokens remain after compaction, against 7–10% upstream.

## 9. Limitations

- All transcripts come from one user's Claude Code subagent sessions.
- The facts were chosen by one agent under one written rule.
- Token counts are the library's estimate, not a tokenizer.
- The transcripts themselves are private. The two CSV files carry every score, length, offset and outcome needed to
  recompute the numbers above, but no text.
