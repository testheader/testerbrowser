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
import zlib from 'zlib';

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

  // '::' gives a dual-stack socket on platforms that support it (accepting
  // both 127.0.0.1 and ::1/"localhost" on the same port) — needed by the
  // #237 host-agnostic-matching e2e test, which deliberately loads the same
  // path from both hostnames. Some sandboxes have no IPv6 stack at all
  // (EAFNOSUPPORT), so fall back to the plain IPv4-only bind those
  // environments already worked under. Either way, the listener used only
  // to detect *this* bind attempt's outcome is removed once it resolves, so
  // it never intercepts a real runtime server error later.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => { server.removeListener('error', onError); reject(err); };
    server.once('error', onError);
    server.listen(0, '::', () => { server.removeListener('error', onError); resolve(); });
  }).catch(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  });
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
  if (u.pathname === '/echo/user-agent') return handleUserAgentEcho(req, res);
  if (u.pathname === '/echo/headers') return handleHeadersEcho(req, res);
  if (u.pathname === '/network/gzip-json') return handleGzipJson(res);
  if (u.pathname === '/network/header') return handleVariantHeader(u, res);
  if (u.pathname === '/rest/api/3/issue/TEST-1') return handleJiraFetchTicket(res);
  if (u.pathname === '/rest/api/3/issue/BAD-1') return handleJiraBadGateway(res);
  if (u.pathname === '/rest/api/3/issue' && req.method === 'POST') return handleJiraCreateIssue(res);
  if (u.pathname === '/rest/api/3/issueLink' && req.method === 'POST') return handleJiraIssueLink(req, res);
  if (u.pathname === '/rest/api/3/__debug/issueLinks') return handleJiraIssueLinksDebug(res);
  if (/^\/rest\/api\/3\/issue\/[^/]+\/attachments$/.test(u.pathname) && req.method === 'POST') {
    return handleJiraAttachmentUpload(req, res);
  }
  if (u.pathname === '/rest/api/3/__debug/attachments') return handleJiraAttachmentsDebug(res);
  if (u.pathname === '/rest/api/3/__debug/attachmentStatus' && req.method === 'POST') {
    return handleJiraSetAttachmentStatus(req, res);
  }

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

// Reports the request's own User-Agent header back to the page, so a spoof
// test can assert what the *server* actually received — not just what
// navigator.userAgent claims client-side, which a CDP-only override could
// fake without ever touching the outgoing request.
function handleUserAgentEcho(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ userAgent: req.headers['user-agent'] ?? '' }));
}

// #233: echoes every request header back as JSON — used by Replay's e2e
// coverage to prove what actually left the app (cookies, no [REDACTED]
// leaking through), not just what the overlay's UI shows.
function handleHeadersEcho(req: IncomingMessage, res: ServerResponse): void {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(', ');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(headers));
}

// #235: a real gzip-encoded JSON response, so the Mock panel's "⇒ Mock"
// prefill can be proven to leave out content-encoding/content-length rather
// than copying them onto a rule whose fulfilled body is the *decoded* text.
function handleGzipJson(res: ServerResponse): void {
  const body = zlib.gzipSync(Buffer.from(JSON.stringify({ from: 'server' })));
  res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(body.length) });
  res.end(body);
}

// #237: a response whose header value tracks a query param — network diff's
// e2e coverage loads this with different `v` values on each side (with `v`
// added to the ignore-params list, so the two calls still match by key) and
// asserts the expanded row shows x-variant as a changed header.
function handleVariantHeader(u: URL, res: ServerResponse): void {
  const variant = u.searchParams.get('v') || '1';
  res.writeHead(200, { 'content-type': 'application/json', 'x-variant': variant });
  res.end(JSON.stringify({ variant }));
}

// #267: a fake Jira Cloud site for the Jira tab's e2e coverage — no real
// Jira instance is reachable in CI, so these routes stand in for
// GET issue / POST issue / POST issueLink, plus one route (BAD-1) that
// mimics an SSO-redirect/proxy error returning an HTML page instead of JSON.
let jiraIssueLinks: unknown[] = [];

function handleJiraFetchTicket(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    fields: {
      summary: 'Existing bug from fixtures',
      status: { name: 'Open' },
      assignee: { displayName: 'Ada Tester' },
      priority: { name: 'High' },
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pre-existing description.' }] }] },
    },
  }));
}

function handleJiraBadGateway(res: ServerResponse): void {
  res.writeHead(502, { 'content-type': 'text/html' });
  res.end('<html><body><h1>502 Bad Gateway</h1></body></html>');
}

function handleJiraCreateIssue(res: ServerResponse): void {
  res.writeHead(201, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ key: 'TEST-2' }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8');
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function handleJiraIssueLink(req: IncomingMessage, res: ServerResponse): Promise<void> {
  jiraIssueLinks.push(await readJsonBody(req));
  res.writeHead(201, { 'content-type': 'application/json' });
  res.end('{}');
}

// Test-only introspection route — lets an e2e test assert what the app
// actually sent, since the fixture server (not the app) is what received it.
function handleJiraIssueLinksDebug(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(jiraIssueLinks));
  jiraIssueLinks = [];
}

// #245: evidence attachments. jiraAttachmentStatusOverrides lets a test make
// the "upload" of one specific filename fail (e.g. 413) without touching
// the others, to exercise the app's partial-failure reporting.
interface RecordedAttachment { filename: string; size: number; contentType: string; hadAtlassianToken: boolean; dataBase64: string; }
let jiraAttachments: RecordedAttachment[] = [];
let jiraAttachmentStatusOverrides: Record<string, number> = {};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// A hand-rolled, single-file-part multipart/form-data parser — enough to
// read back what Electron's net.fetch(FormData/Blob) actually sent, without
// pulling in a parsing dependency just for this fixture. Splits on the
// boundary as raw bytes (not strings) so a binary part, e.g. screenshot.png,
// round-trips intact.
function parseMultipartFile(body: Buffer, contentType: string | undefined): { filename: string; contentType: string; data: Buffer } | null {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  const boundary = boundaryMatch ? (boundaryMatch[1] ?? boundaryMatch[2]).trim() : null;
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary}`);

  const parts: Buffer[] = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    parts.push(body.subarray(start + delimiter.length, next));
    start = next;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerText = part.subarray(0, headerEnd).toString('utf-8');
    const filenameMatch = /filename="([^"]*)"/.exec(headerText);
    if (!filenameMatch) continue; // not the file field (e.g. a text field part)
    const partContentType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() ?? 'application/octet-stream';
    // Body runs from after the blank line to the trailing \r\n before the next boundary.
    let dataEnd = part.length;
    if (part[dataEnd - 2] === 0x0d && part[dataEnd - 1] === 0x0a) dataEnd -= 2;
    const data = part.subarray(headerEnd + 4, dataEnd);
    return { filename: filenameMatch[1], contentType: partContentType, data };
  }
  return null;
}

async function handleJiraAttachmentUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const file = parseMultipartFile(body, req.headers['content-type']);
  if (!file) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errorMessages: ['No file part found'] }));
    return;
  }

  jiraAttachments.push({
    filename: file.filename,
    size: file.data.length,
    contentType: file.contentType,
    hadAtlassianToken: req.headers['x-atlassian-token'] === 'no-check',
    dataBase64: file.data.toString('base64'),
  });

  const override = jiraAttachmentStatusOverrides[file.filename];
  if (override) {
    res.writeHead(override, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errorMessages: [`fixture override: ${override}`] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify([{ filename: file.filename, size: file.data.length }]));
}

function handleJiraAttachmentsDebug(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(jiraAttachments));
  jiraAttachments = [];
}

async function handleJiraSetAttachmentStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req) as { filename?: string; status?: number } | null;
  if (body?.filename && body.status) jiraAttachmentStatusOverrides[body.filename] = body.status;
  else jiraAttachmentStatusOverrides = {};
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
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
