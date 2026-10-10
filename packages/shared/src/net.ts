/**
 * Outbound URL guard (SSRF).
 *
 * Caller-supplied URLs (webhook subscriptions, agent-chosen connector
 * endpoints) must not reach the API's own network: loopback, RFC 1918,
 * link-local (cloud metadata), CGNAT, ULA and the IPv4-mapped/NAT64 IPv6
 * spellings of all of those. A hostname is resolved and EVERY address it
 * returns is checked, so `internal.example.com -> 10.0.0.5` is refused too.
 *
 * Residual risk, stated plainly: the address is checked at validation time
 * and fetch resolves again, so a DNS-rebinding host with a ~0s TTL can still
 * swap answers in between. Callers also pass `redirect: "manual"` so a public
 * URL cannot 30x-bounce the request to an internal one.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { validationError } from "./errors.js";

export type HostLookup = (hostname: string) => Promise<string[]>;

const defaultLookup: HostLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

function isNonPublicIpv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 literal to eight 16-bit groups, or null when malformed. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  // Rewrite a dotted IPv4 tail ("::ffff:127.0.0.1") as two hex groups.
  const lastColon = text.lastIndexOf(":");
  const dotted = text.slice(lastColon + 1);
  if (dotted.includes(".")) {
    const octets = ipv4Octets(dotted);
    if (octets === null) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const explicit = head.length + rest.length;
  if (halves.length === 1 ? explicit !== 8 : explicit > 7) return null;
  const groups = [...head, ...new Array<number>(8 - explicit).fill(0), ...rest];
  return groups.every((group) => Number.isInteger(group)) ? groups : null;
}

/** True for any address an outbound caller-supplied request must not reach. */
export function isNonPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const octets = ipv4Octets(ip);
    return octets === null || isNonPublicIpv4(octets);
  }
  if (family !== 6) return true;
  const groups = ipv6Groups(ip);
  if (groups === null) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embeddedV4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  const allZeroTo = (n: number): boolean => groups.slice(0, n).every((group) => group === 0);
  if (allZeroTo(7) && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  if (allZeroTo(5) && g5 === 0xffff) return isNonPublicIpv4(embeddedV4); // IPv4-mapped
  if (allZeroTo(6)) return isNonPublicIpv4(embeddedV4); // IPv4-compatible (deprecated)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isNonPublicIpv4(embeddedV4); // NAT64 well-known prefix
  }
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g0 & 0xff00) === 0xff00 // multicast
  );
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/**
 * Throws a validation error unless every address `rawUrl` resolves to is a
 * public unicast address. Returns the normalised URL string.
 */
export async function assertPublicUrl(rawUrl: string, lookup: HostLookup = defaultLookup): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw validationError("URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw validationError("URL must use http or https");
  }
  // WHATWG URL keeps IPv6 brackets in `hostname` ("[::1]"); strip them.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const refuse = (): never => {
    throw validationError("URL must not target loopback, private or link-local addresses");
  };
  if (host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) refuse();
  if (isIP(host) !== 0) {
    if (isNonPublicAddress(host)) refuse();
    return parsed.toString();
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw validationError(`URL host '${host}' could not be resolved`);
  }
  if (addresses.length === 0 || addresses.some(isNonPublicAddress)) refuse();
  return parsed.toString();
}
