import { assertProfileName } from '../config';
import { resolveTarget } from '../context';
import { CliError, usageError } from '../errors';
import { EXIT } from '../exit-codes';
import { requireArgs, type CommandSpec } from './types';

const list: CommandSpec = {
  path: ['profile', 'list'],
  summary: 'List profiles. The active one is what commands in this terminal will use.',
  async run(ctx) {
    if (ctx.args.length) throw usageError('profile list takes no arguments.');
    const config = await ctx.rt.config.read();
    let active: string | null = null;
    try {
      active = (await resolveTarget(ctx.globals, ctx.rt)).profileName ?? null;
    } catch {
      active = null;
    }
    const profiles = Object.entries(config.profiles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, profile]) => ({
        name,
        default: name === config.defaultProfile,
        active: name === active,
        apiUrl: profile.apiUrl,
        authType: profile.authType,
        workspaceId: profile.binding?.workspaceId ?? null,
        environmentId: profile.binding?.environmentId ?? null,
        environmentSlug: profile.binding?.environmentSlug ?? null,
      }));
    if (ctx.out.json) return ctx.out.result({ defaultProfile: config.defaultProfile ?? null, active, profiles });
    ctx.out.table(profiles as unknown as Record<string, unknown>[], [
      { header: '', value: (row) => (row.active ? '*' : ' ') },
      { header: 'Name', value: (row) => `${row.name}${row.default ? ' (default)' : ''}` },
      { header: 'API', value: (row) => row.apiUrl },
      { header: 'Auth', value: (row) => row.authType },
      { header: 'Workspace', value: (row) => row.workspaceId },
      { header: 'Environment', value: (row) => row.environmentSlug ?? row.environmentId },
    ]);
  },
};

const use: CommandSpec = {
  path: ['profile', 'use'],
  summary: 'Set the default profile for new commands (ANLYON_PROFILE still wins per terminal).',
  args: [{ name: 'name', description: 'Profile name.' }],
  async run(ctx) {
    const [raw] = requireArgs(ctx, use);
    const name = assertProfileName(raw!);
    await ctx.rt.config.update((config) => {
      if (!config.profiles[name]) {
        throw new CliError('PROFILE_NOT_FOUND', `No profile named "${name}".`, EXIT.USAGE, {
          hint: `Create it with \`anlyon auth login --profile ${name}\`.`,
        });
      }
      config.defaultProfile = name;
    });
    const pinned = ctx.rt.env.ANLYON_PROFILE;
    if (ctx.out.json) return ctx.out.result({ defaultProfile: name, overriddenInThisTerminalBy: pinned ?? null });
    ctx.out.line(`Default profile is now "${name}".`);
    if (pinned && pinned !== name) ctx.out.warn(`This terminal has ANLYON_PROFILE=${pinned}, which still takes precedence here.`);
    ctx.out.info(
      ctx.rt.platform === 'win32'
        ? `To pin one terminal instead: $env:ANLYON_PROFILE = "${name}"`
        : `To pin one terminal instead: export ANLYON_PROFILE=${name}`,
    );
  },
};

export const profileCommands: CommandSpec[] = [list, use];
