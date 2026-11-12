// Ratcliff fork: the hosted HTTP entry (src/http.ts). All local, no outside network.
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  BLOCKED_TOOLS,
} from '../src/http-tools.js';
import {
  createApp,
  createTokenVerifier,
  loadHttpConfig,
  startHttpServer,
  toNodeListener,
  type RunningServer,
  type TokenCheck,
} from '../src/http.js';

const SECRET = 's'.repeat(40);
const BASE_ENV = {
  PUBLIC_BASE_URL: 'https://skylight.example.com',
  AUTH_SERVER_URL: 'https://health.example.com',
  AUTH_INTROSPECTION_SECRET: SECRET,
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return (server.address() as { port: number }).port;
}

describe('loadHttpConfig', () => {
  it('reads a valid config and defaults the port to 8080', () => {
    expect(loadHttpConfig({ ...BASE_ENV, PUBLIC_BASE_URL: ' https://skylight.example.com/ ' })).toEqual({
      publicBaseUrl: 'https://skylight.example.com',
      authServerUrl: 'https://health.example.com',
      introspectionSecret: SECRET,
      port: 8080,
    });
  });

  it('accepts http for localhost and an explicit port', () => {
    const c = loadHttpConfig({ ...BASE_ENV, PUBLIC_BASE_URL: 'http://localhost:3000', AUTH_SERVER_URL: 'http://127.0.0.1:9', PORT: '0' });
    expect(c).toMatchObject({ publicBaseUrl: 'http://localhost:3000', authServerUrl: 'http://127.0.0.1:9', port: 0 });
  });

  it.each([
    [{ AUTH_INTROSPECTION_SECRET: undefined }, 'AUTH_INTROSPECTION_SECRET must be at least 32'],
    [{ AUTH_INTROSPECTION_SECRET: 'short' }, 'AUTH_INTROSPECTION_SECRET must be at least 32'],
    [{ PUBLIC_BASE_URL: undefined }, 'PUBLIC_BASE_URL is required'],
    [{ PUBLIC_BASE_URL: '  ' }, 'PUBLIC_BASE_URL is required'],
    [{ PUBLIC_BASE_URL: 'not a url' }, 'PUBLIC_BASE_URL must be a URL'],
    [{ AUTH_SERVER_URL: 'http://health.example.com' }, 'AUTH_SERVER_URL must use https'],
    [{ AUTH_SERVER_URL: 'ftp://localhost' }, 'AUTH_SERVER_URL must use https'],
    [{ PUBLIC_BASE_URL: 'https://skylight.example.com/mcp' }, 'bare origin'],
    [{ PUBLIC_BASE_URL: 'https://skylight.example.com/?a=1' }, 'bare origin'],
    [{ PUBLIC_BASE_URL: 'https://skylight.example.com/#x' }, 'bare origin'],
    [{ PUBLIC_BASE_URL: 'https://u@skylight.example.com' }, 'bare origin'],
    [{ PUBLIC_BASE_URL: 'https://:p@skylight.example.com' }, 'bare origin'],
    [{ PORT: 'abc' }, 'PORT must be a port number'],
    [{ PORT: '-1' }, 'PORT must be a port number'],
    [{ PORT: '70000' }, 'PORT must be a port number'],
  ])('refuses %o', (patch, message) => {
    expect(() => loadHttpConfig({ ...BASE_ENV, ...patch })).toThrow(message);
  });

  it('reads process.env by default', () => {
    vi.stubEnv('PUBLIC_BASE_URL', BASE_ENV.PUBLIC_BASE_URL);
    vi.stubEnv('AUTH_SERVER_URL', BASE_ENV.AUTH_SERVER_URL);
    vi.stubEnv('AUTH_INTROSPECTION_SECRET', SECRET);
    vi.stubEnv('PORT', '');
    expect(loadHttpConfig().port).toBe(8080);
  });
});

describe('createTokenVerifier', () => {
  const reply = (status: number, body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  it('asks the health server with the secret and caches a confirmed token by hash', async () => {
    let t = 1_000;
    const fetchFn = vi.fn(async () => reply(200, { active: true, user_id: 'u1' }));
    const verify = createTokenVerifier({ authServerUrl: 'https://h.example', secret: SECRET, fetchFn, now: () => t, ttlMs: 100 });
    expect(await verify('tok')).toEqual({ status: 'valid', userId: 'u1' });
    expect(await verify('tok')).toEqual({ status: 'valid', userId: 'u1' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://h.example/api/v1/introspect');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(init.body as string)).toEqual({ token: 'tok' });
    t += 101; // expired: asks again
    expect(await verify('tok')).toEqual({ status: 'valid', userId: 'u1' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('never caches a refused token', async () => {
    const fetchFn = vi.fn(async () => reply(200, { active: false }));
    const verify = createTokenVerifier({ authServerUrl: 'https://h.example', secret: SECRET, fetchFn });
    expect(await verify('bad')).toEqual({ status: 'invalid' });
    expect(await verify('bad')).toEqual({ status: 'invalid' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a non-200', async () => reply(401, { error: 'x' })],
    ['a non-JSON body', async () => reply(200, 'nope')],
    ['a null body', async () => reply(200, 'null')],
    ['active without a user id', async () => reply(200, { active: true })],
    ['active with an empty user id', async () => reply(200, { active: true, user_id: '' })],
    ['a network failure', async () => { throw new Error('ECONNREFUSED'); }],
  ])('treats %s as unavailable, not as a sign-out', async (_label, impl) => {
    const verify = createTokenVerifier({ authServerUrl: 'https://h.example', secret: SECRET, fetchFn: vi.fn(impl) as never });
    expect(await verify('tok')).toEqual({ status: 'unavailable' });
  });

  it('evicts the oldest entry past maxEntries', async () => {
    const fetchFn = vi.fn(async () => reply(200, { active: true, user_id: 'u' }));
    const verify = createTokenVerifier({ authServerUrl: 'https://h.example', secret: SECRET, fetchFn, maxEntries: 1 });
    await verify('a');
    await verify('b'); // evicts a
    await verify('a');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('defaults to the global fetch and clock', async () => {
    const g = vi.fn(async () => reply(200, { active: true, user_id: 'u' }));
    vi.stubGlobal('fetch', g);
    const verify = createTokenVerifier({ authServerUrl: 'https://h.example', secret: SECRET });
    expect(await verify('tok')).toEqual({ status: 'valid', userId: 'u' });
    expect(g).toHaveBeenCalledTimes(1);
  });
});

describe('createApp', () => {
  const config = { publicBaseUrl: 'https://sky.example', authServerUrl: 'https://health.example' };
  const prm = 'https://sky.example/.well-known/oauth-protected-resource/mcp';

  function build(check: TokenCheck) {
    const mcp = { fetch: vi.fn(async () => new Response('{"ok":true}', { status: 200 })) };
    const log = vi.fn();
    const verifyToken = vi.fn(async () => check);
    return { app: createApp({ config, verifyToken, mcp, log }), mcp, log, verifyToken };
  }
  const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

  it('answers the health check', async () => {
    const res = await build({ status: 'invalid' }).app(req('/healthz'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it.each(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'])(
    'publishes protected-resource metadata naming the health server at %s',
    async (path) => {
      const res = await build({ status: 'invalid' }).app(req(path));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resource: 'https://sky.example/mcp',
        authorization_servers: ['https://health.example'],
        bearer_methods_supported: ['header'],
        resource_name: 'Ratcliff Skylight',
      });
    },
  );

  it('refuses a non-GET on the metadata path', async () => {
    const res = await build({ status: 'invalid' }).app(req('/.well-known/oauth-protected-resource', { method: 'POST' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('404s anything else', async () => {
    expect((await build({ status: 'invalid' }).app(req('/nope'))).status).toBe(404);
  });

  it.each([undefined, 'Basic abc', 'Bearer', 'Bearer a b'])('challenges a request with authorization %s', async (auth) => {
    const { app, verifyToken, log } = build({ status: 'valid', userId: 'u' });
    const res = await app(req('/mcp', { method: 'POST', headers: auth ? { authorization: auth } : {} }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${prm}"`);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[http] mcp result=unauthorized status=401');
  });

  it('answers invalid_token for a token the health server refuses', async () => {
    const { app, mcp } = build({ status: 'invalid' });
    const res = await app(req('/mcp', { method: 'POST', headers: { authorization: 'Bearer t' } }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${prm}", error="invalid_token"`);
    expect(mcp.fetch).not.toHaveBeenCalled();
  });

  it('answers 503 when the health server cannot be asked', async () => {
    const { app, mcp } = build({ status: 'unavailable' });
    const res = await app(req('/mcp', { method: 'POST', headers: { authorization: 'Bearer t' } }));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(mcp.fetch).not.toHaveBeenCalled();
  });

  it('passes a confirmed request to the MCP handler with the user in authInfo', async () => {
    const { app, mcp, log } = build({ status: 'valid', userId: 'u1' });
    const res = await app(req('/mcp', { method: 'POST', headers: { authorization: 'bearer t1' } }));
    expect(res.status).toBe(200);
    const [, opts] = mcp.fetch.mock.calls[0] as unknown as [Request, { authInfo: Record<string, unknown> }];
    expect(opts.authInfo).toMatchObject({ token: 't1', clientId: 'ratcliff-health', scopes: [], extra: { userId: 'u1' } });
    expect(String(opts.authInfo.resource)).toBe('https://sky.example/mcp');
    expect(log).toHaveBeenCalledWith('[http] mcp result=ok status=200');
  });

  it('logs to stderr by default, never the token or user', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp({ config, verifyToken: async () => ({ status: 'invalid' }), mcp: { fetch: vi.fn() } });
    await app(req('/mcp', { method: 'POST', headers: { authorization: 'Bearer secret-token' } }));
    expect(spy).toHaveBeenCalledWith('[http] mcp result=invalid_token status=401');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-token');
  });
});

describe('toNodeListener', () => {
  async function serve(handler: (r: Request) => Promise<Response>) {
    return listen(createServer(toNodeListener(handler)));
  }
  function call(port: number, opts: { method?: string; path?: string; headers?: Record<string, string | string[]>; body?: string }) {
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: opts.headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        res.on('error', reject);
      });
      r.on('error', reject);
      r.end(opts.body);
    });
  }

  it('passes method, path, repeated headers and body through, and streams the reply', async () => {
    let seen: { method: string; path: string; cookie: string | null; body: string } | undefined;
    const port = await serve(async (r) => {
      seen = { method: r.method, path: new URL(r.url).pathname + new URL(r.url).search, cookie: r.headers.get('x-multi'), body: await r.text() };
      return new Response('hello', { status: 201, headers: { 'x-out': '1' } });
    });
    const res = await call(port, { method: 'POST', path: '/mcp?a=1', headers: { 'x-multi': ['a', 'b'] }, body: 'payload' });
    expect(seen).toEqual({ method: 'POST', path: '/mcp?a=1', cookie: 'a, b', body: 'payload' });
    expect(res).toMatchObject({ status: 201, body: 'hello' });
    expect(res.headers['x-out']).toBe('1');
  });

  it('sends a GET with no body and handles an empty reply', async () => {
    let hadBody: boolean | undefined;
    const port = await serve(async (r) => {
      hadBody = r.body !== null;
      return new Response(null, { status: 204 });
    });
    const res = await call(port, {});
    expect(hadBody).toBe(false);
    expect(res.status).toBe(204);
  });

  it('answers 500 when the handler throws', async () => {
    const port = await serve(async () => {
      throw new Error('boom');
    });
    const res = await call(port, {});
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'server_error' });
  });

  it('answers 500 when the reply has an unsendable header', async () => {
    const port = await serve(async () => ({ status: 200, headers: new Headers([['x-ok', '1']]), body: null }) as unknown as Response);
    const bad = await serve(async () => {
      const h = { forEach: (fn: (v: string, k: string) => void) => fn('bad\nvalue', 'x-bad') };
      return { status: 200, headers: h, body: null } as unknown as Response;
    });
    expect((await call(port, {})).status).toBe(200);
    expect((await call(bad, {})).status).toBe(500);
  });

  it('destroys the socket when the reply stream errors', async () => {
    const port = await serve(async () =>
      new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x')); c.error(new Error('mid-stream')); } })),
    );
    await expect(call(port, {})).rejects.toThrow();
  });

  it('aborts the request signal when the client hangs up mid-stream', async () => {
    let signal: AbortSignal | undefined;
    const port = await serve(async (r) => {
      signal = r.signal;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: hi\n\n')); } }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    await new Promise<void>((resolve) => {
      const r = httpRequest({ host: '127.0.0.1', port, path: '/' }, (res) => res.once('data', () => { r.destroy(); resolve(); }));
      r.on('error', () => {});
      r.end();
    });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });
});

describe('startHttpServer (end to end, fake health server)', () => {
  async function fakeHealth(valid: Record<string, string>) {
    const calls: { auth?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.push({ auth: req.headers.authorization });
        if (req.url !== '/api/v1/introspect' || req.headers.authorization !== `Bearer ${SECRET}`) {
          res.writeHead(401).end();
          return;
        }
        const { token } = JSON.parse(body) as { token: string };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(valid[token] ? { active: true, user_id: valid[token] } : { active: false }));
      });
    });
    const port = await listen(server);
    return { url: `http://127.0.0.1:${port}`, calls };
  }

  async function start(authUrl: string, log = vi.fn()): Promise<{ running: RunningServer; log: typeof log; base: string }> {
    vi.stubEnv('SKYLIGHT_TOKEN_CACHE', 'false');
    const running = await startHttpServer({ ...BASE_ENV, PUBLIC_BASE_URL: 'http://localhost:1', AUTH_SERVER_URL: authUrl, PORT: '0' }, { log });
    cleanups.push(() => running.close());
    return { running, log, base: `http://127.0.0.1:${running.port}` };
  }

  it('lists tools for a signed-in user, with every calendar tool gone', async () => {
    const health = await fakeHealth({ 'good-token': 'user-1' });
    const { base, log } = await start(health.url);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: 'Bearer good-token' } } }),
    );
    cleanups.push(() => client.close());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(80);
    expect(names.filter((n) => BLOCKED_TOOLS.has(n))).toEqual([]);
    expect(names).toContain('skylight_list_chores');
    expect(health.calls.every((c) => c.auth === `Bearer ${SECRET}`)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[http\] skylight-mcp \S+ listening on \d+$/));
  });

  it('refuses an unknown token and a missing one', async () => {
    const health = await fakeHealth({});
    const { base } = await start(health.url);
    const none = await fetch(`${base}/mcp`, { method: 'POST' });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('resource_metadata="http://localhost:1/.well-known/oauth-protected-resource/mcp"');
    const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
  });

  it('reports a malformed MCP request through the error log', async () => {
    const health = await fakeHealth({ t: 'u' });
    const { base, log } = await start(health.url);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(res.status).toBe(415);
    await vi.waitFor(() => expect(log.mock.calls.some(([l]) => String(l).startsWith('[http] mcp error:'))).toBe(true));
  });

  it('uses process.env and stderr when given nothing', async () => {
    const health = await fakeHealth({});
    for (const [k, v] of Object.entries({ ...BASE_ENV, AUTH_SERVER_URL: health.url, PORT: '0', SKYLIGHT_TOKEN_CACHE: 'false' })) vi.stubEnv(k, v);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const running = await startHttpServer();
    cleanups.push(() => running.close());
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('listening on'));
  });
});
