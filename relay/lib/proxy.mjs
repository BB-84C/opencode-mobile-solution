import http from 'node:http';

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
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
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
  clientRes.once('close', notifyClose);
  proxyReq.once('error', (error) => {
    if (closed || timedOut) return;
    notifyClose();
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({
        error: 'upstream_unreachable',
        message: 'OpenCode server is not reachable. Is the SSH tunnel active?',
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
