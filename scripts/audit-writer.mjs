// @ts-check
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildAuditEvent, parseAuditLog, serializeAuditEvent, validateAuditEvent, MAX_RECORD_BYTES } from '../dist/audit.js';

/** @typedef {import('../dist/audit.js').AuditEvent} AuditEvent */
/** @typedef {import('../dist/audit.js').AuditAck} AuditAck */
/** @typedef {{now:number,maxAgeMs?:number,maxAttempts?:number,maxBytes?:number}} Limits */
/** @typedef {{write:(buffer:Buffer,offset:number,length:number)=>Promise<{bytesWritten:number}>}} Writable */
export const CEILINGS = Object.freeze({ maxRecordBytes: 4096, maxBytes: 1048576, maxAttempts: 500, maxAgeMs: 2592000000 });
const execute = promisify(execFile);
/** @param {unknown} error */
function code(error) { return error !== null && typeof error === 'object' && 'code' in error ? error.code : null; }
/** @param {string} path @param {boolean} [optional] */
async function regular(path, optional = false) {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('audit_path');
  } catch (error) { if (!optional || code(error) !== 'ENOENT') throw error; }
}
/** No symbolic links/junctions at any component, including existing parents. @param {string} directory */
async function realParent(directory) {
  let current = resolve(directory);
  while (true) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('audit_path');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const real = await fs.realpath(directory);
  if (real.toLowerCase() !== resolve(directory).toLowerCase()) throw new Error('audit_path');
}
/** Restrict a directory/file to the current user and SYSTEM. Native argv only; all children hidden. @param {string} path */
async function privateAccess(path) {
  if (process.platform !== 'win32') { await fs.chmod(path, (await fs.lstat(path)).isDirectory() ? 0o700 : 0o600); return; }
  const system = join(process.env.SystemRoot ?? 'C:/Windows', 'System32');
  const { stdout } = await execute(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 350, maxBuffer: 4096 });
  const sid = stdout.match(/S-1-5-21-\d+-\d+-\d+-\d+/)?.[0];
  if (!sid) throw new Error('audit_path');
  const tool = join(system, 'icacls.exe');
  const directory = (await fs.lstat(path)).isDirectory();
  const access = directory ? '(OI)(CI)F' : 'F';
  await execute(tool, [path, '/inheritance:r', '/grant:r', `*${sid}:${access}`, `*S-1-5-18:${access}`, '/q'], { windowsHide: true, timeout: 350, maxBuffer: 4096 });
  const snapshot = join(directory ? path : dirname(path), `${randomUUID()}.acl.tmp`);
  try {
    await execute(tool, [path, '/save', snapshot, '/q'], { windowsHide: true, timeout: 350, maxBuffer: 4096 });
    const saved = (await fs.readFile(snapshot)).toString('utf16le');
    const entries = [...saved.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]?.split(';') ?? []);
    if (entries.length !== 2 || entries.some((ace) => ace[0] !== 'A' || ![sid, 'SY', 'S-1-5-18'].includes(ace[5] ?? ''))) throw new Error('audit_path');
  } finally { await fs.unlink(snapshot).catch(() => {}); }
}
/** Test callers can inject an existing scratch home; production always uses the native user home. @param {string} [home] */
export async function resolvePrivateAuditPath(home = homedir()) {
  if (!isAbsolute(home) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(home) || /^[\\/]{2}/.test(home)) throw new Error('audit_path');
  try {
    await realParent(home);
    let directory = home;
    for (const component of ['.claude', 'fast-jev', 'cache', 'audit']) {
      directory = join(directory, component);
      try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (code(error) !== 'EEXIST') throw error; }
      await realParent(directory);
    }
    const path = join(directory, 'compactions.jsonl');
    await regular(path, true); await regular(`${path}.lock`, true);
    await privateAccess(directory);
    return path;
  } catch { throw new Error('audit_path'); }
}
/** Never steal a stale lock based on age or PID; recovery requires separately verified owner start identity.
 * @template T @param {string} path @param {()=>Promise<T>} action @returns {Promise<T|AuditAck>}
 */
export async function withExclusiveLock(path, action) {
  const lock = `${path}.lock`, token = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const deadline = Date.now() + 500;
  /** @type {import('node:fs/promises').FileHandle|undefined} */
  let handle;
  try {
    await realParent(dirname(path)); await regular(path, true);
    while (!handle) {
      try { handle = await fs.open(lock, 'wx', 0o600); }
      catch (error) {
        if (code(error) !== 'EEXIST') throw error;
        if (Date.now() >= deadline) return { status: 'audit_lock_busy' };
        await new Promise((done) => setTimeout(done, Math.min(10, deadline - Date.now())));
      }
    }
    await writeAll(handle, Buffer.from(token)); await handle.sync();
    return await action();
  } catch { return { status: 'audit_io' }; }
  finally {
    if (handle) {
      await handle.close().catch(() => {});
      try { if (await fs.readFile(lock, 'utf8') === token) await fs.unlink(lock); } catch { /* Keep an unverifiable lock closed. */ }
    }
  }
}
/** @param {Writable} target @param {Buffer} buffer */
export async function writeAll(target, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await target.write(buffer, offset, buffer.length - offset);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buffer.length - offset) throw new Error('audit_io');
    offset += bytesWritten;
  }
}
/** Groups include begin/final together; age is the oldest stamp. Equality at the age boundary survives.
 * @template {AuditEvent} T @param {readonly T[]} events @param {Limits} limits @returns {T[]}
 */
export function pruneAttempts(events, limits) {
  const settings = { ...CEILINGS, ...limits };
  /** @type {Map<string,{stamp:number,events:T[]}>} */
  const groups = new Map();
  for (const event of events) {
    const group = groups.get(event.attempt_id) ?? { stamp: event.started_at_ms, events: [] };
    group.stamp = Math.min(group.stamp, event.started_at_ms); group.events.push(event); groups.set(event.attempt_id, group);
  }
  const ordered = [...groups.values()].filter((g) => g.stamp >= settings.now - settings.maxAgeMs).sort((a, b) => a.stamp - b.stamp);
  while (ordered.length > settings.maxAttempts) ordered.shift();
  const size = () => ordered.reduce((total, g) => total + g.events.reduce((n, e) => n + Buffer.byteLength(serializeAuditEvent(e)), 0), 0);
  while (size() > settings.maxBytes) ordered.shift();
  const ids = new Set(ordered.flatMap((g) => g.events.map((e) => e.attempt_id)));
  return events.filter((event) => ids.has(event.attempt_id));
}
/** Atomic replacement under the same append lock, with no second stable journal. @param {string} path @param {string} text */
async function replace(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await fs.open(temporary, 'wx', 0o600);
  try { await writeAll(file, Buffer.from(text)); await file.sync(); }
  finally { await file.close(); }
  try {
    await regular(path, true); await fs.rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await fs.open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
/** @param {string} path */
async function readExisting(path) {
  await regular(path, true);
  let text = '';
  try {
    if ((await fs.stat(path)).size > CEILINGS.maxBytes + CEILINGS.maxRecordBytes) return { events: [], code: 'audit_corrupt', text };
    text = await fs.readFile(path, 'utf8');
  } catch (error) { if (code(error) !== 'ENOENT') throw error; }
  return { ...parseAuditLog(text), text };
}
/** @param {AuditEvent} event */
function canonical(event) { return serializeAuditEvent(buildAuditEvent(event)); }
/** @param {string} path @param {unknown} event @param {{now?:number,write?:(file:import('node:fs/promises').FileHandle,buffer:Buffer)=>Promise<void>}} [options] @returns {Promise<AuditAck>} */
export async function appendVerified(path, event, options = {}) {
  if (!validateAuditEvent(event)) return { status: 'audit_schema' };
  let line;
  try { line = serializeAuditEvent(event); } catch { return { status: 'audit_schema' }; }
  return withExclusiveLock(path, async () => {
    try { await fs.lstat(path); await privateAccess(path); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    const existing = await readExisting(path);
    if (existing.code === 'audit_corrupt' || existing.code === 'unknown_schema') return { status: 'audit_corrupt' };
    const previous = existing.events.find((e) => e.attempt_id === event.attempt_id && e.kind === event.kind);
    if (previous && canonical(previous) !== canonical(event)) return { status: 'audit_corrupt' };
    const retained = pruneAttempts(previous ? existing.events : [...existing.events, event], { now: options.now ?? Date.now() });
    const before = retained.filter((e) => e !== event || previous !== undefined).map(serializeAuditEvent).join('');
    if (before !== existing.text) await replace(path, before);
    if (!previous) {
      if (!retained.includes(event)) return { status: 'audit_io' };
      await regular(path, true);
      const file = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await (options.write ?? writeAll)(file, Buffer.from(line)); await file.sync(); } finally { await file.close(); }
    }
    await privateAccess(path);
    const verified = await readExisting(path);
    if (verified.code !== 'ok' || !verified.events.some((e) => canonical(e) === canonical(event))) return { status: 'audit_io' };
    return { status: previous ? 'duplicate' : 'written', ...(existing.code === 'tail_repaired' ? { diagnostic: 'tail_repaired' } : {}) };
  });
}
/** @param {string} path @param {{now?:number}} [options] */
export async function maintain(path, options = {}) {
  return withExclusiveLock(path, async () => {
    const existing = await readExisting(path);
    if (existing.code === 'audit_corrupt' || existing.code === 'unknown_schema') return { status: 'audit_corrupt' };
    const now = options.now ?? Date.now(), events = pruneAttempts(existing.events, { now });
    const text = events.map(serializeAuditEvent).join('');
    if (text !== existing.text) await replace(path, text);
    if ((await readExisting(path)).code !== 'ok') return { status: 'audit_io' };
    return { status: 'maintained', retention_checked_at: now, attempts: new Set(events.map((e) => e.attempt_id)).size,
      ...(existing.code === 'tail_repaired' ? { diagnostic: 'tail_repaired' } : {}) };
  });
}
/** Fixed operations only. Injected home/clock exist for offline tests, never in argv or event fields.
 * @param {readonly string[]} [argv] @param {{home?:string,now?:number}} [options]
 */
export async function main(argv = process.argv.slice(2), options = {}) {
  /** @type {Record<string,unknown>} */
  let ack = { status: 'audit_schema' };
  try {
    if (argv.length !== 1 || !['--append', '--maintenance'].includes(argv[0] ?? '')) throw new Error('audit_schema');
    /** @type {unknown} */
    let event;
    if (argv[0] === '--append') {
      const chunks = []; let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > MAX_RECORD_BYTES) throw new Error('audit_schema');
        chunks.push(chunk);
      }
      event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!validateAuditEvent(event)) throw new Error('audit_schema');
    }
    const path = await resolvePrivateAuditPath(options.home);
    ack = argv[0] === '--append' ? await appendVerified(path, event, options) : await maintain(path, options);
  } catch (error) { ack = { status: error instanceof Error && error.message === 'audit_path' ? 'audit_path' : 'audit_schema' }; }
  process.stdout.write(JSON.stringify(ack) + '\n');
  process.exitCode = ['written', 'duplicate', 'maintained'].includes(String(ack.status)) ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
