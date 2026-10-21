import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { EnvHttpProxyAgent, Pool, type Dispatcher } from "undici";

import { isPublicIpAddress } from "./public-ip-policy.js";

/**
 * Public URL validation and pinned transport for issue #21 (phase 2).
 *
 * Every decision about an address is delegated to the adopted
 * `isPublicIpAddress` classifier: this module never re-implements IP policy. It
 * adds the network-shaped parts around that classifier — resolving all answers
 * through an injectable resolver, re-validating every redirect hop, and
 * building a connector that pins the validated addresses so that no later code
 * path can resolve the same name a second time.
 */

export type PublicUrlResolver = (hostname: string) => Promise<LookupAddress[]>;

export interface PublicUrlTarget {
  url: URL;
  addresses: LookupAddress[];
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];
const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:"]);

/** Host part of a URL, without IPv6 brackets, trailing dot or case. */
function hostName(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function defaultResolver(hostname: string): Promise<LookupAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

/** Rejects with the request reason as soon as the request signal aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  const reason = () => signal.reason ?? new Error("Request aborted.");
  if (signal.aborted) return Promise.reject(reason());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(reason());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

function isAllowedAddress(answer: LookupAddress | undefined): answer is LookupAddress {
  if (!answer || typeof answer.address !== "string") return false;
  if (answer.family !== 4 && answer.family !== 6) return false;
  // A literal whose spelling disagrees with the reported family is unusable,
  // because the classifier and the socket would then disagree about the host.
  if (isIP(answer.address) !== answer.family) return false;
  return isPublicIpAddress(answer.address);
}

/**
 * Validates `value` and resolves it, through `resolver`, to the public
 * addresses a connection may use. The URL itself is normalized by the WHATWG
 * parser, so exotic IPv4 spellings such as `http://127.1/` or `http://0x7f000001/`
 * reach the classifier as the literal they really denote.
 */
export async function resolvePublicUrl(
  value: string | URL,
  resolver: PublicUrlResolver = defaultResolver,
  signal?: AbortSignal
): Promise<PublicUrlTarget> {
  if (signal?.aborted) throw signal.reason ?? new Error("Request aborted.");

  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed.");
  }

  const hostname = hostName(url);
  if (!hostname) {
    throw new Error("URL must address a public host.");
  }
  if (hostname === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error("URL must address a public host.");
  }

  const literalFamily = isIP(hostname);
  const answers = literalFamily !== 0
    ? [{ address: hostname, family: literalFamily }]
    : await abortable(Promise.resolve().then(() => resolver(hostname)), signal);

  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error("URL must resolve exclusively to public IP addresses.");
  }

  const addresses: LookupAddress[] = [];
  for (const answer of answers) {
    if (!isAllowedAddress(answer)) {
      throw new Error("URL must resolve exclusively to public IP addresses.");
    }
    addresses.push({ address: answer.address, family: answer.family });
  }

  return { url, addresses };
}

export type PinnedLookup = LookupFunction;

/**
 * A DNS lookup that only ever returns the addresses validated for `target`.
 *
 * Undici hands this to the socket layer, so the connect call cannot perform a
 * second, attacker-influenced resolution. Answers are copied out of the target,
 * and any other hostname or an unmatched family fails the connection.
 */
export function createPinnedLookup(target: PublicUrlTarget): PinnedLookup {
  const addresses = target.addresses.map((item) => ({ address: item.address, family: item.family }));
  const expectedHost = hostName(target.url);

  return (hostname, options, callback) => {
    const requestedHost = hostname.replace(/\.$/, "").toLowerCase();
    const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
    const selected = addresses.filter((item) => !family || item.family === family);
    if (requestedHost !== expectedHost || selected.length === 0) {
      callback(
        Object.assign(new Error(`Unexpected host ${hostname} for a connection pinned to ${expectedHost}.`), { code: "ENOTFOUND" }),
        ""
      );
      return;
    }

    if (options.all) {
      callback(null, selected.map((item) => ({ ...item })));
      return;
    }
    callback(null, selected[0].address, selected[0].family);
  };
}

interface ConnectAuthority {
  host: string;
  port: string;
}

/** Splits an HTTP CONNECT authority-form target into host and port. */
function parseConnectAuthority(value: string): ConnectAuthority {
  const authority = value.trim();
  if (!authority) {
    throw new Error("Refusing a proxy CONNECT request without a target authority.");
  }

  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end === -1) {
      throw new Error(`Refusing to proxy an invalid CONNECT authority: ${authority}`);
    }
    const rest = authority.slice(end + 1);
    if (rest !== "" && !rest.startsWith(":")) {
      throw new Error(`Refusing to proxy an invalid CONNECT authority: ${authority}`);
    }
    return { host: authority.slice(1, end), port: rest.slice(1) };
  }

  const separator = authority.lastIndexOf(":");
  if (separator === -1) {
    return { host: authority, port: "" };
  }
  return { host: authority.slice(0, separator), port: authority.slice(separator + 1) };
}

/** Rewrites the Host header of a CONNECT request to the pinned authority. */
function toPinnedHeaders(
  headers: Dispatcher.ConnectOptions["headers"],
  authority: string
): Dispatcher.ConnectOptions["headers"] {
  if (Array.isArray(headers)) {
    const pairs: string[] = [];
    for (let index = 0; index + 1 < headers.length; index += 2) {
      if (String(headers[index]).toLowerCase() !== "host") {
        pairs.push(String(headers[index]), String(headers[index + 1]));
      }
    }
    pairs.push("host", authority);
    return pairs;
  }

  const source = (headers ?? {}) as Record<string, string | string[] | undefined>;
  const merged: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && name.toLowerCase() !== "host") {
      merged[name] = value;
    }
  }
  merged.host = authority;
  return merged;
}

function assertSupportedProxy(proxy: string): void {
  if (!proxy) return;
  let protocol: string;
  try {
    protocol = new URL(proxy).protocol;
  } catch {
    throw new Error("Invalid proxy URL for public URL fetching.");
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.has(protocol)) {
    throw new Error(
      `Unsupported proxy protocol ${protocol}: only HTTP and HTTPS proxies are supported for public URL fetching.`
    );
  }
}

/**
 * Dispatcher for a single validated target.
 *
 * Proxy routing from the environment is preserved (including `NO_PROXY`, which
 * keeps local traffic on the pinned direct connector), but the tunnel always
 * asks the proxy to reach a validated IP: the CONNECT authority and its Host
 * header carry the pinned address, while the request Host and the TLS SNI /
 * certificate name stay the original URL host, so certificate verification is
 * never relaxed.
 */
export function createPublicUrlDispatcher(target: PublicUrlTarget, env: NodeJS.ProcessEnv): Dispatcher {
  if (target.addresses.length === 0 || target.addresses.some((item) => !isAllowedAddress(item))) {
    throw new Error("Cannot connect without validated public IP addresses.");
  }

  const urlHost = hostName(target.url);
  const urlPort = target.url.port || DEFAULT_PORTS[target.url.protocol] || "";
  const address = target.addresses[0].address;
  const pinnedAuthority = `${isIP(address) === 6 ? `[${address}]` : address}:${urlPort}`;

  const proxyDisabled = env.PI_AGENT_DISABLE_ENV_PROXY === "1";
  const httpProxy = proxyDisabled ? "" : env.http_proxy?.trim() || env.HTTP_PROXY?.trim() || "";
  const httpsProxy = proxyDisabled ? "" : env.https_proxy?.trim() || env.HTTPS_PROXY?.trim() || "";
  for (const proxy of [httpProxy, httpsProxy]) {
    assertSupportedProxy(proxy);
  }

  class PinnedProxyPool extends Pool {
    connect(options: Omit<Dispatcher.ConnectOptions, "origin">): Promise<Dispatcher.ConnectData>;
    connect(
      options: Omit<Dispatcher.ConnectOptions, "origin">,
      callback: (error: Error | null, data: Dispatcher.ConnectData) => void
    ): void;
    connect(
      options: Omit<Dispatcher.ConnectOptions, "origin">,
      callback?: (error: Error | null, data: Dispatcher.ConnectData) => void
    ): void | Promise<Dispatcher.ConnectData> {
      const authority = parseConnectAuthority(options.path);
      if (authority.host.replace(/\.$/, "").toLowerCase() !== urlHost) {
        throw new Error(`Refusing to tunnel ${authority.host} through a connection pinned to ${urlHost}.`);
      }
      if (authority.port && authority.port !== urlPort) {
        throw new Error(`Refusing to tunnel port ${authority.port} through a connection pinned to port ${urlPort}.`);
      }

      const pinned: Omit<Dispatcher.ConnectOptions, "origin"> = {
        ...options,
        path: pinnedAuthority,
        headers: toPinnedHeaders(options.headers, pinnedAuthority)
      };
      return callback ? super.connect(pinned, callback) : super.connect(pinned);
    }
  }

  return new EnvHttpProxyAgent({
    httpProxy,
    httpsProxy,
    noProxy: proxyDisabled ? "*" : env.no_proxy ?? env.NO_PROXY ?? "",
    proxyTunnel: true,
    connect: { lookup: createPinnedLookup(target) },
    requestTls: isIP(urlHost) === 0 ? { servername: urlHost } : {},
    clientFactory: (origin: URL, options: object): Dispatcher =>
      new PinnedProxyPool(origin, options as Pool.Options)
  });
}
