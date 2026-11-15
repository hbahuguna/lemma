import { promises as dns } from "node:dns";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isIP } from "node:net";

import { SsrfError } from "./errors.js";

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata",
  "kubernetes.default.svc",
]);

const DEFAULT_BLOCKED_NETWORKS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
  "::/128",
  "::1/128",
  "64:ff9b::/96",
  "100::/64",
  "2001:db8::/32",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
] as const;

export type Resolver = (hostname: string) => string[] | Promise<string[]>;

interface ParsedCidr {
  network: bigint;
  prefix: number;
  bits: 32 | 128;
}

function safeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value).trim();
  return "";
}

function isIpLiteral(host: string): boolean {
  return isIP(host) !== 0;
}

function parseIpv4(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function parseIpv6(ip: string): bigint | null {
  let s = ip.toLowerCase();
  const zoneIdx = s.indexOf("%");
  if (zoneIdx >= 0) s = s.slice(0, zoneIdx);

  // IPv4-embedded tail
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    if (lastColon < 0) return null;
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = Number((v4 >> 16n) & 0xffffn).toString(16);
    const lo = Number(v4 & 0xffffn).toString(16);
    s = `${s.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const parts = s.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(":").filter((x) => x.length > 0) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(":").filter((x) => x.length > 0) : [];
  const fill = 8 - (left.length + right.length);
  if (fill < 0) return null;
  const zeros: string[] = Array.from({ length: fill }, () => "0");
  const full = parts.length === 2 ? [...left, ...zeros, ...right] : left;
  if (full.length !== 8) return null;

  let n = 0n;
  for (const h of full) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    n = (n << 16n) | BigInt(parseInt(h, 16));
  }
  return n;
}

function ipToInt(ip: string): { value: bigint; bits: 32 | 128 } | null {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return { value: v4, bits: 32 };
  const v6 = parseIpv6(ip);
  if (v6 !== null) return { value: v6, bits: 128 };
  return null;
}

function maskNetwork(value: bigint, prefix: number, bits: 32 | 128): bigint {
  if (prefix <= 0) return 0n;
  if (prefix >= bits) return value;
  const shift = BigInt(bits - prefix);
  return (value >> shift) << shift;
}

function parseCidr(cidr: string): ParsedCidr {
  const [addrRaw, prefixRaw] = cidr.split("/");
  const addr = (addrRaw ?? "").trim();
  const bitsInfo = ipToInt(addr);
  if (!bitsInfo || prefixRaw === undefined) {
    throw new SsrfError(`Invalid SSRF allowlist CIDR: ${cidr}`);
  }
  if (!/^\d+$/.test(prefixRaw)) {
    throw new SsrfError(`Invalid SSRF allowlist CIDR: ${cidr}`);
  }
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bitsInfo.bits) {
    throw new SsrfError(`Invalid SSRF allowlist CIDR: ${cidr}`);
  }
  return {
    network: maskNetwork(bitsInfo.value, prefix, bitsInfo.bits),
    prefix,
    bits: bitsInfo.bits,
  };
}

const PARSED_DEFAULT_BLOCKED_NETWORKS: ParsedCidr[] = DEFAULT_BLOCKED_NETWORKS.map((c) => parseCidr(c));

function ipInCidr(ip: string, cidr: ParsedCidr): boolean {
  const info = ipToInt(ip);
  if (!info || info.bits !== cidr.bits) return false;
  return maskNetwork(info.value, cidr.prefix, cidr.bits) === cidr.network;
}

function parseAllowlist(entries?: Iterable<unknown> | null): { hosts: string[]; networks: ParsedCidr[] } {
  const hosts: string[] = [];
  const networks: ParsedCidr[] = [];
  for (const entry of entries ?? []) {
    if (Array.isArray(entry)) {
      const nested = parseAllowlist(entry);
      hosts.push(...nested.hosts);
      networks.push(...nested.networks);
      continue;
    }
    if (entry instanceof Set) {
      const nested = parseAllowlist(Array.from(entry));
      hosts.push(...nested.hosts);
      networks.push(...nested.networks);
      continue;
    }
    if (entry && typeof entry === "object") {
      // not specified by assay; ignore non-iterable objects
      continue;
    }
    const text = safeText(entry);
    if (!text) continue;
    if (text.includes("/")) {
      networks.push(parseCidr(text));
    } else {
      hosts.push(text.toLowerCase());
    }
  }
  return { hosts, networks };
}

function tryLoadAllowlistFile(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new SsrfError("SSRF allowlist configuration is unreadable.");
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new SsrfError("SSRF allowlist configuration is unreadable.");
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const values = obj.allow ?? obj.allowlist;
    if (Array.isArray(values)) {
      return values
        .filter((v): v is string | number | boolean | bigint => v !== null && v !== undefined)
        .map((v) => String(v));
    }
    if (typeof values === "string") {
      return values.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
    }
    return [];
  }
  return [];
}

export function loadAllowlist(root?: string | null): string[] {
  const entries: string[] = [];
  const env = safeText(process.env.QH_SSRF_ALLOWLIST);
  if (env) {
    entries.push(...env.split(",").map((v) => v.trim()).filter((v) => v.length > 0));
  }
  const envFile = safeText(process.env.QH_SSRF_ALLOWLIST_FILE);
  const paths: string[] = [];
  if (envFile) paths.push(envFile);
  if (root) {
    paths.push(path.join(root, ".harness", "ssrf-allowlist.json"));
    paths.push(path.join(root, "ssrf-allowlist.json"));
  }
  for (const p of paths) {
    entries.push(...tryLoadAllowlistFile(p));
  }
  return entries;
}

function isBlockedAddress(address: string, allowHosts: readonly string[], allowNetworks: readonly ParsedCidr[]): boolean {
  const info = ipToInt(address);
  if (!info) return true;
  if (allowNetworks.some((net) => ipInCidr(address, net))) return false;
  if (address === "169.254.169.254") return true;
  if (PARSED_DEFAULT_BLOCKED_NETWORKS.some((net) => ipInCidr(address, net))) return true;

  // Also honor Node/ipaddress-style flags where applicable via ranges not fully covered? defaults should cover.
  // Explicit private/loopback/link-local/multicast/reserved/unspecified semantics are represented in DEFAULT_BLOCKED_NETWORKS.
  void allowHosts;
  return false;
}

async function defaultResolver(hostname: string): Promise<string[]> {
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    const out: string[] = [];
    for (const r of results) {
      const addr = String(r.address);
      if (addr && !out.includes(addr)) out.push(addr);
    }
    if (out.length === 0) throw new SsrfError("Target host could not be resolved.");
    return out;
  } catch (error) {
    if (error instanceof SsrfError) throw error;
    throw new SsrfError("Target host could not be resolved.");
  }
}

export async function validateUrl(
  url: string,
  options?: {
    allowlist?: Iterable<unknown> | null;
    resolver?: Resolver | null;
    root?: string | null;
  },
): Promise<string> {
  const raw = String(url ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SsrfError("Target URL is missing a host.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfError("Target URL must use http or https.");
  }
  const host = (parsed.hostname || "").trim().toLowerCase();
  if (!host) {
    throw new SsrfError("Target URL is missing a host.");
  }

  let effectiveAllowlist = Array.from(options?.allowlist ?? []);
  if (effectiveAllowlist.length === 0 && options?.root != null) {
    effectiveAllowlist = loadAllowlist(options.root);
  }
  const { hosts: allowHosts, networks: allowNetworks } = parseAllowlist(effectiveAllowlist);

  if (BLOCKED_HOSTNAMES.has(host) && !allowHosts.includes(host)) {
    throw new SsrfError("Target host is not allowed.");
  }

  const hostAllowedByName = allowHosts.includes(host);
  const resolve = options?.resolver ?? defaultResolver;

  let addresses: string[];
  try {
    if (isIpLiteral(host)) {
      addresses = [host];
    } else {
      const resolved = await resolve(host);
      addresses = Array.isArray(resolved) ? resolved.map((a) => String(a)) : [];
    }
  } catch (error) {
    if (error instanceof SsrfError) throw error;
    throw new SsrfError("Target host could not be resolved.");
  }

  if (addresses.length === 0) {
    throw new SsrfError("Target host could not be resolved.");
  }

  for (const address of addresses) {
    if (hostAllowedByName) {
      const info = ipToInt(address);
      if (!info) {
        throw new SsrfError("Target host resolves to an invalid address.");
      }
      if (address === "169.254.169.254") {
        throw new SsrfError("Target host is not allowed.");
      }
      continue;
    }
    if (isBlockedAddress(address, allowHosts, allowNetworks)) {
      throw new SsrfError("Target host resolves to a blocked address.");
    }
  }

  return raw;
}

export async function validateRedirectChain(
  urls: Iterable<string>,
  options?: {
    allowlist?: Iterable<unknown> | null;
    resolver?: Resolver | null;
    root?: string | null;
  },
): Promise<void> {
  for (const url of urls) {
    await validateUrl(url, options);
  }
}

export async function isSafeUrl(
  url: string,
  options?: {
    allowlist?: Iterable<unknown> | null;
    resolver?: Resolver | null;
    root?: string | null;
  },
): Promise<boolean> {
  try {
    await validateUrl(url, options);
    return true;
  } catch (error) {
    if (error instanceof SsrfError) return false;
    throw error;
  }
}

// Compatibility aliases for callers that expect assay-like names.
export const validateTargetUrl = validateUrl;
export const ssrfSafe = isSafeUrl;
export { SsrfError };
