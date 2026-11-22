import { authCommands } from './auth';
import { doctor } from './doctor';
import { profileCommands } from './profile';
import { resourceCommands } from './resources';
import { writeCommands } from './actions-write';
import { connectionCommands } from './connections';
import { integrationCommands } from './integrations';
import { packCommands } from './packs';
import { selfHostCommands } from './self-host';
import { initCommands } from './init';
import { configCommands } from './config';
import { billingCommands } from './billing';
import { signOffCommands } from './sign-offs';
import { mcpCommands } from './mcp';
import { setupCommands } from './setup';
import type { CommandSpec } from './types';
import { whoami } from './whoami';

export const COMMANDS: CommandSpec[] = [...initCommands, ...configCommands, ...authCommands, ...profileCommands, whoami, doctor, ...resourceCommands, ...writeCommands, ...connectionCommands, ...integrationCommands, ...packCommands, ...mcpCommands, ...setupCommands, ...signOffCommands, ...billingCommands, ...selfHostCommands];

export const GROUP_SUMMARIES: Record<string, string> = {
  auth: 'Log in, inspect and log out',
  profile: 'Named targets (API, credential, workspace binding)',
  actions: 'Configured actions',
  invocations: 'Action invocations',
  runs: 'Runs and their traces',
  approvals: 'Approval requests',
  policies: 'Approval policies',
  effects: 'Governed effects and their receipt grades',
  'impact-limits': 'Impact limits, in money or any declared unit',
  connections: 'Connected accounts: secrets whose token is fetched at dispatch',
  integrations: 'Find the best way for your agent to act in an app',
  packs: 'Install a governed workflow from a pack manifest',
  billing: 'Your plan, usage, and the checkout link for an upgrade',
  mcp: 'Remote MCP servers behind Anlyon: register one, list its tools, ask to adopt them',
  setup: 'Put a coding agent behind Anlyon: writes its MCP config, with no secret in it',
  'sign-offs': "Changes that loosen a guardrail and wait for a human's sign-off",
  'self-host': 'Install Anlyon on your own server',
};
