import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const USER_CONTENT = 'USER-AUTHORED-CONTENT\n';
const ISOLATED_ENV_KEYS = ['HOME', 'CLAUDE_CONFIG_DIR', 'OMC_STATE_DIR', 'OMC_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR', 'CLAUDECODE'];
const fixture = (name: string) => readFileSync(join(process.cwd(), 'src', '__tests__', 'fixtures', 'historical-install', name));
const shippedAgent = (name: string) => readFileSync(join(process.cwd(), 'agents', name));
const shippedHook = (name: string) => readFileSync(join(process.cwd(), 'templates', 'hooks', name));

let home: string;
let configDir: string;
let extraRoots: string[];
const savedEnv = new Map<string, string | undefined>();

function put(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function loadInstaller() {
  vi.resetModules();
  return import('../installer/index.js');
}

async function installCapturingLogs(options: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
  const { install } = await loadInstaller();
  const result = install({ skipClaudeCheck: true, skipHud: true, verbose: true, ...options });
  spy.mockRestore();
  expect(result.success).toBe(true);
  return { result, logs };
}

const asset = (...segments: string[]) => join(configDir, ...segments);

function manifestEntry(content: string | Buffer): string {
  const bytes = Buffer.from(content);
  return `${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}`;
}

function writeManifest(entries: Record<string, string>): void {
  put(asset('.omc-managed-assets.json'), JSON.stringify(entries));
}

function enableFakePlugin(extraSettings: Record<string, unknown> = {}): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omc-preservation-plugin-')));
  extraRoots.push(root);
  put(join(root, 'dist', 'hooks', 'skill-bridge.cjs'), 'console.log("skill bridge");\n');
  put(join(root, 'bridge', 'cli.cjs'), 'console.log("bridge");\n');
  put(join(root, 'bridge', 'claude-md-coordinator.cjs'), 'console.log("coordinator");\n');
  put(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node test.mjs' }] }] } }));
  put(join(root, 'skills', 'plan', 'SKILL.md'), '# plan\n');
  put(join(root, 'commands', 'omc-setup.md'), 'Read skills/omc-setup/SKILL.md and pass $ARGUMENTS.\n');
  put(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'oh-my-claudecode', commands: './commands/', skills: ['./skills/plan/'] }));
  put(join(root, 'package.json'), JSON.stringify({ name: 'oh-my-claude-sisyphus', version: '9.9.9' }));
  put(join(root, 'docs', 'CLAUDE.md'), readFileSync(join(process.cwd(), 'docs', 'CLAUDE.md')));
  put(asset('plugins', 'installed_plugins.json'), JSON.stringify({ 'oh-my-claudecode': [{ installPath: root }] }));
  put(asset('settings.json'), JSON.stringify({ enabledPlugins: { 'oh-my-claudecode': true }, ...extraSettings }));
}

beforeEach(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  home = realpathSync(mkdtempSync(join(tmpdir(), 'omc-preservation-home-')));
  configDir = join(home, '.claude');
  mkdirSync(configDir, { recursive: true });
  extraRoots = [];
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of [home, ...extraRoots]) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

describe('skills', () => {
  it('leaves a same-named user skill directory untouched, warns, and still installs the others', async () => {
    put(asset('skills', 'debug', 'SKILL.md'), USER_CONTENT);
    put(asset('skills', 'debug', 'references', 'notes.md'), USER_CONTENT);

    const { result, logs } = await installCapturingLogs({ force: true, noPlugin: true });

    expect(readFileSync(asset('skills', 'debug', 'SKILL.md'), 'utf-8')).toBe(USER_CONTENT);
    expect(existsSync(asset('skills', 'debug', '.omc-managed'))).toBe(false);
    expect(result.installedSkills).not.toContain('debug/SKILL.md');
    expect(logs.some(line => line.includes(asset('skills', 'debug')) && line.includes('Remove or rename'))).toBe(true);
    expect(existsSync(asset('skills', 'ralph', '.omc-managed'))).toBe(true);
  });

  it('adopts an unmarked directory whose SKILL.md is byte-identical to the shipped one', async () => {
    put(asset('skills', 'debug', 'SKILL.md'), readFileSync(join(process.cwd(), 'skills', 'debug', 'SKILL.md')));

    const { result } = await installCapturingLogs({ noPlugin: true });

    expect(result.installedSkills).toContain('debug/SKILL.md');
    expect(existsSync(asset('skills', 'debug', '.omc-managed'))).toBe(true);
  });

  it('keeps a user skill through the plugin duplicate prune after a real sync, while pruning an OMC one', async () => {
    put(asset('skills', 'debug', 'SKILL.md'), USER_CONTENT);
    put(asset('skills', 'debug', 'references', 'notes.md'), USER_CONTENT);
    await installCapturingLogs({ noPlugin: true });
    expect(existsSync(asset('skills', 'ralph', 'SKILL.md'))).toBe(true);

    const { prunePluginDuplicateSkills } = await loadInstaller();
    const pruned = prunePluginDuplicateSkills(() => {});

    expect(readFileSync(asset('skills', 'debug', 'references', 'notes.md'), 'utf-8')).toBe(USER_CONTENT);
    expect(pruned).not.toContain('debug');
    expect(pruned).toContain('ralph');
    expect(existsSync(asset('skills', 'ralph'))).toBe(false);
  });
});

describe('agents', () => {
  it('preserves a same-named user agent under force, with a warning', async () => {
    put(asset('agents', 'executor.md'), USER_CONTENT);

    const { result, logs } = await installCapturingLogs({ force: true });

    expect(readFileSync(asset('agents', 'executor.md'), 'utf-8')).toBe(USER_CONTENT);
    expect(result.installedAgents).not.toContain('executor.md');
    expect(logs.some(line => line.includes(asset('agents', 'executor.md')) && line.includes('Remove or rename'))).toBe(true);
    expect(result.installedAgents).toContain('architect.md');
  });

  it('preserves a symlink at an agent path under force without writing through it', async () => {
    const outside = join(home, 'outside.md');
    put(outside, USER_CONTENT);
    mkdirSync(asset('agents'), { recursive: true });
    symlinkSync(outside, asset('agents', 'executor.md'));

    await installCapturingLogs({ force: true });

    expect(readFileSync(outside, 'utf-8')).toBe(USER_CONTENT);
  });

  it('preserves a user edit of an agent OMC installed', async () => {
    await installCapturingLogs();
    const edited = `${readFileSync(asset('agents', 'executor.md'), 'utf-8')}\n<!-- edited by user -->\n`;
    writeFileSync(asset('agents', 'executor.md'), edited);

    await installCapturingLogs({ force: true });

    expect(readFileSync(asset('agents', 'executor.md'), 'utf-8')).toBe(edited);
  });

  it('refreshes an untouched current install on update', async () => {
    await installCapturingLogs();

    const { result } = await installCapturingLogs({ force: true });

    expect(result.installedAgents).toContain('executor.md');
    expect(readFileSync(asset('agents', 'executor.md')).equals(shippedAgent('executor.md'))).toBe(true);
  });

  it('replaces bytes a previous release recorded in the install manifest', async () => {
    const previous = 'bytes a previous OMC release wrote\n';
    put(asset('agents', 'executor.md'), previous);
    writeManifest({ 'agents/executor.md': manifestEntry(previous) });

    await installCapturingLogs({ force: true });

    expect(readFileSync(asset('agents', 'executor.md')).equals(shippedAgent('executor.md'))).toBe(true);
  });

  it('replaces a pristine v5 standalone agent known only to the historical ledger', async () => {
    const released = fixture('writer.v5.7.20.md.txt');
    expect(released.equals(shippedAgent('writer.md'))).toBe(false);
    put(asset('agents', 'writer.md'), released);

    await installCapturingLogs({ force: true });

    expect(readFileSync(asset('agents', 'writer.md')).equals(shippedAgent('writer.md'))).toBe(true);
  });

  it('fails safe to preserving when the manifest is corrupt', async () => {
    const edited = 'bytes the manifest can no longer vouch for\n';
    put(asset('agents', 'executor.md'), edited);
    put(asset('.omc-managed-assets.json'), '{not json');

    await installCapturingLogs({ force: true });

    expect(readFileSync(asset('agents', 'executor.md'), 'utf-8')).toBe(edited);
  });

  it('fails safe to preserving when the manifest is valid JSON of the wrong shape', async () => {
    const edited = 'bytes the manifest can no longer vouch for\n';
    put(asset('agents', 'executor.md'), edited);
    put(asset('.omc-managed-assets.json'), JSON.stringify([manifestEntry(edited)]));

    await installCapturingLogs({ force: true });

    expect(readFileSync(asset('agents', 'executor.md'), 'utf-8')).toBe(edited);
  });
});

describe('hook template scripts', () => {
  it('preserves a same-named user script, with a warning, and still installs the others', async () => {
    put(asset('hooks', 'session-start.mjs'), USER_CONTENT);

    const { logs } = await installCapturingLogs();

    expect(readFileSync(asset('hooks', 'session-start.mjs'), 'utf-8')).toBe(USER_CONTENT);
    expect(logs.some(line => line.includes(asset('hooks', 'session-start.mjs')) && line.includes('Remove or rename'))).toBe(true);
    expect(readFileSync(asset('hooks', 'session-end.mjs')).equals(shippedHook('session-end.mjs'))).toBe(true);
  });

  it('preserves a user edit of a script OMC installed', async () => {
    await installCapturingLogs();
    const edited = `${readFileSync(asset('hooks', 'session-start.mjs'), 'utf-8')}\n// edited by user\n`;
    writeFileSync(asset('hooks', 'session-start.mjs'), edited);

    await installCapturingLogs({ force: true });

    expect(readFileSync(asset('hooks', 'session-start.mjs'), 'utf-8')).toBe(edited);
  });

  it('replaces a pristine script from an older release known only to the historical ledger', async () => {
    const released = fixture('session-end.v5.6.0.mjs.txt');
    expect(released.equals(shippedHook('session-end.mjs'))).toBe(false);
    put(asset('hooks', 'session-end.mjs'), released);

    await installCapturingLogs();

    expect(readFileSync(asset('hooks', 'session-end.mjs')).equals(shippedHook('session-end.mjs'))).toBe(true);
  });

  it('fails safe to preserving when the manifest is corrupt', async () => {
    const edited = 'bytes the manifest can no longer vouch for\n';
    put(asset('hooks', 'session-start.mjs'), edited);
    put(asset('.omc-managed-assets.json'), '{not json');

    await installCapturingLogs();

    expect(readFileSync(asset('hooks', 'session-start.mjs'), 'utf-8')).toBe(edited);
  });
});

describe('settings hooks', () => {
  const OMC_COMMAND = 'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/persistent-mode.mjs"';
  const omcGroup = { hooks: [{ type: 'command', command: OMC_COMMAND }] };
  const promptGroup = { hooks: [{ type: 'prompt', prompt: 'check my work' }] } as unknown as { hooks: { type: string; command: string }[] };

  async function merge(existing: { hooks: { type: string; command: string }[] }[], options: Record<string, boolean>) {
    const { mergeHookGroups } = await loadInstaller();
    const logs: string[] = [];
    const result = { hookConflicts: [] } as unknown as Parameters<typeof mergeHookGroups>[5];
    const merged = mergeHookGroups('Stop', existing, [omcGroup], options, message => logs.push(message), result);
    return { merged, logs, conflicts: result.hookConflicts };
  }

  it.each([
    ['prompt', promptGroup],
    ['webhook', { hooks: [{ type: 'webhook', command: '' }] }],
    ['user script with omc in its name', { hooks: [{ type: 'command', command: 'sh /home/me/bin/my-omc-notify.sh' }] }],
    ['user script in a directory named omc', { hooks: [{ type: 'command', command: '~/projects/omc/x.sh' }] }],
  ])('keeps a %s group on update alongside the refreshed OMC hook', async (_name, group) => {
    const { merged, conflicts } = await merge([group, omcGroup], { force: true });

    expect(merged).toEqual([group, omcGroup]);
    expect(conflicts).toHaveLength(1);
  });

  it('keeps only the user entries of a mixed group, so the OMC hook does not fire twice', async () => {
    const { merged } = await merge([{ hooks: [...omcGroup.hooks, ...promptGroup.hooks] }], { force: true });

    expect(merged).toEqual([promptGroup, omcGroup]);
  });

  it('reports a prompt hook as a conflict instead of claiming OMC is configured when not forced', async () => {
    const { merged, logs, conflicts } = await merge([promptGroup], {});

    expect(merged).toEqual([promptGroup]);
    expect(logs.join('\n')).not.toMatch(/already configured/);
    expect(logs.join('\n')).toMatch(/non-OMC hook/);
    expect(conflicts[0].existingCommand).toMatch(/prompt/);
  });

  it('--force-hooks still replaces everything', async () => {
    const { merged, conflicts } = await merge([promptGroup, omcGroup], { forceHooks: true });

    expect(merged).toEqual([omcGroup]);
    expect(conflicts).toHaveLength(1);
  });

  it('recognises OMC hook commands only in the OMC config hooks dir', async () => {
    const { isOmcHook } = await loadInstaller();

    for (const command of [
      'node "$HOME/.claude/hooks/session-end.mjs"',
      'node ~/.claude/hooks/session-end.mjs',
      'node "%USERPROFILE%\\.claude\\hooks\\session-end.mjs"',
      'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/session-end.mjs"',
      'node "${CLAUDE_CONFIG_DIR}/hooks/session-end.mjs"',
      'node "$CLAUDE_CONFIG_DIR/hooks/session-end.mjs"',
      `node "${join(configDir, 'hooks', 'session-end.mjs')}"`,
    ]) {
      expect(isOmcHook(command), command).toBe(true);
    }
    for (const command of [
      'node /home/me/proj/hooks/session-end.mjs',
      'node ./hooks/session-end.mjs',
      'node "C:\\work\\proj\\hooks\\session-end.mjs"',
      'node /home/me/proj/not.claude/hooks/session-end.mjs',
    ]) {
      expect(isOmcHook(command), command).toBe(false);
    }
  });

  const COMMAND_IN_HOME_FORM = 'node "$HOME/.claude/hooks/session-end.mjs"';
  const settingsWithSessionEnd = { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: COMMAND_IN_HOME_FORM }] }] } };
  const sessionEndCommands = () => {
    const settings = JSON.parse(readFileSync(asset('settings.json'), 'utf-8')) as { hooks?: { SessionEnd?: { hooks: { command: string }[] }[] } };
    return (settings.hooks?.SessionEnd ?? []).flatMap(group => group.hooks.map(hook => hook.command));
  };

  it('keeps a plugin user\'s own hook script and its settings entry', async () => {
    enableFakePlugin(settingsWithSessionEnd);
    put(asset('hooks', 'session-end.mjs'), USER_CONTENT);

    await installCapturingLogs({ force: true });

    expect(sessionEndCommands()).toEqual([COMMAND_IN_HOME_FORM]);
    expect(readFileSync(asset('hooks', 'session-end.mjs'), 'utf-8')).toBe(USER_CONTENT);
  });

  it('strips the legacy entry when the plugin provides hooks and the script is OMC\'s', async () => {
    enableFakePlugin(settingsWithSessionEnd);
    put(asset('hooks', 'session-end.mjs'), shippedHook('session-end.mjs'));

    await installCapturingLogs({ force: true });

    expect(sessionEndCommands()).toEqual([]);
  });
});

describe('settings entries and script ownership', () => {
  const settingsHooks = () => JSON.parse(readFileSync(asset('settings.json'), 'utf-8')).hooks as Record<string, { matcher?: string; hooks: { type: string; command?: string }[] }[]>;
  const eventCommands = (event: string) => (settingsHooks()[event] ?? []).flatMap(group => group.hooks.map(hook => hook.command ?? hook.type));
  const STOP_SCRIPTS = ['persistent-mode.mjs', 'code-simplifier.mjs'];

  it('keeps settings entries that run the user\'s same-named script on update and registers no second copy', async () => {
    put(asset('hooks', 'code-simplifier.mjs'), USER_CONTENT);
    const custom = 'node "$HOME/.claude/hooks/code-simplifier.mjs" --my-flag';
    const group = { matcher: 'Edit', hooks: [{ type: 'command', command: custom }] };
    put(asset('settings.json'), JSON.stringify({ hooks: { Stop: [group] } }));

    await installCapturingLogs({ force: true });

    const stop = settingsHooks().Stop;
    expect(stop).toContainEqual(group);
    expect(stop.flatMap(g => g.hooks).filter(h => h.command?.includes('code-simplifier.mjs'))).toHaveLength(1);
    expect(eventCommands('Stop').some(c => c.includes('persistent-mode.mjs'))).toBe(true);
    expect(readFileSync(asset('hooks', 'code-simplifier.mjs'), 'utf-8')).toBe(USER_CONTENT);
  });

  it('does not register a user script that settings never referenced', async () => {
    put(asset('hooks', 'session-start.mjs'), USER_CONTENT);

    await installCapturingLogs();

    expect(eventCommands('SessionStart').filter(c => c.includes('session-start.mjs'))).toEqual([]);
    expect(eventCommands('UserPromptSubmit').some(c => c.includes('keyword-detector.mjs'))).toBe(true);
  });

  it('keeps every OMC Stop hook through plain setup after the user edits one Stop script', async () => {
    await installCapturingLogs();
    put(asset('hooks', 'persistent-mode.mjs'), `${readFileSync(asset('hooks', 'persistent-mode.mjs'), 'utf-8')}// edited\n`);

    await installCapturingLogs();

    for (const script of STOP_SCRIPTS) {
      expect(eventCommands('Stop').filter(c => c.includes(script))).toHaveLength(1);
    }
  });

  it('keeps OMC Stop hooks beside a prompt hook through update and then plain setup', async () => {
    put(asset('settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'check' }] }] } }));

    await installCapturingLogs({ force: true });
    await installCapturingLogs();

    expect(eventCommands('Stop')).toContain('prompt');
    for (const script of STOP_SCRIPTS) {
      expect(eventCommands('Stop').filter(c => c.includes(script))).toHaveLength(1);
    }
  });

  it('recognises a command spelled with the realpath of a symlinked config dir', async () => {
    const real = join(home, 'real-config');
    const link = join(home, 'link-config');
    mkdirSync(real);
    symlinkSync(real, link);
    process.env.CLAUDE_CONFIG_DIR = link;
    const { isOmcHook } = await loadInstaller();

    expect(isOmcHook(`node "${real}/hooks/session-start.mjs"`)).toBe(true);
    expect(isOmcHook(`node "${home}/other/hooks/session-start.mjs"`)).toBe(false);
  });

  it('keeps a user compound command that also runs an OMC script', async () => {
    const compound = '/usr/local/bin/notify && node ~/.claude/hooks/session-start.mjs';
    put(asset('settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: compound }] }] } }));

    await installCapturingLogs({ force: true });

    expect(eventCommands('SessionStart')).toContain(compound);
  });

  it('adds an OMC group missing from an all-OMC event on plain setup', async () => {
    put(asset('hooks', 'persistent-mode.mjs'), shippedHook('persistent-mode.mjs'));
    put(asset('settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/persistent-mode.mjs"' }] }] } }));

    await installCapturingLogs();

    for (const script of STOP_SCRIPTS) {
      expect(eventCommands('Stop').filter(c => c.includes(script))).toHaveLength(1);
    }
  });

  it('adds no standalone group to an event that holds a plugin-form OMC entry on plain setup', async () => {
    const pluginForm = 'node /plugins/cache/omc/oh-my-claudecode/9.9.9/scripts/persistent-mode.mjs';
    put(asset('settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: pluginForm }] }] } }));

    await installCapturingLogs();

    expect(eventCommands('Stop')).toEqual([pluginForm]);
  });

  it('removes an event instead of writing an empty list', async () => {
    put(asset('hooks', 'session-start.mjs'), USER_CONTENT);
    put(asset('settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [] }] } }));

    await installCapturingLogs({ force: true });

    expect(settingsHooks().SessionStart).toBeUndefined();
  });

  it('does not duplicate hooks spelled "$HOME"/.claude on update', async () => {
    put(asset('hooks', 'persistent-mode.mjs'), shippedHook('persistent-mode.mjs'));
    put(asset('settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$HOME"/.claude/hooks/persistent-mode.mjs' }] }] } }));

    await installCapturingLogs({ force: true });

    expect(eventCommands('Stop').filter(c => c.includes('persistent-mode.mjs'))).toHaveLength(1);
  });

  it('does not read a path that only ends like the config hooks dir as OMC', async () => {
    const { isOmcHook } = await loadInstaller();

    expect(isOmcHook(`node "/backup${configDir}/hooks/session-start.mjs"`)).toBe(false);
    expect(isOmcHook(`node "${configDir}/hooks/session-start.mjs"`)).toBe(true);
  });

  it('recognises the double-backslash Windows form older releases wrote', async () => {
    const { isOmcHook } = await loadInstaller();

    expect(isOmcHook('node "%USERPROFILE%\\\\.claude\\\\hooks\\\\session-start.mjs"')).toBe(true);
  });
});

describe('manifest as ownership evidence', () => {
  it('finishes the install and warns when the manifest cannot be written', async () => {
    mkdirSync(asset('.omc-managed-assets.json'));

    const { logs } = await installCapturingLogs();

    expect(logs.some(line => line.includes('Could not record installed files'))).toBe(true);
    expect(JSON.parse(readFileSync(asset('settings.json'), 'utf-8')).hooks.Stop).toBeDefined();
  });

  it('prunes a plugin-duplicate agent recorded in the manifest and keeps an unrecorded one', async () => {
    enableFakePlugin();
    const root = extraRoots.at(-1) as string;
    put(join(root, 'agents', 'executor.md'), shippedAgent('executor.md'));
    put(join(root, 'agents', 'writer.md'), shippedAgent('writer.md'));
    const recorded = 'bytes OMC wrote after the ledger froze\n';
    put(asset('agents', 'executor.md'), recorded);
    put(asset('agents', 'writer.md'), USER_CONTENT);
    writeManifest({ 'agents/executor.md': manifestEntry(recorded) });
    const { prunePluginDuplicateAgents } = await loadInstaller();

    expect(prunePluginDuplicateAgents(() => {})).toEqual(['executor.md']);
    expect(readFileSync(asset('agents', 'writer.md'), 'utf-8')).toBe(USER_CONTENT);
  });
});
