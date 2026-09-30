/**
 * Codex `SessionStart` hook (matcher `compact`): after Codex compacts a chat, give the model the facts of the tool
 * outputs the compaction removed, and save each long output in full (secret values masked).
 *
 *   node --import file:///<repo>/node_modules/tsx/dist/loader.mjs <repo>/codex/fact-sheet.ts
 *
 * Saved under `<CODEX_HOME>/fast-jev/cache/<session>/` (a `cache` folder, which backups and indexers commonly skip);
 * folders older than 30 days are deleted. `FJC_CODEX_SAVE_OUTPUTS=0` saves nothing; `FJC_CODEX_BUDGET` overrides the
 * digest size in chars. Fails open: any error writes one line to `errors.log` there and adds nothing.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetFor, buildDigest, contextWindow, parseRollout, SMALL_OUTPUT } from '../src/codex.js';
import { redactSecrets } from '../src/secrets.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MAX_FILE = 4 * 1024 * 1024;

export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['CODEX_HOME'] || join(homedir(), '.codex'), 'fast-jev', 'cache');
}

const safe = (id: string) => id.replace(/[^\w.-]/g, '_').slice(0, 120) || '_';

function version(): string {
  try {
    return String((JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string }).version ?? '?');
  } catch {
    return '?';
  }
}

export function expire(root: string, now = Date.now()): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (statSync(dir).isDirectory() && now - statSync(dir).mtimeMs > MAX_AGE_MS) rmSync(dir, { recursive: true, force: true });
  }
}

export interface HookInput {
  hook_event_name?: string;
  source?: string;
  session_id?: string;
  transcript_path?: string | null;
}

/** The hook's stdout for one event ('' = add nothing). */
export function run(input: HookInput, env: NodeJS.ProcessEnv = process.env): string {
  if (input.hook_event_name !== 'SessionStart' || input.source !== 'compact' || !input.transcript_path) return '';
  const rollout = readFileSync(input.transcript_path, 'utf8');
  const calls = parseRollout(rollout);
  if (!calls.length) return '';
  const root = cacheRoot(env);
  const save = env['FJC_CODEX_SAVE_OUTPUTS'] !== '0';
  const dir = join(root, safe(input.session_id ?? 'session'));
  const saved = new Map<string, string>();
  if (save) {
    mkdirSync(dir, { recursive: true });
    for (const call of calls) {
      if (call.output.length <= SMALL_OUTPUT) continue;
      const file = join(dir, `${safe(call.id)}.txt`);
      if (!existsSync(file)) writeFileSync(file, redactSecrets(call.output).slice(0, MAX_FILE), 'utf8');
      saved.set(call.id, file);
    }
  }
  const sheet = save ? join(dir, 'facts.md') : undefined;
  const digest = buildDigest(calls, Number(env['FJC_CODEX_BUDGET']) || budgetFor(contextWindow(rollout)), (id) => saved.get(id), sheet);
  if (sheet) writeFileSync(sheet, redactSecrets(digest.full), 'utf8');
  mkdirSync(root, { recursive: true });
  appendFileSync(join(root, 'log.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), session: input.session_id, calls: digest.total, listed: digest.listed, chars: digest.text.length, saved: saved.size, version: version() })}\n`);
  expire(root);
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: redactSecrets(`${digest.text}\n(fast-jev-compaction ${version()})`) } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', () => {
    try {
      process.stdout.write(run(JSON.parse(raw || '{}') as HookInput));
    } catch (error) {
      try {
        mkdirSync(cacheRoot(), { recursive: true });
        appendFileSync(join(cacheRoot(), 'errors.log'), `${new Date().toISOString()} ${String((error as Error)?.stack ?? error).split('\n')[0]}\n`);
      } catch {
        // fail open
      }
    }
    process.exit(0);
  });
}
