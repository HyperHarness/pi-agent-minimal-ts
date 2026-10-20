import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import net, { type Socket } from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { isPublicIpAddress, resolvePublicUrl, createPinnedLookup } from '../../src/agent/public-url-policy.js';
import { fetchWebPage } from '../../src/agent/web-fetch.js';

const publicAddress = { address: '8.8.8.8', family: 4 };
const resolveHostname = async () => [publicAddress];
const html = () => new Response('<p>public page</p>', { headers: { 'content-type': 'text/html' } });

async function listen(t: TestContext, server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return (server.address() as net.AddressInfo).port;
}

test('public address policy blocks private and special IPv4 ranges', () => {
  for (const address of ['0.0.0.0', '0.1.2.3', '10.2.3.4', '100.64.0.1', '100.127.255.254', '127.0.0.2', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.1.2', '198.18.0.1', '198.19.255.254', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255']) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '100.128.0.1', '172.15.255.255', '172.32.0.1', '192.169.0.1']) {
    assert.equal(isPublicIpAddress(address), true, address);
  }
});

test('IPv6 policy rejects local, mapped private, documentation and tunnel addresses', () => {
  for (const address of ['::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'febf::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:169.254.169.254', '::192.168.1.1', '64:ff9b::7f00:1', '2001::1', '2001:db8::1', '2002:7f00:1::1', '3fff::1']) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPublicIpAddress(address), true, address);
  }
});

test('URL canonicalization cannot hide loopback literals or credentials', async () => {
  for (const url of ['http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://[::ffff:7f00:1]/', 'http://user:password@example.test/', 'file:///etc/passwd', 'http://localhost./', 'http://sub.localhost/', 'http://device.local/']) {
    await assert.rejects(resolvePublicUrl(url, resolveHostname), /public|credentials|http/i, url);
  }
});

test('all DNS answers must be public, with matching address families', async () => {
  for (const addresses of [[], [publicAddress, { address: '10.0.0.1', family: 4 }], [{ address: '::1', family: 6 }], [{ address: '8.8.8.8', family: 6 }]]) {
    await assert.rejects(resolvePublicUrl('https://example.test', async () => addresses), /public IP/);
  }
});

test('pinned lookup retains validated answers and rejects another hostname', async () => {
  const records = [{ ...publicAddress }, { address: '2606:4700:4700::1111', family: 6 }];
  const target = await resolvePublicUrl('https://example.test', async () => records);
  const lookup = createPinnedLookup(target);
  records[0].address = '127.0.0.1';
  const addresses = await new Promise((resolve, reject) => lookup('example.test', { all: true }, (error, result) => error ? reject(error) : resolve(result)));
  assert.deepEqual(addresses, [publicAddress, { address: '2606:4700:4700::1111', family: 6 }]);
  await assert.rejects(new Promise((resolve, reject) => lookup('other.test', {}, error => error ? reject(error) : resolve(undefined))), /Unexpected host/);
});

test('custom fetch injection still cannot bypass destination validation', async () => {
  let fetched = false;
  await assert.rejects(fetchWebPage({ url: 'https://evil.test', env: {}, resolveHostname: async () => [{ address: '10.0.0.1', family: 4 }], fetchImpl: async () => { fetched = true; return html(); } }), /public IP/);
  assert.equal(fetched, false);
});

test('private redirects are refused and the redirect body is canceled', async () => {
  let calls = 0;
  let canceled = false;
  await assert.rejects(fetchWebPage({
    url: 'https://example.test', env: {}, resolveHostname,
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, 'manual');
      return new Response(new ReadableStream({ cancel() { canceled = true; } }, { highWaterMark: 0 }), { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    },
  }), /public IP/);
  assert.equal(calls, 1);
  assert.equal(canceled, true);
});

test('the same hostname is revalidated after a relative redirect', async () => {
  let resolves = 0;
  let fetches = 0;
  await assert.rejects(fetchWebPage({
    url: 'https://example.test', env: {},
    resolveHostname: async () => ++resolves === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => { fetches++; return new Response(null, { status: 307, headers: { location: '/next' } }); },
  }), /public IP/);
  assert.equal(resolves, 2);
  assert.equal(fetches, 1);
});

test('public redirects preserve normal HTML fetch behavior and enforce the redirect cap', async () => {
  let fetches = 0;
  const result = await fetchWebPage({ url: 'https://example.test', env: {}, resolveHostname, fetchImpl: async url => {
    fetches++;
    return String(url).endsWith('/next') ? html() : new Response(null, { status: 303, headers: { location: '/next' } });
  } });
  assert.equal(result, 'public page');
  assert.equal(fetches, 2);
  fetches = 0;
  await assert.rejects(fetchWebPage({ url: 'https://example.test', env: {}, resolveHostname, fetchImpl: async () => { fetches++; return new Response(null, { status: 308, headers: { location: '/loop' } }); } }), /Too many/);
  assert.equal(fetches, 11);
});

test('request cancellation also bounds an unresponsive DNS resolver', { timeout: 1000 }, async () => {
  let fetched = false;
  await assert.rejects(fetchWebPage({ url: 'https://example.test', env: { PI_FETCH_TIMEOUT_MS: '10' }, resolveHostname: () => new Promise(() => {}), fetchImpl: async () => { fetched = true; return html(); } }));
  assert.equal(fetched, false);
});

test('the actual direct connector uses the pinned lookup instead of resolving again', async t => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.host, 'example.test');
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<p>pinned</p>');
  });
  const port = await listen(t, server);
  const connect = net.connect;
  let pinned: unknown;
  t.mock.method(net, 'connect', (options: net.NetConnectOpts & { lookup: net.LookupFunction }) => {
    options.lookup('example.test', { all: true }, (error, result) => { assert.equal(error, null); pinned = result; });
    // This test socket always goes to its local fixture, never to a public host.
    return connect({ host: '127.0.0.1', port });
  });
  let resolutions = 0;
  for (const env of [
    {},
    { HTTP_PROXY: 'http://proxy.invalid:9999', NO_PROXY: 'example.test' },
    { HTTP_PROXY: 'socks5://proxy.invalid:9999', PI_AGENT_DISABLE_ENV_PROXY: '1' },
  ]) {
    assert.equal(await fetchWebPage({ url: 'http://example.test', env, resolveHostname: async () => { resolutions++; return [publicAddress]; } }), 'pinned');
  }
  assert.deepEqual(pinned, [publicAddress]);
  assert.equal(resolutions, 3);
});

test('HTTP proxy CONNECT pins the target IP while preserving the request Host header', async t => {
  const server = createServer();
  const authorities: string[] = [];
  let host = '';
  server.on('connect', (request, socket) => {
    authorities.push(request.url ?? '');
    assert.equal(request.headers.host, '8.8.8.8:80');
    assert.equal(request.headers['proxy-authorization'], `Basic ${Buffer.from('proxy-user:proxy-pass').toString('base64')}`);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', bytes => {
      host = bytes.toString();
      socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\nConnection: close\r\n\r\nproxy');
    });
  });
  const port = await listen(t, server);
  assert.equal(await fetchWebPage({ url: 'http://example.test/page', env: { HTTP_PROXY: `http://proxy-user:proxy-pass@127.0.0.1:${port}` }, resolveHostname }), 'proxy');
  assert.deepEqual(authorities, ['8.8.8.8:80']);
  assert.match(host, /host: example\.test\r\n/i);
});

test('HTTPS through a proxy pins CONNECT while TLS still verifies the original hostname', async t => {
  const server = createServer();
  let authority = '';
  let servername: string | undefined;
  server.on('connect', (request, socket) => {
    authority = request.url ?? '';
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  const port = await listen(t, server);
  t.mock.method(tls, 'connect', (options: tls.ConnectionOptions) => {
    servername = options.servername;
    assert.ok(options.socket, 'TLS must wrap the proxy tunnel');
    options.socket.destroy();
    throw new Error('offline TLS inspection complete');
  });
  await assert.rejects(fetchWebPage({ url: 'https://example.test', env: { HTTPS_PROXY: `http://127.0.0.1:${port}` }, resolveHostname }));
  assert.equal(authority, '8.8.8.8:443');
  assert.equal(servername, 'example.test');
});
