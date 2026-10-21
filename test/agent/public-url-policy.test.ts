import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import net, { type Socket } from "node:net";
import tls from "node:tls";

import { createPinnedLookup, resolvePublicUrl } from "../../src/agent/public-url-policy.js";
import { fetchWebPage } from "../../src/agent/web-fetch.js";

/**
 * Every test here is offline: DNS is injected, and the two tests that exercise
 * real sockets dial a local fixture server through a patched connector. No test
 * resolves or contacts a public host.
 */

const publicAddress = { address: "8.8.8.8", family: 4 };
const resolveHostname = async () => [publicAddress];
const html = () => new Response("<p>public page</p>", { headers: { "content-type": "text/html" } });

const resolverReturning = (answers: unknown) => async () => answers as { address: string; family: number }[];

/** Replaces a module export and returns the restore callback. */
function replaceExport(module: unknown, name: string, value: unknown): () => void {
  const target = module as Record<string, unknown>;
  const original = target[name];
  target[name] = value;
  return () => {
    target[name] = original;
  };
}

type TestLookup = (
  hostname: string,
  options: { all?: boolean; family?: number | "IPv4" | "IPv6" },
  callback: (error: unknown, addresses: unknown) => void
) => void;

function callLookup(lookup: TestLookup, hostname: string, options: { all?: boolean; family?: number | "IPv4" | "IPv6" }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

async function listen(t: TestContext, server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as net.AddressInfo).port;
}

test("URL targets are normalized and forbidden hosts, schemes or credentials are refused", async () => {
  const seen: string[] = [];
  const target = await resolvePublicUrl("  HTTPS://EXAMPLE.test.:8443/Path?q=1  ", async (hostname) => {
    seen.push(hostname);
    return [publicAddress];
  });

  assert.deepEqual(seen, ["example.test"]);
  assert.equal(target.url.protocol, "https:");
  assert.equal(target.url.port, "8443");
  assert.equal(target.url.pathname, "/Path");
  assert.deepEqual(target.addresses, [publicAddress]);

  // Every rejection below keeps a public resolver, so only policy can reject it.
  for (const url of [
    "ftp://example.test/",
    "file:///etc/passwd",
    "http://user:password@example.test/",
    "http://localhost/",
    "http://localhost./",
    "http://sub.localhost/",
    "http://device.local/",
    "http://printer.internal/",
    "http://anything.home.arpa/"
  ]) {
    await assert.rejects(resolvePublicUrl(url, resolveHostname), /public|credentials|http/i, url);
  }

  const accepted = await resolvePublicUrl("https://example.test/", resolveHostname);
  assert.deepEqual(accepted.addresses, [publicAddress]);
});

test("loopback and reserved literals stay blocked in every WHATWG spelling", async () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.0.1/",
    "http://[::1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/"
  ]) {
    await assert.rejects(resolvePublicUrl(url, resolveHostname), /public IP/, url);
  }
});

test("public literals bypass the resolver and keep their normalized URL", async () => {
  let lookups = 0;
  const target = await resolvePublicUrl("http://8.8.8.8:8080/a?b=1", async () => {
    lookups += 1;
    return [];
  });

  assert.equal(lookups, 0);
  assert.equal(target.url.port, "8080");
  assert.equal(target.url.pathname, "/a");
  assert.deepEqual(target.addresses, [{ address: "8.8.8.8", family: 4 }]);
});

test("every DNS answer must be a public address of its declared family", async () => {
  const rejected: Array<[string, unknown]> = [
    ["empty answer set", []],
    ["private answer", [publicAddress, { address: "10.0.0.1", family: 4 }]],
    ["loopback answer", [{ address: "::1", family: 6 }]],
    ["family mismatch", [{ address: "8.8.8.8", family: 6 }]],
    ["not an address", [{ address: "example.test", family: 4 }]],
    ["unknown family", [{ address: "8.8.8.8", family: 0 }]],
    ["mixed families", [{ address: "8.8.8.8", family: 4 }, { address: "fd00::1", family: 6 }]]
  ];

  for (const [label, answers] of rejected) {
    await assert.rejects(resolvePublicUrl("https://example.test", resolverReturning(answers)), /public IP/, label);
  }

  const target = await resolvePublicUrl(
    "https://example.test",
    resolverReturning([publicAddress, { address: "2606:4700:4700::1111", family: 6 }])
  );
  assert.deepEqual(target.addresses, [publicAddress, { address: "2606:4700:4700::1111", family: 6 }]);
});

test("the pinned lookup reuses validated answers and refuses other hosts or families", async () => {
  const records = [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
  const target = await resolvePublicUrl("https://example.test", async () => records);
  // A resolver that starts lying after validation must not affect the pin.
  records[0].address = "127.0.0.1";

  const lookup = createPinnedLookup(target) as unknown as TestLookup;
  const both = [publicAddress, { address: "2606:4700:4700::1111", family: 6 }];
  assert.deepEqual(await callLookup(lookup, "example.test", { all: true }), both);
  assert.deepEqual(await callLookup(lookup, "EXAMPLE.test.", { all: true }), both);
  assert.deepEqual(await callLookup(lookup, "example.test", { all: true, family: 6 }), [
    { address: "2606:4700:4700::1111", family: 6 }
  ]);
  assert.deepEqual(await callLookup(lookup, "example.test", { all: true, family: "IPv4" }), [publicAddress]);
  assert.deepEqual(await callLookup(lookup, "example.test", { all: true, family: "IPv6" }), [
    { address: "2606:4700:4700::1111", family: 6 }
  ]);
  await assert.rejects(callLookup(lookup, "example.test", { all: true, family: 9 }), /Unexpected host/);
  await assert.rejects(callLookup(lookup, "other.test", { all: true }), /Unexpected host/);
  await assert.rejects(callLookup(lookup, "127.0.0.1", { all: true }), /Unexpected host/);
});

test("custom fetch injection still cannot bypass destination validation", async () => {
  let fetched = false;
  await assert.rejects(
    fetchWebPage({
      url: "https://evil.test",
      env: {},
      resolveHostname: async () => [{ address: "10.0.0.1", family: 4 }],
      fetchImpl: async () => {
        fetched = true;
        return html();
      }
    }),
    /public IP/
  );
  assert.equal(fetched, false);
});

test("private redirects are refused and the redirect body is canceled", async () => {
  let calls = 0;
  let canceled = false;
  await assert.rejects(
    fetchWebPage({
      url: "https://example.test",
      env: {},
      resolveHostname,
      fetchImpl: async (_url, init) => {
        calls += 1;
        assert.equal(init?.redirect, "manual");
        return new Response(
          new ReadableStream({ cancel() { canceled = true; } }, { highWaterMark: 0 }),
          { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }
        );
      }
    }),
    /public IP/
  );
  assert.equal(calls, 1);
  assert.equal(canceled, true);
});

test("the same hostname is revalidated after a relative redirect", async () => {
  let resolves = 0;
  let fetches = 0;
  await assert.rejects(
    fetchWebPage({
      url: "https://example.test",
      env: {},
      resolveHostname: async () => (++resolves === 1 ? [publicAddress] : [{ address: "127.0.0.1", family: 4 }]),
      fetchImpl: async () => {
        fetches += 1;
        return new Response(null, { status: 307, headers: { location: "/next" } });
      }
    }),
    /public IP/
  );
  assert.equal(resolves, 2);
  assert.equal(fetches, 1);
});

test("public redirects preserve normal HTML fetch behavior and enforce the redirect cap", async () => {
  let fetches = 0;
  const result = await fetchWebPage({
    url: "https://example.test",
    env: {},
    resolveHostname,
    fetchImpl: async (url) => {
      fetches += 1;
      return String(url).endsWith("/next") ? html() : new Response(null, { status: 303, headers: { location: "/next" } });
    }
  });
  assert.equal(result, "public page");
  assert.equal(fetches, 2);

  fetches = 0;
  await assert.rejects(
    fetchWebPage({
      url: "https://example.test",
      env: {},
      resolveHostname,
      fetchImpl: async () => {
        fetches += 1;
        return new Response(null, { status: 308, headers: { location: "/loop" } });
      }
    }),
    /Too many/
  );
  assert.equal(fetches, 11);
});

test("request cancellation also bounds an unresponsive DNS resolver", { timeout: 1_000 }, async () => {
  let fetched = false;
  await assert.rejects(
    fetchWebPage({
      url: "https://example.test",
      env: { PI_FETCH_TIMEOUT_MS: "10" },
      resolveHostname: () => new Promise<never>(() => { /* never settles */ }),
      fetchImpl: async () => {
        fetched = true;
        return html();
      }
    })
  );
  assert.equal(fetched, false);
});

test("unsupported proxy protocols fail clearly before any request", async () => {
  for (const env of [
    { HTTPS_PROXY: "socks5://proxy.invalid:1080" },
    { HTTP_PROXY: "socks4://proxy.invalid:1080" }
  ]) {
    let fetched = false;
    await assert.rejects(
      fetchWebPage({
        url: "https://example.test",
        env,
        resolveHostname,
        fetchImpl: async () => {
          fetched = true;
          return html();
        }
      }),
      /only HTTP and HTTPS proxies/i
    );
    assert.equal(fetched, false);
  }
});

test("the actual direct connector uses the pinned lookup instead of resolving again", async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.host, "example.test");
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<p>pinned</p>");
  });
  const port = await listen(t, server);

  const originalConnect = net.connect;
  let pinned: unknown;
  t.after(
    replaceExport(net, "connect", (options: net.TcpNetConnectOpts & { lookup?: TestLookup }) => {
      if (options.host === "example.test") {
        options.lookup?.("example.test", { all: true }, (error, addresses) => {
          assert.equal(error, null);
          pinned = addresses;
        });
        // The fixture is local; the pinned address above is only inspected.
        return originalConnect({ host: "127.0.0.1", port });
      }
      return originalConnect(options);
    })
  );

  let resolutions = 0;
  for (const env of [
    {},
    { HTTP_PROXY: "http://proxy.invalid:9999", NO_PROXY: "example.test" },
    { HTTP_PROXY: "socks5://proxy.invalid:9999", PI_AGENT_DISABLE_ENV_PROXY: "1" }
  ]) {
    assert.equal(
      await fetchWebPage({
        url: "http://example.test",
        env,
        resolveHostname: async () => {
          resolutions += 1;
          return [publicAddress];
        }
      }),
      "pinned"
    );
  }

  assert.deepEqual(pinned, [publicAddress]);
  assert.equal(resolutions, 3);
});

test("NO_PROXY and no_proxy bypass the proxy with no CONNECT and a pinned direct connection", async (t) => {
  const proxyAttempts: string[] = [];
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    proxyAttempts.push(`CONNECT ${request.url ?? ""}`);
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  proxy.on("request", (request, response) => {
    proxyAttempts.push(`${request.method ?? ""} ${request.url ?? ""}`);
    response.writeHead(502, { "content-type": "text/plain" });
    response.end();
  });
  const proxyPort = await listen(t, proxy);

  const hosts: string[] = [];
  const origin = createServer((request, response) => {
    hosts.push(String(request.headers.host ?? ""));
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<p>direct</p>");
  });
  const originPort = await listen(t, origin);

  const originalConnect = net.connect;
  const lookups: unknown[] = [];
  t.after(
    replaceExport(net, "connect", (options: net.TcpNetConnectOpts & { lookup?: TestLookup }) => {
      if (options.host === "example.test") {
        options.lookup?.("example.test", { all: true }, (error, addresses) => {
          assert.equal(error, null);
          lookups.push(addresses);
        });
        // The fixture is local; the pinned address above is only inspected.
        return originalConnect({ host: "127.0.0.1", port: originPort });
      }
      return originalConnect(options);
    })
  );

  // Both environment spellings must bypass: uppercase first, then the
  // lowercase pair that takes precedence when both are present.
  for (const env of [
    { HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: "example.test" },
    { http_proxy: `http://127.0.0.1:${proxyPort}`, no_proxy: "example.test", NO_PROXY: "other.test" }
  ]) {
    assert.equal(await fetchWebPage({ url: "http://example.test/page", env, resolveHostname }), "direct");
  }

  assert.deepEqual(proxyAttempts, []);
  assert.deepEqual(hosts, ["example.test", "example.test"]);
  assert.deepEqual(lookups, [[publicAddress], [publicAddress]]);
});

test("PI_AGENT_DISABLE_ENV_PROXY ignores malformed proxy URLs instead of interpreting them", async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<p>${request.headers.host === "example.test" ? "disabled" : "wrong-host"}</p>`);
  });
  const port = await listen(t, server);

  const originalConnect = net.connect;
  const lookups: unknown[] = [];
  t.after(
    replaceExport(net, "connect", (options: net.TcpNetConnectOpts & { lookup?: TestLookup }) => {
      if (options.host === "example.test") {
        options.lookup?.("example.test", { all: true }, (error, addresses) => {
          assert.equal(error, null);
          lookups.push(addresses);
        });
        // The fixture is local; the pinned address above is only inspected.
        return originalConnect({ host: "127.0.0.1", port });
      }
      return originalConnect(options);
    })
  );

  const malformed = ["http://[::1", "not a proxy url", "://missing-scheme"];
  for (const proxy of malformed) {
    assert.equal(
      await fetchWebPage({
        url: "http://example.test/page",
        env: {
          HTTP_PROXY: proxy,
          http_proxy: proxy,
          HTTPS_PROXY: proxy,
          https_proxy: proxy,
          PI_AGENT_DISABLE_ENV_PROXY: "1"
        },
        resolveHostname
      }),
      "disabled",
      proxy
    );
  }
  assert.deepEqual(lookups, malformed.map(() => [publicAddress]));

  // The same values are rejected rather than silently used when the explicit
  // disable is absent, so the disable test above is not vacuous.
  for (const proxy of malformed) {
    let fetched = false;
    await assert.rejects(
      fetchWebPage({
        url: "http://example.test/page",
        env: { HTTP_PROXY: proxy },
        resolveHostname,
        fetchImpl: async () => {
          fetched = true;
          return html();
        }
      }),
      /Invalid proxy URL/,
      proxy
    );
    assert.equal(fetched, false);
  }
});

test("HTTP proxy CONNECT targets the validated IP while the request Host is preserved", async (t) => {
  const server = createServer();
  const authorities: string[] = [];
  let connectHost = "";
  let tunneledRequest = "";
  server.on("connect", (request, socket) => {
    authorities.push(request.url ?? "");
    connectHost = String(request.headers.host ?? "");
    assert.equal(
      request.headers["proxy-authorization"],
      `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`
    );
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", (bytes) => {
      tunneledRequest = bytes.toString();
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\nConnection: close\r\n\r\nproxy");
    });
  });
  const port = await listen(t, server);

  const result = await fetchWebPage({
    url: "http://example.test/page",
    env: { HTTP_PROXY: `http://proxy-user:proxy-pass@127.0.0.1:${port}` },
    resolveHostname
  });

  assert.equal(result, "proxy");
  assert.deepEqual(authorities, ["8.8.8.8:80"]);
  assert.equal(connectHost, "8.8.8.8:80");
  assert.match(tunneledRequest, /^GET \/page HTTP\/1\.1/);
  assert.match(tunneledRequest, /host: example\.test\r\n/i);
});

test("HTTPS through a proxy pins CONNECT while TLS still verifies the original hostname", async (t) => {
  const server = createServer();
  let authority = "";
  server.on("connect", (request, socket) => {
    authority = request.url ?? "";
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  });
  const port = await listen(t, server);

  let servername: string | undefined;
  let wrappedTunnel = false;
  const originalTlsConnect = tls.connect;
  t.after(
    replaceExport(tls, "connect", (options: tls.ConnectionOptions) => {
      if (options.socket && options.servername === "example.test") {
        servername = options.servername;
        wrappedTunnel = true;
        options.socket.destroy();
        throw new Error("offline TLS inspection complete");
      }
      return originalTlsConnect(options);
    })
  );

  await assert.rejects(
    fetchWebPage({
      url: "https://example.test/",
      env: { HTTPS_PROXY: `http://127.0.0.1:${port}` },
      resolveHostname
    })
  );

  assert.equal(authority, "8.8.8.8:443");
  assert.equal(servername, "example.test");
  assert.equal(wrappedTunnel, true);
});
