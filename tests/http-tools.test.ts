// Ratcliff fork: the hosted entry's tool set has no calendar tools.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@chrischall/mcp-utils/test';
import { BLOCKED_TOOLS, HTTP_TOOL_REGISTRARS, withoutTools } from '../src/http-tools.js';
import { makeClient } from './tools/_setup.js';

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function listServed(): Promise<string[]> {
  const made = makeClient();
  const getClient = async () => made.client;
  h = await createTestHarness(async (server) => {
    for (const register of HTTP_TOOL_REGISTRARS) await register(server, getClient);
  });
  const { tools } = await h.client.listTools();
  return tools.map((t) => t.name);
}

describe('HTTP_TOOL_REGISTRARS', () => {
  it('serves no blocked tool', async () => {
    const served = await listServed();
    expect(served.filter((n) => BLOCKED_TOOLS.has(n))).toEqual([]);
  });

  it('serves nothing that touches events or calendars', async () => {
    const served = await listServed();
    expect(served.filter((n) => /event|calendar|webcal|nudge|activity_ideas/.test(n))).toEqual([]);
  });

  it('keeps the family-member list and the chore, reward, list and meal tools', async () => {
    const served = await listServed();
    for (const name of [
      'skylight_list_categories',
      'skylight_resolve_member',
      'skylight_list_chores',
      'skylight_create_chore',
      'skylight_create_reward',
      'skylight_add_list_item',
      'skylight_plan_meal',
      'skylight_generate_meal_plan',
      'skylight_upload_photo',
      'skylight_healthcheck',
    ]) {
      expect(served).toContain(name);
    }
  });

  it('blocks names that all exist upstream (a rename upstream fails here)', async () => {
    const made = makeClient();
    const getClient = async () => made.client;
    const all: string[] = [];
    h = await createTestHarness(async (server) => {
      for (const register of HTTP_TOOL_REGISTRARS) {
        // A spy proxy outside the wrapper sees every name before it is removed.
        await register(
          new Proxy(server, {
            get(t, p, r) {
              if (p === 'registerTool') {
                return (name: string, ...rest: unknown[]) => {
                  all.push(name);
                  return (t.registerTool as (...a: unknown[]) => unknown)(name, ...rest);
                };
              }
              const v = Reflect.get(t, p, r);
              return typeof v === 'function' ? v.bind(t) : v;
            },
          }),
          getClient,
        );
      }
    });
    for (const name of BLOCKED_TOOLS) expect(all).toContain(name);
  });
});

describe('withoutTools', () => {
  it('removes only the named tools and passes other server members through', async () => {
    const seen: { hasConnect: boolean; flag: unknown } = { hasConnect: false, flag: undefined };
    h = await createTestHarness(async (server) => {
      (server as unknown as { fakeFlag: string }).fakeFlag = 'kept';
      const wrapped = withoutTools<undefined>(
        (s) => {
          seen.hasConnect = typeof s.connect === 'function';
          seen.flag = (s as unknown as { fakeFlag: string }).fakeFlag;
          s.registerTool('keep_me', { description: 'x' }, async () => ({ content: [] }));
          s.registerTool('drop_me', { description: 'y' }, async () => ({ content: [] }));
        },
        new Set(['drop_me']),
      );
      await wrapped(server, undefined);
    });
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['keep_me']);
    expect(seen).toEqual({ hasConnect: true, flag: 'kept' });
  });
});
