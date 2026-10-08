import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { pluginRootFor, readPluginVersion, run } from '../codex/fact-sheet.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readFile = vi.mocked(fs.readFileSync);
const canonicalVersion = '0.3.0-astra.30';
const manifestAt = (name: string): Record<string, unknown> => JSON.parse(fs.readFileSync(join(root, '.codex-plugin', name), 'utf8'));
const scratch: string[] = [];

afterEach(async () => {
  const original = await vi.importActual<typeof import('node:fs')>('node:fs');
  readFile.mockReset();
  readFile.mockImplementation(original.readFileSync);
  vi.restoreAllMocks();
});
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Codex plugin packaging', () => {
  it('source hook resolves canonical root', () => {
    readFile.mockReturnValue(JSON.stringify({ version: canonicalVersion }));
    expect(pluginRootFor('file:///C:/p/codex/fact-sheet.ts')).toBe('C:/p');
    expect(readPluginVersion('C:/p')).toBe(canonicalVersion);
    expect(String(readFile.mock.calls[0]![0]).replace(/\\/g, '/')).toBe('C:/p/.claude-plugin/plugin.json');
  });

  it('emitted hook resolves the same canonical root', () => {
    readFile.mockReturnValue(JSON.stringify({ version: canonicalVersion }));
    expect(pluginRootFor('file:///C:/p/codex-dist/codex/fact-sheet.js')).toBe('C:/p');
    expect(readPluginVersion('C:/p')).toBe(canonicalVersion);
    expect(String(readFile.mock.calls[0]![0]).replace(/\\/g, '/')).toBe('C:/p/.claude-plugin/plugin.json');
  });

  it('Codex manifest has only post-compact hook', () => {
    const manifest = manifestAt('plugin.json');
    expect(manifest).toMatchObject({
      name: 'fast-jev-compaction',
      repository: 'https://github.com/deadczarvc-labs/jev-factkeep-compaction',
      version: JSON.parse(fs.readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version,
      hooks: './.codex-plugin/hooks.json',
    });
    const { hooks } = manifestAt('hooks.json') as { hooks: Record<string, Array<{ matcher: string; hooks: object[] }>> };
    expect(Object.keys(hooks)).toEqual(['SessionStart']);
    expect(hooks['SessionStart']).toHaveLength(1);
    const group = hooks['SessionStart']![0]!;
    expect(group.matcher).toBe('compact');
    expect(group.hooks).toHaveLength(1);
    expect(group.hooks[0]).toMatchObject({
      type: 'command',
      command: 'node "${PLUGIN_ROOT}/codex-dist/codex/fact-sheet.js"',
      timeout: 30,
      additionalContextLimit: 70000,
    });
    expect(fs.existsSync(join(root, 'plugin.json'))).toBe(false);
  });

  it('startup event cannot inject recovery', () => {
    readFile.mockClear();
    expect(run({ hook_event_name: 'SessionStart', source: 'startup', transcript_path: 'C:/missing.jsonl' })).toBe('');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('missing or malformed release metadata keeps the unknown-version fallback', () => {
    readFile.mockImplementationOnce(() => { throw new Error('missing manifest'); });
    expect(readPluginVersion('C:/p')).toBe('?');
    readFile.mockReturnValueOnce('{not json');
    expect(readPluginVersion('C:/p')).toBe('?');
    readFile.mockReturnValueOnce('{}');
    expect(readPluginVersion('C:/p')).toBe('?');
  });

  it('packages the emitted runtime and its canonical release metadata explicitly', () => {
    const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['build:codex']).toBe('tsc -p tsconfig.codex-build.json');
    expect(pkg.files).toEqual(expect.arrayContaining(['.codex-plugin', 'codex-dist/src', 'codex-dist/codex', '.claude-plugin/plugin.json']));
    expect(pkg.files).not.toContain('codex-dist');
    const typecheck = JSON.parse(fs.readFileSync(join(root, 'tsconfig.codex.json'), 'utf8'));
    expect(typecheck.compilerOptions.noEmit).toBe(true);
    const build = JSON.parse(fs.readFileSync(join(root, 'tsconfig.codex-build.json'), 'utf8'));
    expect(build.compilerOptions).toMatchObject({ rootDir: '.', outDir: 'codex-dist', noEmit: false });
    expect(build.include).toEqual(['src/**/*.ts', 'codex/**/*.ts']);
  });

  it('builds an importable emitted entry and restores compact facts without a Jev request', () => {
    const build = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.codex-build.json'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    expect({ error: build.error?.message, status: build.status, stdout: build.stdout, stderr: build.stderr }).toEqual({
      error: undefined, status: 0, stdout: '', stderr: '',
    });
    const entry = join(root, 'codex-dist', 'codex', 'fact-sheet.js');
    expect(fs.existsSync(entry)).toBe(true);
    const imported = spawnSync(process.execPath, ['--input-type=module', '--eval',
      `const hook = await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log(JSON.stringify({root: hook.pluginRootFor(${JSON.stringify(pathToFileURL(entry).href)}), version: hook.readPluginVersion(hook.pluginRootFor(${JSON.stringify(pathToFileURL(entry).href)}))}));`,
    ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(imported.status).toBe(0);
    expect(imported.stderr).toBe('');
    expect(JSON.parse(imported.stdout)).toEqual({ root: pluginRootFor(import.meta.url.replace(/tests\/codex-plugin\.test\.ts$/, 'codex/fact-sheet.ts')), version: canonicalVersion });

    const home = fs.mkdtempSync(join(tmpdir(), 'fjc-codex-plugin-'));
    scratch.push(home);
    const path = join(home, 'rollout.jsonl');
    fs.writeFileSync(path, [
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'marker', name: 'exec_command', arguments: '{"cmd":"git status"}' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'marker', output: 'observation-marker-r4' } }),
      '{"type":"compacted","payload":{}}',
    ].join('\n'), 'utf8');
    const input = { hook_event_name: 'SessionStart', source: 'compact', transcript_path: path, session_id: 'emitted' };
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected Jev request'));
    expect(JSON.parse(run(input, { CODEX_HOME: home, FJC_CODEX_SAVE_OUTPUTS: '0' })).hookSpecificOutput.additionalContext).toContain('observation-marker-r4');
    expect(network).not.toHaveBeenCalled();
    const executed = spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("unexpected network")}', entry], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, CODEX_HOME: home, FJC_CODEX_SAVE_OUTPUTS: '0' }, input: JSON.stringify(input),
    });
    expect(executed.status).toBe(0);
    expect(executed.stderr).toBe('');
    const output = JSON.parse(executed.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext).toContain('observation-marker-r4');
    expect(output.hookSpecificOutput.additionalContext).toContain(`(fast-jev-compaction ${canonicalVersion})`);
    const logs = fs.readFileSync(join(home, 'fast-jev', 'cache', 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ before: [null], after: [null], reads: 0, version: canonicalVersion, selector: 'regex' });
  });

  it('npm packaging includes the complete runtime but excludes generated probe data', () => {
    for (const config of ['tsconfig.json', 'tsconfig.codex-build.json']) {
      const built = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', config], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
      });
      expect({ error: built.error?.message, status: built.status, stdout: built.stdout, stderr: built.stderr }).toEqual({
        error: undefined, status: 0, stdout: '', stderr: '',
      });
    }
    const packed = spawnSync(process.platform === 'win32' ? (process.env['ComSpec'] || 'cmd.exe') : 'npm',
      process.platform === 'win32' ? ['/d', '/s', '/c', 'npm pack --dry-run --json --ignore-scripts'] : ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
      });
    expect(packed.error).toBeUndefined();
    expect(packed.status).toBe(0);
    type Listing = { entryCount: number; files: Array<{ path: string }> };
    const parsed = JSON.parse(packed.stdout) as Listing[] | Record<string, Listing>;
    const records = Array.isArray(parsed) ? parsed : Object.values(parsed);
    expect(records).toHaveLength(1);
    const listing = records[0]!;
    const paths = listing.files.map((file) => file.path).sort();
    expect(paths).toHaveLength(listing.entryCount);
    expect(paths).toEqual(expect.arrayContaining([
      '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.codex-plugin/hooks.json',
      'codex-dist/codex/fact-sheet.js', 'codex-dist/src/codex.js', 'dist/index.js', 'package.json',
      'scripts/audit-writer.mjs', 'dist/audit.js', 'dist/metrics.js',
    ]));
    expect(paths.filter((path) => /test-runtime|host-schema|\.jsonl$|(?:^|\/)\.env(?:\/|$)/.test(path))).toEqual([]);
    expect(paths.every((path) => path.startsWith('dist/') || path.startsWith('codex-dist/src/') || [
      '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.codex-plugin/hooks.json',
      'codex-dist/codex/fact-sheet.js', 'scripts/audit-writer.mjs', 'README.md', 'LICENSE', 'package.json',
    ].includes(path))).toBe(true);
    console.info(JSON.stringify({ packageFileCount: listing.entryCount, packageFiles: paths }));
  });
});
