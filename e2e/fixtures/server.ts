/**
 * Shared HTTP server for e2e fixtures.
 *
 * Serves the static pages under test-pages/ (cookies, console, downloads, ...)
 * plus a handful of dynamic routes that a plain static server can't fake:
 * arbitrary status codes, delayed responses, redirect chains, and generated
 * download bodies. Runs entirely inside the Playwright e2e job — there is no
 * build step for this file or for test-pages/, so it costs nothing outside
 * the e2e run itself and adds no extra sequential CI job.
 */
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import path from 'path';

const TEST_PAGES_ROOT = path.join(__dirname, '..', '..', 'test-pages');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface FixtureServer {
  port: number;
  /** Build a full URL against this server, e.g. url('/console/logs.html'). */
  url(pathAndQuery?: string): string;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('fixture server error: ' + (err instanceof Error ? err.message : String(err)));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    url: (pathAndQuery = '/') => `http://127.0.0.1:${port}${pathAndQuery}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close(err => (err ? reject(err) : resolve()))
    ),
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const u = new URL(req.url ?? '/', 'http://localhost');

  if (u.pathname.startsWith('/network/status/')) return handleStatus(u, res);
  if (u.pathname === '/network/slow') return handleSlow(u, res);
  if (u.pathname === '/network/redirect') return handleRedirect(u, res);
  if (u.pathname === '/downloads/file') return handleDownload(u, res);
  if (u.pathname === '/storage/set-cookie') return handleSetCookie(u, res);
  if (u.pathname === '/perf/echo') return handleEcho(u, res);

  return handleStatic(u, res);
}

function handleStatus(u: URL, res: ServerResponse): void {
  const code = Number(u.pathname.split('/').pop());
  const status = Number.isInteger(code) && code >= 100 && code <= 599 ? code : 400;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
    headers.location = '/network/status/200';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify({ status }));
}

function handleSlow(u: URL, res: ServerResponse): void {
  const ms = Math.min(Number(u.searchParams.get('ms')) || 1000, 30_000);
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`ok after ${ms}ms`);
  }, ms);
}

function handleRedirect(u: URL, res: ServerResponse): void {
  const hops = Number(u.searchParams.get('hops')) || 0;
  if (hops <= 0) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>Redirect chain complete</h1></body></html>');
    return;
  }
  res.writeHead(302, { location: `/network/redirect?hops=${hops - 1}` });
  res.end();
}

function handleDownload(u: URL, res: ServerResponse): void {
  const name = u.searchParams.get('name') || 'download.bin';
  const size = Math.min(Number(u.searchParams.get('size')) || 1024, 50 * 1024 * 1024);
  const type = u.searchParams.get('type') || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-disposition': `attachment; filename="${name}"`,
    'content-length': String(size),
  });
  res.end(Buffer.alloc(size, 'x'));
}

function handleSetCookie(u: URL, res: ServerResponse): void {
  const name = u.searchParams.get('name') || 'server_cookie';
  const value = u.searchParams.get('value') || '1';
  res.writeHead(200, {
    'content-type': 'text/html',
    'set-cookie': `${name}=${value}; Path=/; HttpOnly`,
  });
  res.end(`<html><body><h1>Set-Cookie: ${name}=${value} (HttpOnly)</h1></body></html>`);
}

function handleEcho(u: URL, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, i: u.searchParams.get('i') }));
}

async function handleStatic(u: URL, res: ServerResponse): Promise<void> {
  const relative = u.pathname === '/' ? '/index.html' : u.pathname;
  const resolved = path.normalize(path.join(TEST_PAGES_ROOT, relative));

  // Guard against path traversal escaping test-pages/.
  if (!resolved.startsWith(TEST_PAGES_ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  try {
    const body = await readFile(resolved);
    const ext = path.extname(resolved);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found: ' + relative);
  }
}
