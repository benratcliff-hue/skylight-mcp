// Ratcliff fork: hosted Streamable HTTP entry for claude.ai custom connectors.
//
// Sign-in is delegated to the Ratcliff Health server (AUTH_SERVER_URL), which
// already runs Google-only OAuth restricted to the household's two accounts.
// This server publishes protected-resource metadata naming that server, so
// Claude signs in there, and every /mcp request's bearer token is checked
// against the health server's introspection endpoint. This process never holds
// a database key: only a shared introspection secret.
//
// Fork-only file. Upstream's stdio entry (src/index.ts) is untouched.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { createMcpServer, loadDotenvSafely } from '@chrischall/mcp-utils';
import { makeGetClient } from './get-client.js';
import { HTTP_TOOL_REGISTRARS } from './http-tools.js';

export const MCP_PATH = '/mcp';
export const PRM_PATH = '/.well-known/oauth-protected-resource';
export const INTROSPECT_PATH = '/api/v1/introspect';
/** Inline photo uploads ride inside one tool call, so allow more than the SDK's 4 MiB. */
export const MAX_REQUEST_BODY_BYTES = 12 * 1024 * 1024;

export interface HttpConfig {
  /** This server's public origin, e.g. https://skylight.example.com */
  publicBaseUrl: string;
  /** The Ratcliff Health origin that signs users in and checks tokens. */
  authServerUrl: string;
  /** Shared secret sent to the health server's introspection endpoint. */
  introspectionSecret: string;
  port: number;
}

function originFrom(name: string, raw: string | undefined): string {
  if (!raw?.trim()) throw new Error(`${name} is required`);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use https (http only for localhost)`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} must be a bare origin with no path`);
  }
  return url.origin;
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const secret = env.AUTH_INTROSPECTION_SECRET?.trim() ?? '';
  if (secret.length < 32) throw new Error('AUTH_INTROSPECTION_SECRET must be at least 32 characters');
  const portRaw = env.PORT?.trim() || '8080';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a port number');
  return {
    publicBaseUrl: originFrom('PUBLIC_BASE_URL', env.PUBLIC_BASE_URL),
    authServerUrl: originFrom('AUTH_SERVER_URL', env.AUTH_SERVER_URL),
    introspectionSecret: secret,
    port,
  };
}

export type TokenCheck =
  | { status: 'valid'; userId: string }
  | { status: 'invalid' }
  | { status: 'unavailable' };

export interface TokenVerifierOptions {
  authServerUrl: string;
  secret: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** How long a token the health server confirmed is trusted without asking again. */
  ttlMs?: number;
  maxEntries?: number;
  timeoutMs?: number;
}

/**
 * Checks bearer tokens with the health server. A confirmed token is cached
 * (keyed by its sha256, never the raw value) for `ttlMs`, so a burst of tool
 * calls costs one round trip. A refused token is never cached.
 */
export function createTokenVerifier(opts: TokenVerifierOptions): (token: string) => Promise<TokenCheck> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 60_000;
  const maxEntries = opts.maxEntries ?? 256;
  // The health server sleeps when idle on Railway; leave room for it to wake.
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const cache = new Map<string, { userId: string; until: number }>();

  return async (token) => {
    const key = createHash('sha256').update(token).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.until > now()) return { status: 'valid', userId: hit.userId };
    if (hit) cache.delete(key);

    let res: Response;
    try {
      res = await fetchFn(`${opts.authServerUrl}${INTROSPECT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.secret}` },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { status: 'unavailable' };
    }
    if (res.status !== 200) return { status: 'unavailable' };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { status: 'unavailable' };
    }
    const b = body as { active?: unknown; user_id?: unknown } | null;
    if (b?.active === true && typeof b.user_id === 'string' && b.user_id) {
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
      cache.set(key, { userId: b.user_id, until: now() + ttlMs });
      return { status: 'valid', userId: b.user_id };
    }
    if (b?.active === false) return { status: 'invalid' };
    return { status: 'unavailable' };
  };
}

export interface McpFetch {
  fetch: (request: Request, options?: { authInfo?: AuthInfo }) => Promise<Response>;
}

export interface AppDeps {
  config: Pick<HttpConfig, 'publicBaseUrl' | 'authServerUrl'>;
  verifyToken: (token: string) => Promise<TokenCheck>;
  mcp: McpFetch;
  log?: (line: string) => void;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

/** The web-standard request handler: routing, sign-in check, then the MCP handler. */
export function createApp(deps: AppDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const resource = `${deps.config.publicBaseUrl}${MCP_PATH}`;
  const metadataUrl = `${deps.config.publicBaseUrl}${PRM_PATH}${MCP_PATH}`;
  const challenge = (error?: string) =>
    `Bearer resource_metadata="${metadataUrl}"${error ? `, error="${error}"` : ''}`;

  return async (request) => {
    const { pathname } = new URL(request.url);

    if (pathname === '/healthz') return new Response('ok', { status: 200 });

    if (pathname === PRM_PATH || pathname === `${PRM_PATH}${MCP_PATH}`) {
      if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return json(200, {
        resource,
        authorization_servers: [deps.config.authServerUrl],
        bearer_methods_supported: ['header'],
        resource_name: 'Ratcliff Skylight',
      });
    }

    if (pathname !== MCP_PATH) return json(404, { error: 'not_found' });

    const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '');
    if (!match) {
      log('[http] mcp result=unauthorized status=401');
      return json(401, { error: 'unauthorized' }, { 'www-authenticate': challenge() });
    }
    const token = match[1];
    const check = await deps.verifyToken(token);
    if (check.status === 'invalid') {
      log('[http] mcp result=invalid_token status=401');
      return json(401, { error: 'invalid_token' }, { 'www-authenticate': challenge('invalid_token') });
    }
    if (check.status === 'unavailable') {
      log('[http] mcp result=unavailable status=503');
      return json(503, { error: 'temporarily_unavailable' }, { 'retry-after': '5' });
    }
    const response = await deps.mcp.fetch(request, {
      authInfo: { token, clientId: 'ratcliff-health', scopes: [], resource: new URL(resource), extra: { userId: check.userId } },
    });
    log(`[http] mcp result=ok status=${response.status}`);
    return response;
  };
}

/** Adapts a web-standard handler to node:http, streaming both bodies (SSE included). */
export function toNodeListener(
  handler: (request: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const headers = new Headers();
    for (const [name, values] of Object.entries(req.headersDistinct)) {
      for (const value of values as string[]) headers.append(name, value);
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    // Only the path is read downstream; public URLs come from config, never the Host header.
    const request = new Request(`http://localhost${req.url as string}`, {
      method: req.method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
      signal: controller.signal,
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);

    handler(request)
      .then((response) => {
        const out: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          out[name] = value;
        });
        res.writeHead(response.status, out);
        if (!response.body) return void res.end();
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
      })
      .catch(() => {
        // Only reached before headers go out: the handler rejected, or writeHead threw.
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'server_error' }));
      });
  };
}

export interface RunningServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/** Builds the whole stack and listens. `PORT=0` picks a free port (tests). */
export async function startHttpServer(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { verifyToken?: (token: string) => Promise<TokenCheck>; log?: (line: string) => void } = {},
): Promise<RunningServer> {
  const config = loadHttpConfig(env);
  const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  const getClient = makeGetClient();
  const log = overrides.log ?? ((line: string) => console.error(line));
  const mcp = createMcpHandler(
    () =>
      createMcpServer<typeof getClient>({
        name: 'skylight-mcp',
        version,
        deps: getClient,
        tools: HTTP_TOOL_REGISTRARS,
      }),
    { maxRequestBodySize: MAX_REQUEST_BODY_BYTES, onerror: (e) => log(`[http] mcp error: ${e.message}`) },
  );
  const verifyToken =
    overrides.verifyToken ??
    createTokenVerifier({ authServerUrl: config.authServerUrl, secret: config.introspectionSecret });
  const app = createApp({ config, verifyToken, mcp, log });
  const server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  const port = (server.address() as { port: number }).port;
  log(`[http] skylight-mcp ${version} listening on ${port}`);
  return {
    server,
    port,
    close: async () => {
      await mcp.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/* v8 ignore start -- process entry, exercised by the Docker image, not unit tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await loadDotenvSafely();
  const running = await startHttpServer();
  const stop = () => void running.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
/* v8 ignore stop */
