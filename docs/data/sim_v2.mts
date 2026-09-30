// Session simulation v2 (JEV-CMP-19): messages stream into a window; a compaction runs when the context reaches 60% of
// it (only after a message that carries tool results); a compaction the hook rejects falls back to the built-in
// summary (the first and the last 6 messages survive). Facts kept = needle still in its own result at the end.
// Env: SIM_LIB (lib src/index.ts), SIM_DIRS (';'-separated transcript dirs with canonical.json, facts.json and
// SIM_DECISIONS, default fork-run1.json), SIM_MODE fixed (floor 0.30, gate >= 0.25 reduction) | pressure (floor
// 1 - 0.50/p, gate: after <= 0.55 of the window), SIM_MS (window = transcript chars / m, default 0.8,1,1.2,1.5).
// Prints one JSON line per m.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const lib = await import(pathToFileURL(process.env.SIM_LIB!).href);
const MODE = process.env.SIM_MODE ?? 'fixed';
const DIRS = process.env.SIM_DIRS!.split(';').filter(Boolean);
const DEC = process.env.SIM_DECISIONS ?? 'fork-run1.json';
const MS = (process.env.SIM_MS ?? '0.8,1,1.2,1.5').split(',').map(Number);
const toLib = (ms: any[]) => ms.map((m: any) => {
  const msg: any = { role: m.role, text: m.text, toolUses: m.tool_uses.map((t: any) => ({ tool_use_id: t.id, tool: t.name, input: t.input })) };
  if (m.tool_results.length) msg.toolResults = m.tool_results.map((r: any) => ({ tool_use_id: r.id, text: r.text, isError: r.is_error }));
  return msg;
});
const chars = (ms: any[]) => ms.reduce((n: number, m: any) => n + lib.messageChars(m), 0);
const own = (ms: any[], id: string) => ms.flatMap((m: any) => m.toolResults ?? []).find((r: any) => r.tool_use_id === id)?.text ?? '';
for (const m of MS) {
  const perT: Record<string, { kept: string[]; lost: string[]; compactions: number; fallbacks: number }> = {};
  for (const d of DIRS) {
    const run = JSON.parse(readFileSync(join(d, DEC), 'utf8'));
    const canon = JSON.parse(readFileSync(join(d, 'canonical.json'), 'utf8'));
    const fs = JSON.parse(readFileSync(join(d, 'facts.json'), 'utf8')).facts;
    const ids = new Map<string, string>(); for (const mm of canon.messages) for (const r of mm.tool_results) ids.set(r.id.slice(-6), r.id);
    const all = toLib(canon.messages); const W = chars(all) / m;
    let ctx: any[] = []; let n = 0, fb = 0;
    for (const msg of all) {
      ctx.push(msg);
      if (!msg.toolResults?.length || chars(ctx) < 0.6 * W) continue;
      const before = chars(ctx); const p = before / W;
      const floor = MODE === 'pressure' ? Math.min(0.9, Math.max(0.05, 1 - 0.5 / p)) : 0.3;
      const calls = lib.collectToolCalls(ctx, 6);
      const decisions = calls.map((cl: any) => ({ id: cl.id, tool: cl.tool, ...(cl.pinned ? { action: 'keep', reason: 'pinned' } : run.decisions[cl.tool_use_id] ?? { action: 'keep', reason: 'pinned' }) }));
      const out = lib.applyWithRails(ctx, decisions, calls, 300, floor).messages;
      const after = chars(out); n++;
      const ok = MODE === 'pressure' ? after <= 0.55 * W : (before - after) / before >= 0.25;
      if (ok) ctx = out; else { fb++; ctx = [ctx[0], { role: 'user', text: '[summary]', toolUses: [] }, ...ctx.slice(-6)]; }
    }
    const kept: string[] = [], lost: string[] = [];
    for (const f of fs) (own(ctx, ids.get(f.src.slice(-6)) ?? '').includes(f.needle) ? kept : lost).push(f.id);
    perT[d] = { kept, lost, compactions: n, fallbacks: fb };
  }
  const tot = Object.values(perT).reduce((a, t) => ({ kept: a.kept + t.kept.length, total: a.total + t.kept.length + t.lost.length, compactions: a.compactions + t.compactions, fallbacks: a.fallbacks + t.fallbacks }), { kept: 0, total: 0, compactions: 0, fallbacks: 0 });
  console.log(JSON.stringify({ m, mode: MODE, lib: process.env.SIM_LIB, ...tot, perTranscript: perT }));
}
