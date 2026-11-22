import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('./', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const agent = read('plugin.json');
const codex = read('.codex-plugin/plugin.json');
const listing = agent.extensions['com.openai'].interface;

function pngSize(path: string) {
  const header = readFileSync(join(root, path)).subarray(0, 24);
  expect(header.subarray(1, 4).toString()).toBe('PNG');
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

describe('plugin package', () => {
  it('describes one listing in both manifest formats', () => {
    expect(codex.interface).toEqual(listing);
    expect(codex.name).toBe(agent.name);
    expect(codex.version).toBe(agent.version);
  });

  it('keeps every listing field within its limit', () => {
    expect(agent.name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(listing.displayName.length).toBeLessThanOrEqual(30);
    expect(listing.shortDescription.length).toBeLessThanOrEqual(30);
    expect(listing.longDescription.length).toBeLessThanOrEqual(4000);
    expect(listing.developerName.length).toBeLessThanOrEqual(80);
    expect(listing.capabilities.length).toBeLessThanOrEqual(20);
    for (const capability of listing.capabilities) expect(capability.length).toBeLessThanOrEqual(120);
    expect(listing.defaultPrompt.length).toBeGreaterThanOrEqual(1);
    expect(listing.defaultPrompt.length).toBeLessThanOrEqual(3);
    for (const prompt of listing.defaultPrompt) expect(prompt.length).toBeLessThanOrEqual(128);
    for (const url of [listing.websiteURL, listing.supportURL, listing.privacyPolicyURL, listing.termsOfServiceURL]) {
      expect(url).toMatch(/^https:\/\//);
    }
    expect(listing.brandColor).toMatch(/^#[0-9A-F]{6}$/i);
    expect(listing.commerce).toBe(false);
  });

  it('carries the published limitation with the approved opening', () => {
    expect(listing.longDescription.startsWith('Anlyon executes named production actions')).toBe(true);
    expect(listing.longDescription).toContain('A tool your own code calls directly is not routed through Anlyon and is not governed by it.');
    for (const banned of [/ChatGPT-verified/i, /AI-approved/i, /replaces OpenAI/i, /every OpenAI feature/i]) {
      expect(listing.longDescription).not.toMatch(banned);
    }
  });

  it('names no other assistant, model or platform, and makes no pricing claim (OpenAI listing rules)', () => {
    const skill = readFileSync(join(root, 'skills/connect-anlyon/SKILL.md'), 'utf8');
    const text = [JSON.stringify(listing), agent.description, skill].join('\n');
    for (const banned of [/ChatGPT/, /Claude/, /Cursor/, /Codex/, /OpenAI/, /Anthropic/, /\bGPT\b/, /Gemini/, /Copilot/]) {
      expect(text).not.toMatch(banned);
    }
    for (const banned of [/\bfree\b/i, /pricing/i, /subscription/i, /discount/i, /trial/i, /\$\d/]) {
      expect(text).not.toMatch(banned);
    }
  });

  it('points both MCP configurations at the hosted endpoint', () => {
    expect(read('mcp.json').mcpServers.anlyon).toEqual({ type: 'streamable-http', url: 'https://api.anlyon.com/mcp' });
    expect(read('.mcp.json').mcpServers.anlyon).toEqual({ url: 'https://api.anlyon.com/mcp' });
  });

  it('ships square assets of at least 48px under 5 MiB for every icon it names', () => {
    for (const key of ['logo', 'logoDark', 'composerIcon', 'composerIconDark']) {
      const path = listing[key] as string;
      expect(existsSync(join(root, path)), key).toBe(true);
      const { width, height } = pngSize(path);
      expect(width, key).toBe(height);
      expect(width, key).toBeGreaterThanOrEqual(48);
      expect(width, key).toBeLessThanOrEqual(4096);
      expect(statSync(join(root, path)).size, key).toBeLessThan(5 * 1024 * 1024);
    }
  });

  it('holds no credentials', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    for (const file of files(root).filter((path) => !path.endsWith('.png') && !path.endsWith('.test.ts'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/anlyon_(live|test)_[A-Za-z0-9]|whsec_[A-Za-z0-9+/]{20}|sk_(live|test)_/);
    }
  });

  it('offers the first-run prompts from the brief', () => {
    expect(listing.defaultPrompt).toEqual([
      'What actions can my Anlyon workspace run?',
      'Get approval before this step',
      'Show my pending approvals',
    ]);
  });

  it('includes the onboarding skill with the action and approval flows and the restricted-data rule', () => {
    const skill = readFileSync(join(root, 'skills/connect-anlyon/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: connect-anlyon\ndescription: /);
    expect(skill).toContain('## Flow 1: "What can my workspace do?"');
    expect(skill).toContain('## Flow 2: Run an action');
    expect(skill).toContain('## Flow 3: "Get approval before this step"');
    for (const tool of ['list_actions', 'invoke_action', 'request_approval', 'wait_for_approval', 'decide_approval']) {
      expect(skill, tool).toContain(`\`${tool}\``);
    }
    for (const kind of [/credentials/, /payment card/, /health information/, /government ID/]) expect(skill).toMatch(kind);
  });

  it('leads only to default tools: the legacy ones are hidden, so naming one sends the model to a failing call', async () => {
    const { DEFAULT_TOOLS, LEGACY_TOOL_NAMES } = await import('../src/server.ts');
    const served = new Set(DEFAULT_TOOLS.map((tool) => tool.name));
    const skill = readFileSync(join(root, 'skills/connect-anlyon/SKILL.md'), 'utf8');
    for (const [, name] of skill.matchAll(/`([a-z_]+)`/g)) expect(LEGACY_TOOL_NAMES.has(name), name).toBe(false);
    for (const tool of ['list_actions', 'invoke_action', 'request_approval', 'wait_for_approval']) {
      expect(served.has(tool), tool).toBe(true);
    }
    const text = [skill, JSON.stringify(listing), agent.description, ...agent.keywords].join('\n');
    for (const banned of [/\bmemor(y|ies)\b/i, /\bsessions?\b/i, /semantic cache/i, /\bqueues?\b/i, /\bworkflows?\b/i]) {
      expect(text).not.toMatch(banned);
    }
  });
});

describe('review test cases', () => {
  const cases = JSON.parse(readFileSync(join(root, 'review/test-cases.json'), 'utf8'));

  it('has five positive and three negative cases', () => {
    expect(cases.positive).toHaveLength(5);
    expect(cases.negative).toHaveLength(3);
  });

  it('names only tools the server serves by default', async () => {
    const { DEFAULT_TOOLS } = await import('../src/server.ts');
    const served = new Set(DEFAULT_TOOLS.map((tool) => tool.name));
    for (const { tools_triggered: tools } of cases.positive) {
      for (const tool of tools as string[]) expect(served.has(tool) || tool.startsWith('action_'), tool).toBe(true);
    }
  });

  it('shows no money movement anywhere in the showcase', () => {
    const text = JSON.stringify(cases) + JSON.stringify(listing);
    for (const word of [/refund/i, /transfer funds to/i, /payout/i, /stripe\./i]) expect(text).not.toMatch(word);
  });
});
