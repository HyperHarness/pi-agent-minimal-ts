import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { EnvHttpProxyAgent, Pool, type Dispatcher } from 'undici';

export type PublicUrlResolver = (hostname: string) => Promise<LookupAddress[]>;
export interface PublicUrlTarget { url: URL; addresses: LookupAddress[] }

function ipv4Value(address: string): number {
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
}

function ipv6Value(address: string): bigint {
  let text = address;
  const dotted = /(?:\d+\.){3}\d+$/.exec(text);
  if (dotted) {
    const value = ipv4Value(dotted[0]);
    text = text.slice(0, dotted.index) + `${Math.floor(value / 65536).toString(16)}:${(value % 65536).toString(16)}`;
  }
  const [left, right] = text.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const groups = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Value(address);
    const blocked: Array<[string, number]> = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return !blocked.some(([base, bits]) => (value >>> (32 - bits)) === (ipv4Value(base) >>> (32 - bits)));
  }
  if (family !== 6) return false;
  const value = ipv6Value(address);
  if ((value >> 32n) === 0xffffn) {
    const tail = Number(value & 0xffffffffn);
    return isPublicIpAddress([24, 16, 8, 0].map(shift => (tail >>> shift) & 255).join('.'));
  }
  // Only global unicast, excluding documentation and special/tunnel ranges.
  if ((value >> 125n) !== 1n) return false;
  return ![
    [ipv6Value('2001::'), 23n], [ipv6Value('2001:db8::'), 32n],
    [ipv6Value('2002::'), 16n], [ipv6Value('3fff::'), 20n],
  ].some(([base, bits]) => (value >> (128n - bits)) === (base >> (128n - bits)));
}

function hostName(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('Request aborted.')); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function resolvePublicUrl(
  value: string | URL,
  resolver: PublicUrlResolver = hostname => lookup(hostname, { all: true, verbatim: true }),
  signal?: AbortSignal,
): Promise<PublicUrlTarget> {
  if (signal?.aborted) throw signal.reason ?? new Error('Request aborted.');
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs are supported.');
  if (url.username || url.password) throw new Error('URL credentials are not allowed.');
  const hostname = hostName(url);
  if (hostname === 'localhost' || /\.(?:localhost|local|internal|home\.arpa)$/.test(hostname)) {
    throw new Error('URL must address a public host.');
  }
  const literalFamily = isIP(hostname);
  const resolved = literalFamily ? [{ address: hostname, family: literalFamily }] : await abortable(Promise.resolve().then(() => resolver(hostname)), signal);
  if (!resolved.length || resolved.some(item => isIP(item.address) !== item.family || !isPublicIpAddress(item.address))) {
    throw new Error('URL must resolve exclusively to public IP addresses.');
  }
  return { url, addresses: resolved.map(item => ({ address: item.address, family: item.family })) };
}

/** No second DNS lookup is allowed after validation, including IPv4/IPv6 fallback. */
export function createPinnedLookup(target: PublicUrlTarget): LookupFunction {
  const addresses = target.addresses.map(item => ({ ...item }));
  const expected = hostName(target.url);
  return (hostname, options, callback) => {
    const selected = addresses.filter(item => !options.family || item.family === options.family);
    if (hostname.replace(/\.$/, '').toLowerCase() !== expected || !selected.length) {
      callback(Object.assign(new Error('Unexpected host or address family for pinned connection.'), { code: 'ENOTFOUND' }), '');
      return;
    }
    callback(null, options.all ? selected : selected[0].address, selected[0].family);
  };
}

/** Keeps proxy routing while CONNECT uses a validated IP, never remote DNS. */
export function createPublicUrlDispatcher(target: PublicUrlTarget, env: NodeJS.ProcessEnv): Dispatcher {
  if (!target.addresses.length || target.addresses.some(item => !isPublicIpAddress(item.address) || isIP(item.address) !== item.family)) {
    throw new Error('Cannot connect without validated public IP addresses.');
  }
  const port = target.url.port || (target.url.protocol === 'https:' ? '443' : '80');
  const expectedAuthority = `${target.url.hostname}:${port}`;
  const address = target.addresses[0].address;
  const pinnedAuthority = `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
  const disabled = env.PI_AGENT_DISABLE_ENV_PROXY === '1';
  const httpProxy = disabled ? '' : env.http_proxy?.trim() || env.HTTP_PROXY?.trim() || '';
  const httpsProxy = disabled ? '' : env.https_proxy?.trim() || env.HTTPS_PROXY?.trim() || '';
  for (const proxy of [httpProxy, httpsProxy]) {
    if (proxy && !['http:', 'https:'].includes(new URL(proxy).protocol)) {
      throw new Error('Public URL fetching supports only HTTP/HTTPS proxies with pinned CONNECT targets.');
    }
  }
  class PinnedProxyPool extends Pool {
    override connect(options: Omit<Dispatcher.ConnectOptions, 'origin'>, callback: (error: Error | null, data: Dispatcher.ConnectData) => void): void;
    override connect(options: Omit<Dispatcher.ConnectOptions, 'origin'>): Promise<Dispatcher.ConnectData>;
    override connect(options: Omit<Dispatcher.ConnectOptions, 'origin'>, callback?: (error: Error | null, data: Dispatcher.ConnectData) => void): void | Promise<Dispatcher.ConnectData> {
      if (options.path !== expectedAuthority) throw new Error('Unexpected proxy CONNECT destination.');
      const pinned = {
        ...options, path: pinnedAuthority,
        headers: { ...(options.headers as Record<string, string>), host: pinnedAuthority },
      };
      return callback ? super.connect(pinned, callback) : super.connect(pinned);
    }
  }
  return new EnvHttpProxyAgent({
    httpProxy, httpsProxy,
    noProxy: disabled ? '*' : env.no_proxy ?? env.NO_PROXY ?? '',
    proxyTunnel: true,
    connect: { lookup: createPinnedLookup(target) },
    requestTls: { servername: isIP(hostName(target.url)) ? undefined : hostName(target.url) },
    clientFactory: (origin, options) => new PinnedProxyPool(origin, options),
  });
}
