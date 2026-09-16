import http from 'node:http';
import { EXPOSED_RESPONSE_HEADERS } from './cors.mjs';

export const ORDINARY_REQUEST_TIMEOUT_MS = 300_000;

export function isStreamingRequest(clientReq) {
  const pathname = new URL(clientReq.url || '/', 'http://relay').pathname;
  const accept = clientReq.headers?.accept || '';
  return pathname === '/event'
    || pathname === '/global/event'
    || accept.includes('text/event-stream');
}

export function proxyRequest({ clientReq, clientRes, target, scope, onOpen, onClose }) {
  const headers = { ...clientReq.headers };
  delete headers.authorization;
  delete headers.host;
  delete headers['x-opencode-directory'];
  headers.host = `${target.host}:${target.port}`;
  headers.authorization = `Basic ${Buffer.from(`${target.basicUser}:${target.basicPass}`).toString('base64')}`;
  if (scope.directory) headers['x-opencode-directory'] = scope.directory;
  const targetUrl = new URL(clientReq.url || '/', 'http://relay');
  if (scope.directory) targetUrl.searchParams.set('directory', scope.directory);
  else targetUrl.searchParams.delete('directory');
  const targetPath = `${targetUrl.pathname}${targetUrl.search}`;

  const streaming = isStreamingRequest(clientReq);
  let closed = false;
  let timedOut = false;
  let notifiedClose = false;
  const notifyClose = () => {
    if (!notifiedClose) {
      notifiedClose = true;
      onClose?.({ clientID: scope.clientID, clientToken: scope.clientToken, targetID: scope.targetID, streaming, close });
    }
  };
  const proxyReq = http.request({
    hostname: target.host,
    port: target.port,
    path: targetPath,
    method: clientReq.method,
    headers,
  }, (proxyRes) => {
    if (closed) {
      proxyRes.destroy();
      return;
    }
    // The relay answers its own OPTIONS preflight, but the upstream response is
    // forwarded verbatim. A client with a real origin -- the desktop shell loads
    // from its own scheme -- would pass the preflight and then be blocked from
    // reading the body. Supply the header only when the backend did not, so a
    // backend started with `opencode serve --cors` keeps its own policy.
    const responseHeaders = { ...proxyRes.headers };
    const declaresOrigin = Object.keys(responseHeaders)
      .some((name) => name.toLowerCase() === 'access-control-allow-origin');
    if (!declaresOrigin) responseHeaders['access-control-allow-origin'] = '*';
    // Passing the preflight only buys the request. A cross-origin reader still
    // sees null for every custom response header unless it is exposed by name,
    // which turned the paged session list into a silent single page.
    const declaresExposed = Object.keys(responseHeaders)
      .some((name) => name.toLowerCase() === 'access-control-expose-headers');
    if (!declaresExposed) {
      responseHeaders['access-control-expose-headers'] = EXPOSED_RESPONSE_HEADERS.join(',');
    }

    clientRes.writeHead(proxyRes.statusCode, responseHeaders);
    proxyRes.pipe(clientRes);
    proxyRes.once('end', notifyClose);
  });
  const close = () => {
    if (closed) return;
    closed = true;
    proxyReq.destroy();
    if (!clientRes.writableEnded) clientRes.destroy();
    notifyClose();
  };
  onOpen?.({ clientID: scope.clientID, clientToken: scope.clientToken, targetID: scope.targetID, streaming, close });
  clientRes.once('close', () => {
    // A client that disappears mid-response must take its upstream request with
    // it. Phones drop SSE streams constantly (screen lock, network switch, app
    // backgrounded), and without this the relay keeps one upstream connection
    // per abandoned stream until the backend stops accepting new ones and every
    // /event starts answering 502. Only notify on a response that already
    // finished on its own; there is nothing left to tear down in that case.
    if (!clientRes.writableEnded) close();
    else notifyClose();
  });
  proxyReq.once('error', (error) => {
    if (closed || timedOut) return;
    notifyClose();
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({
        error: 'upstream_unreachable',
        message: 'OpenCode server is not reachable. Is the backend running on this host?',
      }));
    }
    console.error(`[relay] Proxy error: ${error.message}`);
  });
  if (!streaming) {
    proxyReq.setTimeout(ORDINARY_REQUEST_TIMEOUT_MS, () => {
      timedOut = true;
      proxyReq.destroy();
      notifyClose();
      if (!clientRes.headersSent) {
        clientRes.writeHead(504, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'upstream_timeout' }));
      }
    });
  }
  clientReq.pipe(proxyReq);
  return { close, streaming };
}
