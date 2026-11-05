/**
 * Tests for omc update --force-hooks protection (issue #722)
 *
 * Verifies that the hook merge logic in install() correctly:
 *   - merges OMC hooks with existing non-OMC hooks during `omc update` (force=true)
 *   - warns when non-OMC hooks are present
 *   - only fully replaces when --force-hooks is explicitly set
 *
 * Tests exercise isOmcHook() and mergeHookGroups() directly to avoid filesystem
 * side-effects.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { isOmcHook, mergeHookGroups, type HookGroup, type InstallResult } from '../installer/index.js';

function mergeEventHooks(
  existingGroups: HookGroup[],
  newOmcGroups: HookGroup[],
  options: { force?: boolean; forceHooks?: boolean; allowPluginHookRefresh?: boolean }
): {
  merged: HookGroup[];
  conflicts: Array<{ eventType: string; existingCommand: string }>;
  logMessages: string[];
} {
  const logMessages: string[] = [];
  const result = { hookConflicts: [] } as unknown as InstallResult;
  const merged = mergeHookGroups('TestEvent', existingGroups, newOmcGroups, options, msg => logMessages.push(msg), result);
  return { merged, conflicts: result.hookConflicts, logMessages };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------
function omcGroup(command: string): HookGroup {
  return { hooks: [{ type: 'command', command }] };
}

function userGroup(command: string): HookGroup {
  return { hooks: [{ type: 'command', command }] };
}

const OMC_CMD = 'node "$HOME/.claude/hooks/keyword-detector.mjs"';
const USER_CMD = '/usr/local/bin/my-custom-hook.sh';
const NEW_OMC_CMD = 'node "$HOME/.claude/hooks/session-start.mjs"';

// ---------------------------------------------------------------------------
// isOmcHook unit tests
// ---------------------------------------------------------------------------
describe('isOmcHook()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('recognises OMC keyword-detector command', () => {
    expect(isOmcHook('node "$HOME/.claude/hooks/keyword-detector.mjs"')).toBe(true);
  });

  it('recognises OMC session-start command', () => {
    expect(isOmcHook('node "$HOME/.claude/hooks/session-start.mjs"')).toBe(true);
  });

  it('recognises OMC pre-tool-use command', () => {
    expect(isOmcHook('node "$HOME/.claude/hooks/pre-tool-use.mjs"')).toBe(true);
  });

  it('recognises OMC post-tool-use command', () => {
    expect(isOmcHook('node "$HOME/.claude/hooks/post-tool-use.mjs"')).toBe(true);
  });

  it('recognises OMC persistent-mode command', () => {
    expect(isOmcHook('node "$HOME/.claude/hooks/persistent-mode.mjs"')).toBe(true);
  });

  it('recognises OMC code-simplifier command', () => {
    expect(isOmcHook('node "$HOME/.claude/hooks/code-simplifier.mjs"')).toBe(true);
  });

  it('recognises Windows-style OMC path', () => {
    expect(isOmcHook('node "%USERPROFILE%\\.claude\\hooks\\keyword-detector.mjs"')).toBe(true);
  });

  it('recognises custom-profile hook paths by known filename', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/tmp/custom-claude');
    expect(isOmcHook('node "/tmp/custom-claude/hooks/keyword-detector.mjs"')).toBe(true);
  });

  it('does not recognise a known filename in a hooks dir outside the active profile', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/tmp/custom-claude');
    expect(isOmcHook('node "/tmp/other-project/hooks/keyword-detector.mjs"')).toBe(false);
  });

  it('recognises CLAUDE_CONFIG_DIR-aware hook commands', () => {
    expect(isOmcHook('node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/keyword-detector.mjs"')).toBe(true);
    expect(isOmcHook('node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/persistent-mode.mjs"')).toBe(true);
  });

  it('recognises oh-my-claudecode in command path', () => {
    expect(isOmcHook('/path/to/oh-my-claudecode/hook.mjs')).toBe(true);
  });

  it.each([
    'sh /home/me/bin/omc-notify.sh',
    'node "$HOME/.claude/hooks/omc-hook.mjs"',
    '/usr/local/bin/omc-hook.sh',
    'sh /home/me/bin/my-omc-notify.sh',
    'sh /home/me/projects/omc/run.sh',
    'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/session-end.mjs',
    'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/omc-lint.mjs',
    'node /home/me/proj/.claude/hooks/session-end.mjs',
    'node .claude/hooks/session-end.mjs',
    'node /home/me/proj/hooks/session-end.mjs',
    'sh deploy.sh /tmp/omc-output',
    '/usr/local/bin/notify && node ~/.claude/hooks/session-start.mjs',
    'node ~/.claude/hooks/session-start.mjs; /usr/local/bin/notify',
  ])('treats %s as the user\'s', (command) => {
    expect(isOmcHook(command)).toBe(false);
  });

  it('does not recognise a plain user command', () => {
    expect(isOmcHook('/usr/local/bin/my-custom-hook.sh')).toBe(false);
  });

  it('does not recognise a random shell script', () => {
    expect(isOmcHook('bash /home/user/scripts/notify.sh')).toBe(false);
  });

  it('does not match "omc" inside an unrelated word', () => {
    // "nomc" or "omcr" should NOT match the omc path-segment pattern
    expect(isOmcHook('/usr/bin/nomc-thing')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hook merge logic tests
// ---------------------------------------------------------------------------
describe('Hook merge during omc update', () => {
  describe('no force flags — skip behaviour', () => {
    it('skips an already-configured OMC-only event type', () => {
      const existing = [omcGroup(NEW_OMC_CMD)];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { merged, conflicts, logMessages } = mergeEventHooks(existing, newOmc, {});

      expect(merged).toEqual(existing); // unchanged
      expect(conflicts).toHaveLength(0);
      expect(logMessages[0]).toMatch(/already configured/);
    });

    it('records conflict but does not overwrite when non-OMC hook exists', () => {
      const existing = [userGroup(USER_CMD)];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { merged, conflicts, logMessages } = mergeEventHooks(existing, newOmc, {});

      expect(merged).toEqual(existing); // unchanged
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].existingCommand).toBe(USER_CMD);
      expect(logMessages[0]).toMatch(/non-OMC hook/);
      expect(logMessages[0]).toMatch(/--force-hooks/);
    });
  });

  describe('force=true — merge behaviour (omc update path)', () => {
    it('replaces OMC hooks when event type has only OMC hooks', () => {
      const existing = [omcGroup(OMC_CMD)];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { merged, conflicts } = mergeEventHooks(existing, newOmc, { force: true });

      // Non-OMC groups: none → merged = newOmc only
      expect(merged).toHaveLength(1);
      expect(merged[0].hooks[0].command).toBe(NEW_OMC_CMD);
      expect(conflicts).toHaveLength(0);
    });

    it('preserves non-OMC hook and adds updated OMC hook', () => {
      const existing = [userGroup(USER_CMD), omcGroup(OMC_CMD)];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { merged, conflicts, logMessages } = mergeEventHooks(existing, newOmc, { force: true });

      // non-OMC groups come first, then new OMC groups
      expect(merged).toHaveLength(2);
      expect(merged[0].hooks[0].command).toBe(USER_CMD);
      expect(merged[1].hooks[0].command).toBe(NEW_OMC_CMD);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].existingCommand).toBe(USER_CMD);
      expect(logMessages[0]).toMatch(/Merged/);
      expect(logMessages[0]).toMatch(/preserved non-OMC hook/);
    });

    it('preserves multiple non-OMC hook groups', () => {
      const userCmd2 = '/usr/local/bin/another-hook.sh';
      const existing = [userGroup(USER_CMD), userGroup(userCmd2), omcGroup(OMC_CMD)];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { merged } = mergeEventHooks(existing, newOmc, { force: true });

      expect(merged).toHaveLength(3); // 2 user groups + 1 new OMC group
      expect(merged[0].hooks[0].command).toBe(USER_CMD);
      expect(merged[1].hooks[0].command).toBe(userCmd2);
      expect(merged[2].hooks[0].command).toBe(NEW_OMC_CMD);
    });

    it('does not carry over old OMC hook groups', () => {
      const existing = [omcGroup(OMC_CMD)];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { merged } = mergeEventHooks(existing, newOmc, { force: true });

      const commands = merged.flatMap(g => g.hooks.map(h => h.command));
      expect(commands).not.toContain(OMC_CMD);
      expect(commands).toContain(NEW_OMC_CMD);
    });

    it('records a conflict when non-OMC hook is preserved', () => {
      const existing = [userGroup(USER_CMD)];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { conflicts } = mergeEventHooks(existing, newOmc, { force: true });

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].existingCommand).toBe(USER_CMD);
    });

    it('records no conflict when only OMC hooks existed', () => {
      const existing = [omcGroup(OMC_CMD)];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { conflicts } = mergeEventHooks(existing, newOmc, { force: true });

      expect(conflicts).toHaveLength(0);
    });
  });

  describe('forceHooks=true — replace-all behaviour', () => {
    it('replaces OMC-only hooks', () => {
      const existing = [omcGroup(OMC_CMD)];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { merged, conflicts } = mergeEventHooks(existing, newOmc, { forceHooks: true });

      expect(merged).toEqual(newOmc);
      expect(conflicts).toHaveLength(0);
    });

    it('replaces non-OMC hook and warns', () => {
      const existing = [userGroup(USER_CMD)];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { merged, conflicts, logMessages } = mergeEventHooks(existing, newOmc, { forceHooks: true });

      expect(merged).toEqual(newOmc);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].existingCommand).toBe(USER_CMD);
      expect(logMessages[0]).toMatch(/Overwriting non-OMC/);
      expect(logMessages[0]).toMatch(/--force-hooks/);
    });

    it('replaces mixed hooks entirely', () => {
      const existing = [userGroup(USER_CMD), omcGroup(OMC_CMD)];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { merged } = mergeEventHooks(existing, newOmc, { forceHooks: true });

      expect(merged).toHaveLength(1);
      expect(merged[0].hooks[0].command).toBe(NEW_OMC_CMD);
    });

    it('does NOT replace when allowPluginHookRefresh is true (plugin safety)', () => {
      // When running as a plugin with refreshHooksInPlugin, forceHooks should
      // not clobber user hooks — falls through to the force=true merge path
      // (since allowPluginHookRefresh=true disables the forceHooks branch).
      // This test exercises the guard: forceHooks && !allowPluginHookRefresh.
      const existing = [userGroup(USER_CMD), omcGroup(OMC_CMD)];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { merged } = mergeEventHooks(existing, newOmc, {
        forceHooks: true,
        allowPluginHookRefresh: true,
        // Note: force is not set, so falls to "no force" branch
      });

      // Without force set, the no-force branch runs → merged unchanged
      expect(merged).toEqual(existing);
    });
  });

  describe('edge cases', () => {
    it('handles event type with no existing hooks (empty array)', () => {
      // When existingHooks[eventType] exists but is empty
      const existing: HookGroup[] = [];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { merged, conflicts } = mergeEventHooks(existing, newOmc, { force: true });

      // nonOmcGroups will be empty, so merged = [] + newOmcGroups
      expect(merged).toEqual(newOmc);
      expect(conflicts).toHaveLength(0);
    });

    it('preserves a hook group with a non-command type', () => {
      const webhook: HookGroup = { hooks: [{ type: 'webhook', command: '' }] };
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { merged, conflicts } = mergeEventHooks([webhook], newOmc, { force: true });

      expect(merged).toEqual([webhook, ...newOmc]);
      expect(conflicts).toEqual([{ eventType: 'TestEvent', existingCommand: 'webhook hook' }]);
    });

    it('installs hooks when none exist yet and no force flag is set', () => {
      const existing: HookGroup[] = [];
      const newOmc = [omcGroup(NEW_OMC_CMD)];
      const { merged, conflicts, logMessages } = mergeEventHooks(existing, newOmc, {});
      expect(merged).toEqual(newOmc);
      expect(conflicts).toHaveLength(0);
      expect(logMessages[0]).not.toMatch(/already configured/);
    });
  });
});
