import http from 'node:http';

const basicAuthorization = (username, password) => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
function writeSse(response, { id, event, data }) { response.write(`${id === undefined ? '' : `id: ${id}\n`}${event === undefined ? '' : `event: ${event}\n`}${data === undefined ? '' : String(data).split('\n').map((line) => `data: ${line}`).join('\n')}\n\n`); }

export async function createFakeUpstream({ username = 'opencode', password = 'basic-secret', config = { server: 'fake-opencode' } } = {}) {
  const requests = []; const eventClients = new Set();
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = Buffer.concat(chunks); requests.push({ method: request.method, url: request.url, headers: { ...request.headers }, body });
    if (request.headers.authorization !== basicAuthorization(username, password)) return response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
    const url = new URL(request.url, 'http://fake-upstream'); const pathname = url.pathname;
    if (pathname === '/global/health') return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok' }));
    if (pathname === '/config') return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(config));
    if (pathname === '/global/event' || pathname === '/event') { response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); const client = { response }; eventClients.add(client); request.on('close', () => eventClients.delete(client)); writeSse(response, { event: 'server.connected', data: '{}' }); return; }
    if (pathname === '/__test/status/502' || pathname === '/__test/status/504') { const statusCode = Number(pathname.slice(-3)); return response.writeHead(statusCode, { 'content-type': 'application/json', 'x-upstream-status': String(statusCode) }).end(JSON.stringify({ statusCode })); }
    if (pathname === '/__test/chunked') { response.writeHead(206, { 'content-type': 'application/octet-stream', 'x-upstream-mode': 'chunked' }); response.write(Buffer.from([0, 1, 2])); return setImmediate(() => response.end(Buffer.from([253, 254, 255]))); }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'x-fake-upstream': 'transparent' }); response.end(body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const publishEvent = ({ id = 'evt_live', event = 'message.updated', data = '{}' } = {}) => { for (const client of eventClients) writeSse(client.response, { id, event, data: typeof data === 'string' ? data : JSON.stringify(data) }); };
  return { server, url: `http://127.0.0.1:${server.address().port}`, requests,
    publishEvent,
    disconnectEvents() { for (const client of eventClients) client.response.end(); eventClients.clear(); },
  };
}
