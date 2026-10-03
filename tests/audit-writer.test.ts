import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

type Begin = ReturnType<typeof A>;
function A(n: number, t: number) {
  return { schema: 1, kind: 'begin', plugin: 'fast-jev-compaction', plugin_version: '0.3.0-astra.26',
    attempt_id: `00000000-0000-4000-8000-00000000000${n}`, session_id: null, trigger: 'manual', started_at_ms: t,
    before: { chars: 11, tokens: 7, mirrorMismatches: 0, code: 'ok' }, estimator_id: 'dense30-v1', projection_id: 'visible-text-input-result-v1' };
}
const roots: string[] = [];
let writer: typeof import('../scripts/audit-writer.mjs');
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ['node_modules/typescript/bin/tsc'], { cwd: new URL('..', import.meta.url), windowsHide: true, timeout: 30000 });
  writer = await import('../scripts/audit-writer.mjs');
}, 40000);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fjc-audit-')); roots.push(root);
  const path = await writer.resolvePrivateAuditPath(root);
  const readBack = async (): Promise<Begin[]> => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { root, path, readBack };
}
function child(root: string, event: Begin, now = 1001) {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/audit-writer.mjs')).href;
  const code = `import { main } from ${JSON.stringify(moduleUrl)}; await main(['--append'], {home: process.env.AUDIT_FIXTURE_HOME, now: ${now}});`;
  const p = spawn(process.execPath, ['--input-type=module', '--eval', code], { windowsHide: true,
    env: { ...process.env, AUDIT_FIXTURE_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    let stdout = '', stderr = ''; p.stdout.on('data', (data) => { stdout += data; }); p.stderr.on('data', (data) => { stderr += data; });
    p.on('error', reject); p.on('exit', () => { try { expect(stderr).toBe(''); resolve(JSON.parse(stdout)); } catch (error) { reject(error); } });
  });
  p.stdin.end(JSON.stringify(event)); return { p, done };
}

describe('native audit writer table', () => {
  it('one append is verified by read-back', async () => {
    const f = await fixture(); expect(await writer.appendVerified(f.path, A(1, 1000), { now: 1000 })).toEqual({ status: 'written' });
    expect(await f.readBack()).toEqual([A(1, 1000)]);
  });
  it('concurrent owner serialization', async () => {
    const f = await fixture(); const first = child(f.root, A(1, 1000)), second = child(f.root, A(2, 1001));
    expect(await Promise.all([first.done, second.done])).toEqual([{ status: 'written' }, { status: 'written' }]);
    expect((await f.readBack()).map((e) => e.attempt_id).sort()).toEqual([A(1, 1000).attempt_id, A(2, 1001).attempt_id]);
    expect((await f.readBack()).every((e) => e.schema === 1)).toBe(true);
  });
  it('repeated ACK is not duplicated', async () => {
    const f = await fixture(); await writeFile(f.path, JSON.stringify(A(1, 1000)) + '\n');
    expect(await writer.appendVerified(f.path, A(1, 1000), { now: 1000 })).toEqual({ status: 'duplicate' }); expect(await f.readBack()).toEqual([A(1, 1000)]);
  });
  it('live lock is not stolen', async () => {
    const f = await fixture(); await writeFile(f.path, JSON.stringify(A(2, 1001)) + '\n');
    const held = writer.withExclusiveLock(f.path, async () => { await new Promise((resolve) => setTimeout(resolve, 600)); return { status: 'written' as const }; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await writer.appendVerified(f.path, A(1, 1000), { now: 1001 })).toEqual({ status: 'audit_lock_busy' });
    expect(await f.readBack()).toEqual([A(2, 1001)]); await held;
  });
  it('TTL equality is retained', () => {
    expect(writer.pruneAttempts([A(1, 1000), A(2, 1001)], { now: 2000, maxAgeMs: 1000, maxAttempts: 500, maxBytes: 1048576 })).toEqual([A(1, 1000), A(2, 1001)]);
  });
  it('older than TTL removes a group', () => {
    expect(writer.pruneAttempts([A(1, 1000), A(2, 1001)], { now: 2001, maxAgeMs: 1000, maxAttempts: 500, maxBytes: 1048576 })).toEqual([A(2, 1001)]);
  });
  it('attempt cap prunes whole groups', () => {
    expect(writer.pruneAttempts([A(1, 1000), A(2, 1001), A(3, 1002)], { now: 1002, maxAgeMs: 1000, maxAttempts: 2, maxBytes: 1048576 })).toEqual([A(2, 1001), A(3, 1002)]);
  });
});

describe('native writer failure controls', () => {
  it('repairs a truncated tail without losing complete events', async () => {
    const f = await fixture(); await writeFile(f.path, JSON.stringify(A(1, 1000)) + '\n{"partial":');
    expect(await writer.appendVerified(f.path, A(2, 1001), { now: 1001 })).toMatchObject({ status: 'written', diagnostic: 'tail_repaired' });
    expect(await f.readBack()).toEqual([A(1, 1000), A(2, 1001)]);
  });
  it('corrupt middle unknown schema and conflicting duplicates do not overwrite', async () => {
    const f = await fixture();
    for (const content of ['{bad}\n' + JSON.stringify(A(1, 1000)) + '\n', JSON.stringify({ ...A(1, 1000), schema: 2 }) + '\n', JSON.stringify(A(1, 999)) + '\n']) {
      await writeFile(f.path, content);
      expect(await writer.appendVerified(f.path, A(1, 1000), { now: 1000 })).toMatchObject({ status: 'audit_corrupt' });
      expect(await readFile(f.path, 'utf8')).toBe(content);
    }
  });
  it('short writes are completed and disk-full emits only an enum', async () => {
    const buffer = Buffer.from('fixture'), bytes: number[] = [];
    await writer.writeAll({ write: async (_buffer, offset, length) => { bytes.push(offset); return { bytesWritten: Math.min(2, length) }; } }, buffer);
    expect(bytes).toEqual([0, 2, 4, 6]);
    const f = await fixture();
    expect(await writer.appendVerified(f.path, A(1, 1000), { now: 1000, write: async () => { throw Object.assign(new Error('private payload'), { code: 'ENOSPC' }); } })).toEqual({ status: 'audit_io' });
  });
  it('private path rejects traversal and junction escapes', async () => {
    const f = await fixture();
    await expect(writer.resolvePrivateAuditPath(join(f.root, '..', 'escape'))).rejects.toThrow('audit_path');
    const outside = await mkdtemp(join(tmpdir(), 'fjc-audit-outside-')); roots.push(outside);
    await rm(join(f.root, '.claude'), { recursive: true, force: true }); await symlink(outside, join(f.root, '.claude'), 'junction');
    await expect(writer.resolvePrivateAuditPath(f.root)).rejects.toThrow('audit_path');
  });
  it('oversized or private raw payloads receive only a bounded schema error', async () => {
    const f = await fixture(); const invalid = { ...A(1, 1000), body: 'private'.repeat(1000) };
    const result = await writer.appendVerified(f.path, invalid, { now: 1000 });
    expect(result).toEqual({ status: 'audit_schema' }); expect(JSON.stringify(result)).not.toContain('private');
  });
  it('maintenance reports its retention check and never creates fictional final events', async () => {
    const f = await fixture(); await writeFile(f.path, JSON.stringify(A(1, 1000)) + '\n');
    expect(await writer.maintain(f.path, { now: 1000 })).toMatchObject({ status: 'maintained', retention_checked_at: 1000 });
    expect(await f.readBack()).toEqual([A(1, 1000)]);
  });
  it('a killed native owner leaves an unverifiable lock closed', async () => {
    const f = await fixture(); await writeFile(f.path, JSON.stringify(A(1, 1000)) + '\n');
    const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/audit-writer.mjs')).href;
    const p = spawn(process.execPath, ['--input-type=module', '--eval',
      `import {withExclusiveLock} from ${JSON.stringify(moduleUrl)}; await withExclusiveLock(process.env.AUDIT_FIXTURE_PATH, async () => { process.stdout.write('ready'); await new Promise(() => setInterval(() => {}, 100)); });`],
      { windowsHide: true, env: { ...process.env, AUDIT_FIXTURE_PATH: f.path }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => { p.once('error', reject); p.stdout.once('data', () => resolve()); });
    const stopped = new Promise<void>((resolve) => p.once('exit', () => resolve())); p.kill(); await stopped;
    expect(await writer.appendVerified(f.path, A(2, 1001), { now: 1001 })).toEqual({ status: 'audit_lock_busy' });
    expect(await f.readBack()).toEqual([A(1, 1000)]);
  });
  it('byte ceiling discards whole attempts rather than cutting records', () => {
    const one = A(1, 1000), two = A(2, 1001);
    const maxBytes = Buffer.byteLength(JSON.stringify(two) + '\n');
    expect(writer.pruneAttempts([one, two], { now: 1001, maxBytes })).toEqual([two]);
  });
});
