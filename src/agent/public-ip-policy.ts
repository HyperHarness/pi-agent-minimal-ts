import { isIP } from "node:net";

/**
 * Pure, offline SSRF classification for IP literals (issue #21, phase 1).
 *
 * `isPublicIpAddress` inspects only the literal it is handed: it never resolves
 * DNS, parses URLs, reads the environment or touches the network. DNS pinning,
 * redirect re-validation and transport enforcement live in separate batches.
 */

const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV4_MAPPED_HIGH_BITS = 0xffffn;
const IPV4_MAPPED_LOW_BITS = 0xffffffffn;

interface Cidr {
  readonly base: bigint;
  readonly length: number;
  readonly bits: number;
}

/**
 * IPv4 space that must never be reachable: unspecified, private, loopback,
 * link-local, carrier-grade NAT, documentation, benchmarking, multicast and
 * reserved ranges.
 */
const BLOCKED_IPV4_SPECS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];

/**
 * Only 2000::/3 global unicast is reachable; the gaps carved out below are
 * special purpose (Teredo/ORCHID/benchmarking, documentation, 6to4 and the
 * newer documentation block).
 */
const IPV6_GLOBAL_UNICAST_SPEC: readonly [string, number] = ["2000::", 3];
const BLOCKED_IPV6_SPECS: ReadonlyArray<readonly [string, number]> = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20]
];

function parseIpv4Octet(part: string): number | null {
  if (part.length === 0 || part.length > 3 || (part.length > 1 && part.startsWith("0"))) return null;
  let octet = 0;
  for (const character of part) {
    const digit = character.charCodeAt(0) - 0x30;
    if (digit < 0 || digit > 9) return null;
    octet = octet * 10 + digit;
  }
  return octet <= 255 ? octet : null;
}

function parseIpv4Literal(address: string): bigint | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    const octet = parseIpv4Octet(part);
    if (octet === null) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6Group(part: string): number | null {
  if (part.length === 0 || part.length > 4) return null;
  let group = 0;
  for (const character of part) {
    const digit = Number.parseInt(character, 16);
    if (Number.isNaN(digit)) return null;
    group = group * 16 + digit;
  }
  return group;
}

function parseIpv6Groups(part: string): number[] | null {
  if (part === "") return [];
  const pieces = part.split(":");
  const groups: number[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (piece.includes(".")) {
      // Dotted-quad tails are only legal in the final position (IPv4-mapped form).
      if (index !== pieces.length - 1) return null;
      const embedded = parseIpv4Literal(piece);
      if (embedded === null) return null;
      groups.push(Number((embedded >> 16n) & 0xffffn), Number(embedded & 0xffffn));
      continue;
    }
    const group = parseIpv6Group(piece);
    if (group === null) return null;
    groups.push(group);
  }
  return groups;
}

/** Parses a syntactic IPv6 literal into its 128-bit integer value. */
function parseIpv6Literal(address: string): bigint | null {
  if (address.includes("%")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const headGroups = parseIpv6Groups(halves[0]);
  if (headGroups === null) return null;

  let groups: number[];
  if (halves.length === 1) {
    groups = headGroups;
  } else {
    const tailGroups = parseIpv6Groups(halves[1]);
    if (tailGroups === null) return null;
    const omitted = 8 - headGroups.length - tailGroups.length;
    if (omitted < 1) return null;
    groups = [...headGroups, ...new Array<number>(omitted).fill(0), ...tailGroups];
  }
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

function toIpv4Cidr([base, length]: readonly [string, number]): Cidr {
  const parsed = parseIpv4Literal(base);
  if (parsed === null) throw new Error(`Invalid static IPv4 prefix base: ${base}`);
  return { base: parsed, length, bits: IPV4_BITS };
}

function toIpv6Cidr([base, length]: readonly [string, number]): Cidr {
  const parsed = parseIpv6Literal(base);
  if (parsed === null) throw new Error(`Invalid static IPv6 prefix base: ${base}`);
  return { base: parsed, length, bits: IPV6_BITS };
}

const BLOCKED_IPV4 = BLOCKED_IPV4_SPECS.map(toIpv4Cidr);
const BLOCKED_IPV6 = BLOCKED_IPV6_SPECS.map(toIpv6Cidr);
const IPV6_GLOBAL_UNICAST = toIpv6Cidr(IPV6_GLOBAL_UNICAST_SPEC);

function isInsideCidr(value: bigint, cidr: Cidr): boolean {
  const shift = BigInt(cidr.bits - cidr.length);
  return value >> shift === cidr.base >> shift;
}

function isPublicIpv4(value: bigint): boolean {
  return !BLOCKED_IPV4.some((cidr) => isInsideCidr(value, cidr));
}

function isPublicIpv6(value: bigint): boolean {
  // ::ffff:0:0/96 carries an IPv4 address, so the embedded policy decides.
  if (value >> 32n === IPV4_MAPPED_HIGH_BITS) return isPublicIpv4(value & IPV4_MAPPED_LOW_BITS);
  if (!isInsideCidr(value, IPV6_GLOBAL_UNICAST)) return false;
  return !BLOCKED_IPV6.some((cidr) => isInsideCidr(value, cidr));
}

/**
 * Reports whether `address` is a syntactic IP literal that policy allows
 * fetching. Hostnames, zone identifiers, malformed input and the ranges listed
 * above are rejected; IPv4-mapped IPv6 literals are judged by the IPv4 address
 * they embed, in both dotted and hexadecimal spellings.
 */
export function isPublicIpAddress(address: string): boolean {
  if (typeof address !== "string" || address.length === 0 || address.includes("%")) return false;

  switch (isIP(address)) {
    case 4: {
      const value = parseIpv4Literal(address);
      return value !== null && isPublicIpv4(value);
    }
    case 6: {
      const value = parseIpv6Literal(address);
      return value !== null && isPublicIpv6(value);
    }
    default:
      return false;
  }
}
