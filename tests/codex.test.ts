import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expire, run } from '../codex/fact-sheet.js';
import { budgetFor, buildDigest, callEntry, compactionStats, contextWindow, hybridLines, MAX_BUDGET, mdlLines, MIN_BUDGET, parseRollout, type CodexCall } from '../src/codex.js';

const item = (payload: object) => JSON.stringify({ type: 'response_item', payload });
const execWrap = (output: string, code = 0) => [
  { type: 'input_text', text: 'Script completed\nWall time 1.2 seconds\nOutput:\n' },
  { type: 'input_text', text: JSON.stringify({ chunk_id: 'a1', exit_code: code, output }) },
];
const filler = (n: number) => Array.from({ length: n }, (_, i) => `row ${i} of an ordinary listing with nothing special`).join('\n');
// Built at run time: no key-shaped literal sits in the repository.
const secret = `sk-${'proj'}-${'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0'.repeat(2)}`;

const rollout = [
  JSON.stringify({ type: 'session_meta', payload: { id: 's1' } }),
  item({ type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(await tools.exec_command({cmd:"Get-Content \'C:/a.md\' -TotalCount 90","max_output_tokens":2000}));' }),
  item({ type: 'custom_tool_call_output', call_id: 'c1', output: execWrap(filler(60)) }),
  item({ type: 'custom_tool_call', call_id: 'c2', name: 'exec', input: 'const r = await tools.exec_command({"cmd":"curl -s http://127.0.0.1:9902/health"}); text(r);' }),
  item({ type: 'custom_tool_call_output', call_id: 'c2', output: execWrap(`${filler(40)}\ngateway pid 67036 listening on 127.0.0.1:9902\n${filler(40)}\ntoken ${secret}`) }),
  item({ type: 'function_call', call_id: 'c3', namespace: 'mcp__jev', name: 'jev_verify', arguments: '{"claim":"x"}' }),
  item({ type: 'function_call_output', call_id: 'c3', output: '{"verdict":"supported"}' }),
  item({ type: 'custom_tool_call', call_id: 'c4', name: 'exec', input: 'text(await tools.exec_command({cmd:"npm test"}));' }),
  item({ type: 'custom_tool_call_output', call_id: 'c4', output: execWrap(`${filler(50)}\nFAIL tests/a.test.ts > parses\nError: expected 3 to be 4`, 1) }),
  item({ type: 'local_shell_call', call_id: 'c5', action: { command: ['bash', '-lc', 'ls -la /tmp'] } }),
  item({ type: 'custom_tool_call', call_id: 'c7', name: 'exec', input: 'text(JSON.stringify(await Promise.allSettled([tools.exec_command({cmd:"hostname"}), tools.exec_command({cmd:"whoami"})])));' }),
  item({
    type: 'custom_tool_call_output',
    call_id: 'c7',
    output: [{ type: 'input_text', text: JSON.stringify([{ status: 'fulfilled', value: { exit_code: 0, output: 'host-a17' } }, { status: 'rejected', reason: 'spawn EPERM' }]) }],
  }),
  item({ type: 'custom_tool_call', call_id: 'c6', name: 'exec', input: 'text(await tools.web__run({open:[{ref_id:"https://example.org"}]}));' }),
  '{not json',
].join('\n');

describe('parseRollout', () => {
  const calls = parseRollout(rollout);
  it('pairs calls with outputs and skips a call without one', () => {
    expect(calls.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c7']);
  });
  it('reads the shell command out of a code-mode script and decodes the exec_command wrapper', () => {
    expect(calls[0]).toMatchObject({ tool: 'Bash', command: "Get-Content 'C:/a.md' -TotalCount 90", error: false });
    expect(calls[0]!.output.startsWith('[exit 0] row 0')).toBe(true);
    expect(calls[0]!.output).not.toContain('Wall time');
  });
  it('unwraps Promise.allSettled results, a rejected entry being an error', () => {
    expect(calls[4]).toMatchObject({ tool: 'Bash', command: 'hostname\nwhoami', output: '[exit 0] host-a17\n[rejected] spawn EPERM', error: true });
  });
  it('marks a non-zero exit code as an error and names MCP tools by namespace', () => {
    expect(calls[3]!.error).toBe(true);
    expect(calls[2]).toMatchObject({ tool: 'mcp__jev__jev_verify', output: '{"verdict":"supported"}' });
  });
});

describe('callEntry', () => {
  const [read, observation, mcp, failed] = parseRollout(rollout) as [CodexCall, CodexCall, CodexCall, CodexCall];
  it('turns a long reproducible read into a re-run line', () => {
    expect(callEntry(read, 'F:/x/c1.txt')).toMatch(/a read \(\d+ chars\), re-run to see it; full output: F:\/x\/c1\.txt$/);
  });
  it('keeps the fact lines of an observation and drops the filler', () => {
    const entry = callEntry(observation, 'F:/x/c2.txt');
    expect(entry).toContain('gateway pid 67036 listening on 127.0.0.1:9902');
    expect(entry).not.toContain('row 3 of');
  });
  it('keeps a short output whole and the tail of a failure', () => {
    expect(callEntry(mcp)).toContain('{"verdict":"supported"}');
    expect(callEntry(failed)).toContain('Error: expected 3 to be 4');
  });
});

describe('PowerShell reads', () => {
  const entry = (command: string) => callEntry({ id: 'p', tool: 'Bash', command, output: filler(40), error: false });
  it('reads through variables count as re-runnable reads', () => {
    expect(entry("$p='C:/s/SKILL.md'; $x=Get-Content $p; $x[10..90]; $x.Count")).toContain('re-run to see it');
  });
  it('a variable holding a log path, or a web request, stays an observation', () => {
    expect(entry("$p='C:/logs/app.log'; Get-Content $p -Tail 50")).not.toContain('re-run');
    expect(entry('$r = Invoke-WebRequest http://127.0.0.1:9902/health; $r.Content')).not.toContain('re-run');
  });
});

describe('buildDigest', () => {
  const calls = parseRollout(rollout);
  // 150 observations of ~2 KB, each with one fact line.
  const many: CodexCall[] = Array.from({ length: 150 }, (_, i) => ({
    id: `m${i}`, tool: 'Bash', command: `curl -s http://127.0.0.1:${9000 + i}/health`, error: false,
    output: `${filler(18)}\nworker pid ${40000 + i} listening on 127.0.0.1:${9000 + i}\n${filler(18)}`,
  }));
  const entry = (i: number, tier: 0 | 1 | 2) => callEntry(many[i]!, undefined, tier);

  it('keeps the newest calls whole within half the budget, then fact lines, then one line, and counts the rest', () => {
    const d = buildDigest(many, 20_600, () => undefined, 'F:/x/facts.md');
    expect(d.text).toContain(entry(149, 0));
    expect(d.text).toContain('row 5 of an ordinary listing');
    expect(d.text).toContain(entry(130, 1));
    expect(d.text).not.toContain(entry(130, 0));
    expect(d.listed).toBeLessThan(150);
    expect(d.text).toMatch(new RegExp(`${150 - d.listed} older call\\(s\\) are not listed here; all 150: F:/x/facts\\.md`));
    expect(d.text.length).toBeLessThanOrEqual(20_600);
    expect(d.full).toContain('- m0 ');
  });

  it('puts every output verbatim when all fit, reads included', () => {
    const d = buildDigest(calls, 100_000, () => undefined);
    for (const c of calls) expect(d.text).toContain(callEntry(c, undefined, 0));
  });

  it('skips a newest output too long for half the budget instead of stopping there', () => {
    const giant: CodexCall = { id: 'g', tool: 'Bash', command: 'Get-Content big.json', error: false, output: `${filler(1000)}\nbuild id 7f3a9c` };
    const d = buildDigest([...many.slice(0, 20), giant], 20_600, () => undefined);
    expect(d.text).toContain(entry(19, 0));
    expect(d.text).not.toContain('row 999 of');
  });

  it('always lists the newest call, and a roomy budget keeps short observations whole', () => {
    expect(buildDigest(calls, 10, () => undefined).listed).toBe(1);
    expect(buildDigest(calls, 100_000, () => undefined).text).toContain('gateway pid 67036');
  });
});

describe('line selectors', () => {
  const table = Array.from({ length: 200 }, (_, i) => `row ${i % 7} ok ok ok status=ready region=eu-west`).join('\n');
  const text = `${table}\nbuild 7f3a9c2e41d8b05f verified: 3 of 4 checks failed\n${table}`;
  it('MDL keeps the line that does not compress against the output around it', () => {
    expect(mdlLines(text, 200).join('\n')).toContain('7f3a9c2e41d8b05f');
  });
  it('hybrid keeps regex fact lines and adds MDL lines within the same budget', () => {
    const lines = hybridLines(text, 400);
    expect(lines.join('\n')).toContain('3 of 4 checks failed');
    expect(lines.reduce((n, l) => n + l.length + 1, 0)).toBeLessThanOrEqual(400);
  });
});

describe('compactionStats', () => {
  const tok = (n: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: n } } } });
  it('reads the context before and after each compaction and counts reads of saved outputs', () => {
    const jsonl = [tok(600_000), tok(675_696), JSON.stringify({ type: 'compacted', payload: { message: '' } }), tok(0), tok(50_821), tok(90_000), tok(676_000), JSON.stringify({ type: 'compacted', payload: {} })].join('\n');
    const calls: CodexCall[] = [
      { id: 'r', tool: 'Bash', command: "Get-Content 'C:/Users/u/.codex/fast-jev/cache/s/call_x.txt'", output: 'x', error: false },
      { id: 'o', tool: 'Bash', command: 'git status', output: 'x', error: false },
    ];
    expect(compactionStats(jsonl, calls)).toEqual({ before: [675_696, 676_000], after: [50_821, null], reads: 1 });
  });
});

describe('budgetFor', () => {
  it('is 5% of the model window in chars, within its floor and cap', () => {
    expect(budgetFor(undefined)).toBe(MIN_BUDGET);
    expect(budgetFor(64_000)).toBe(MIN_BUDGET);
    expect(budgetFor(272_000)).toBe(54_400);
    expect(budgetFor(2_000_000)).toBe(MAX_BUDGET);
  });
  it('reads the last model_context_window the rollout reports', () => {
    const jsonl = ['{"type":"event_msg","payload":{"type":"task_started","model_context_window":272000}}', '{"x":{"model_context_window": 828400}}'].join('\n');
    expect(contextWindow(jsonl)).toBe(828_400);
    expect(contextWindow(rollout)).toBeUndefined();
  });
});

describe('fact-sheet hook', () => {
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), 'fjc-codex-'));
    const path = join(home, 'rollout.jsonl');
    writeFileSync(path, rollout, 'utf8');
    return { home, path, env: { CODEX_HOME: home } as NodeJS.ProcessEnv };
  };

  it('adds nothing outside a post-compaction SessionStart', () => {
    const { path, env } = setup();
    expect(run({ hook_event_name: 'SessionStart', source: 'startup', transcript_path: path }, env)).toBe('');
    expect(run({ hook_event_name: 'PreCompact', source: 'compact', transcript_path: path }, env)).toBe('');
    expect(run({ hook_event_name: 'SessionStart', source: 'compact', transcript_path: null }, env)).toBe('');
  });

  it('returns the facts as SessionStart context and saves long outputs with secret values masked', () => {
    const { home, path, env } = setup();
    const out = JSON.parse(run({ hook_event_name: 'SessionStart', source: 'compact', session_id: '../../evil', transcript_path: path }, env));
    const context: string = out.hookSpecificOutput.additionalContext;
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(context).toContain('gateway pid 67036');
    expect(context).not.toContain(secret.slice(-12));
    const dir = join(home, 'fast-jev', 'cache', '.._.._evil');
    expect(readdirSync(join(home, 'fast-jev', 'cache')).sort()).toEqual(['.._.._evil', 'log.jsonl']);
    const saved = readFileSync(join(dir, 'c2.txt'), 'utf8');
    expect(saved).toContain('gateway pid 67036');
    expect(saved).not.toContain(secret.slice(-12));
    expect(existsSync(join(dir, 'c3.txt'))).toBe(false); // short: whole in the digest
    expect(readFileSync(join(dir, 'facts.md'), 'utf8')).toContain('c1');
  });

  it('saves nothing when saving is off', () => {
    const { home, path } = setup();
    run({ hook_event_name: 'SessionStart', source: 'compact', session_id: 's', transcript_path: path }, { CODEX_HOME: home, FJC_CODEX_SAVE_OUTPUTS: '0' });
    expect(existsSync(join(home, 'fast-jev', 'cache', 's'))).toBe(false);
  });

  it('deletes saved sessions older than 30 days and keeps fresh ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'fjc-exp-'));
    mkdirSync(join(root, 'old'));
    mkdirSync(join(root, 'new'));
    const old = new Date(Date.now() - 31 * 24 * 3600 * 1000);
    utimesSync(join(root, 'old'), old, old);
    expire(root);
    expect(readdirSync(root)).toEqual(['new']);
  });
});
