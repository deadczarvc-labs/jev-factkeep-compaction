import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expire, run } from '../codex/fact-sheet.js';
import { buildDigest, callEntry, parseRollout, type CodexCall } from '../src/codex.js';

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
  const size = (i: number, tier: 0 | 1 | 2) => callEntry(calls[i]!, undefined, tier).length + 1;
  const HEADER = 600;

  it('gives the newest calls their fact lines first and says how many older ones it left out', () => {
    const d = buildDigest(calls, HEADER + size(4, 1) + size(3, 1), () => undefined, 'F:/x/facts.md');
    expect(d).toMatchObject({ listed: 2, total: 5 });
    expect(d.text).toContain('Error: expected 3 to be 4');
    expect(d.text).not.toContain('- c3 ');
    expect(d.text).toMatch(/3 older call\(s\) are not listed here; all 5: F:\/x\/facts\.md/);
    expect(d.full).toContain('- c1 ');
    expect(buildDigest(calls, 10, () => undefined).listed).toBe(1); // the newest call is always listed
  });

  it('names older calls in one line only with the room the fact lines leave', () => {
    const d = buildDigest(calls, HEADER + size(4, 1) + size(3, 1) + size(2, 1) + size(1, 1) + size(0, 2), () => undefined);
    expect(d.listed).toBe(5);
    expect(d.text).toContain('gateway pid 67036');
    expect(d.text).toMatch(/- c1 `[^`]*` — \d+ chars; full output/);
    expect(d.text).not.toContain('re-run to see it');
  });

  it('upgrades the newest calls to the tier-0 text when there is room', () => {
    const roomy = buildDigest(calls, 100_000, () => undefined);
    expect(roomy.text).toContain('row 3 of an ordinary listing'); // tier 0 keeps a short observation whole
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
