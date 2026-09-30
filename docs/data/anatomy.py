"""Recompute every number in docs/why-facts-are-lost.md from calls.csv and facts.csv (stdlib only).

Run: python docs/data/anatomy.py
"""

import csv
import pathlib
import random
import statistics
from math import comb

HERE = pathlib.Path(__file__).resolve().parent
TAU, HEAD = 0.5, 300


def rows(name):
    with open(HERE / name, encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def auc(pos, neg):
    s = sum(1.0 if a > b else 0.5 if a == b else 0.0 for a in pos for b in neg)
    return s / (len(pos) * len(neg))


def clopper_pearson(k, n, a=0.05):
    cdf = lambda k_, p: sum(
        comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(k_ + 1)
    )

    def bisect(pred):
        lo, hi = 0.0, 1.0
        for _ in range(60):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if pred(mid) else (lo, mid)
        return (lo + hi) / 2

    lower = 0.0 if k == 0 else bisect(lambda p: 1 - cdf(k - 1, p) < a / 2)
    upper = 1.0 if k == n else bisect(lambda p: cdf(k, p) > a / 2)
    return round(lower, 3), round(upper, 3)


def hist(values, edges=(0, 0.1, 0.2, 0.3, 0.4, 0.5, 1.01)):
    return [
        sum(edges[i] <= v < edges[i + 1] for v in values) for i in range(len(edges) - 1)
    ]


calls, facts = rows("calls.csv"), rows("facts.csv")
key = lambda r: (r["round"], r["transcript"])
free = [c for c in calls if c["action"] != "pinned"]
print(
    f"transcripts {len({key(c) for c in calls})}, calls {len(calls)}, unpinned {len(free)}, "
    f"fact-bearing unpinned {sum(c['fact_bearing'] == '1' for c in free)}, facts {len(facts)}"
)


def decisions(suffix=""):
    kr = [
        float(c[f"keep_result{suffix}"]) for c in free if c.get(f"keep_result{suffix}")
    ]
    kc = [float(c[f"keep_call{suffix}"]) for c in free if c.get(f"keep_call{suffix}")]
    bear = [
        float(c[f"keep_result{suffix}"])
        for c in free
        if c["fact_bearing"] == "1" and c.get(f"keep_result{suffix}")
    ]
    other = [
        float(c[f"keep_result{suffix}"])
        for c in free
        if c["fact_bearing"] == "0" and c.get(f"keep_result{suffix}")
    ]
    return kr, kc, bear, other


for label, suffix in (
    ("upstream", ""),
    ("ablation nopremise", "_nopremise"),
    ("ablation noconj", "_noconj"),
):
    kr, kc, bear, other = decisions(suffix)
    if not kr:
        continue
    print(
        f"\n[{label}] keepResult: max {max(kr):.2f}, share >= {TAU}: {sum(x >= TAU for x in kr)}/{len(kr)}, "
        f"median fact-bearing {statistics.median(bear):.2f} vs other {statistics.median(other):.2f}"
    )
    print(
        f"  keepResult histogram [0,.1,.2,.3,.4,.5,1]: fact-bearing {hist(bear)}, other {hist(other)}"
    )
    print(
        f"  keepCall: max {max(kc):.2f}, share >= {TAU}: {sum(x >= TAU for x in kc)}/{len(kc)}, histogram {hist(kc)}"
    )
    print(f"  AUC keepResult (fact-bearing vs other): {auc(bear, other):.3f}")
    acts = [c[f"action{suffix}"] for c in free]
    print(
        "  actions: "
        + ", ".join(
            f"{a} {acts.count(a)}" for a in ("keep", "drop_result", "drop_call")
        )
    )

# Cluster bootstrap of the AUC (transcripts resampled), upstream decisions.
rng = random.Random(20260930)
groups = {}
for c in free:
    groups.setdefault(key(c), []).append(c)
ids = list(groups)
boot = []
for _ in range(2000):
    s = [c for g in rng.choices(ids, k=len(ids)) for c in groups[g]]
    b = [float(c["keep_result"]) for c in s if c["fact_bearing"] == "1"]
    o = [float(c["keep_result"]) for c in s if c["fact_bearing"] == "0"]
    if b and o:
        boot.append(auc(b, o))
boot.sort()
print(
    f"\nAUC 95% cluster bootstrap: [{boot[int(0.025 * len(boot))]:.3f}, {boot[int(0.975 * len(boot)) - 1]:.3f}]"
)

# Threshold sweep: to keep a share of fact-bearing results, what share of the others must be kept?
_, _, bear, other = decisions()
for goal in (0.5, 0.8, 0.9, 0.94):
    t = max(
        x for x in set(bear + other) if sum(y >= x for y in bear) / len(bear) >= goal
    )
    print(
        f"  keep >= {goal:.0%} of fact-bearing results: threshold {t:.2f}, fact-bearing kept "
        f"{sum(y >= t for y in bear) / len(bear):.3f}, others kept {sum(y >= t for y in other) / len(other):.3f}"
    )

# Fate of every fact under the upstream rule, and a check that the rule reproduces the output.
fate, predicted = {}, 0
for f in facts:
    L, o, n = int(f["result_chars"]), int(f["offset"]), int(f["needle_chars"])
    in_head = 0 <= o and o + n <= HEAD or L <= HEAD + 120
    a = f["upstream_action"]
    k = (
        a
        if a in ("pinned", "keep")
        else ("drop_result_in_head" if in_head else "drop_result_cut")
        if a == "drop_result"
        else "drop_call"
    )
    fate[k] = fate.get(k, 0) + 1
    predicted += int(k in ("pinned", "keep", "drop_result_in_head")) == int(
        f["upstream_kept"]
    )
print(
    f"\nfate: {fate}; rule reproduces the observed output on {predicted}/{len(facts)} facts"
)

long = [f for f in facts if int(f["result_chars"]) > HEAD + 120]
rel = [int(f["offset"]) / int(f["result_chars"]) for f in long]
print(
    f"facts in results > {HEAD + 120} chars: {len(long)}; inside the first {HEAD} chars: "
    f"{sum(int(f['offset']) + int(f['needle_chars']) <= HEAD for f in long) / len(long):.3f}; "
    f"mean h/L {statistics.mean(min(1, HEAD / int(f['result_chars'])) for f in long):.3f}; "
    f"relative position quartiles {[round(q, 2) for q in statistics.quantiles(rel, n=4)]}"
)
pinned = sum(f["upstream_action"] == "pinned" for f in facts)
print(f"facts whose call was pinned: {pinned}/{len(facts)} = {pinned / len(facts):.3f}")

n = len(facts)
for col in (
    "upstream_kept",
    "fork_heldout_kept",
    "fork_final_kept",
    "kept_nopremise",
    "kept_noconj",
):
    if col in facts[0]:
        k = sum(int(f[col]) for f in facts)
        print(f"{col}: {k}/{n} = {k / n:.3f}, 95% CI {clopper_pearson(k, n)}")
b = sum(f["fork_heldout_kept"] == "1" and f["upstream_kept"] == "0" for f in facts)
c = sum(f["fork_heldout_kept"] == "0" and f["upstream_kept"] == "1" for f in facts)
p = min(1.0, 2 * sum(comb(b + c, i) for i in range(min(b, c) + 1)) / 2 ** (b + c))
print(f"McNemar (held-out fork vs upstream): b {b}, c {c}, exact p {p:.2e}")
per = {}
for f in facts:
    u, h = per.get(key(f), (0, 0))
    per[key(f)] = (u + int(f["upstream_kept"]), h + int(f["fork_heldout_kept"]))
wins = sum(h > u for u, h in per.values())
print(
    f"transcripts where the held-out fork kept more: {wins}/{len(per)}, sign test p {0.5**wins:.2e}"
)
