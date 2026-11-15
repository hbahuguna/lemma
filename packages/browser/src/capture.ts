import { redactText, redactUnknown, sanitizeUrl } from "@lemma/core";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
]);

const SENSITIVE_QUERY = new Set([
  "token",
  "access_token",
  "id_token",
  "api_key",
  "apikey",
  "secret",
  "password",
  "passwd",
  "session",
  "sessionid",
  "jwt",
  "auth",
  "code",
]);

export interface BrowserCaptureEvidenceStore {
  saveJson(
    name: string,
    payload: unknown,
    kind?: string,
    description?: string,
    checkId?: string,
  ): Promise<string> | string;
  saveBytes?(
    name: string,
    data: Uint8Array | Buffer,
    kind?: string,
    description?: string,
    checkId?: string,
    suffix?: string,
  ): Promise<string> | string;
  saveScreenshot?(
    name: string,
    data: Uint8Array | Buffer,
    description?: string,
    checkId?: string,
  ): Promise<string> | string;
}

function toNameString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function redactHeaders(headers: unknown): void {
  if (!Array.isArray(headers)) return;
  for (const header of headers) {
    if (!header || typeof header !== "object") continue;
    const rec = header as Record<string, unknown>;
    const name = toNameString(rec.name).toLowerCase();
    if (SENSITIVE_HEADERS.has(name)) {
      rec.value = "[REDACTED]";
    }
  }
}

function redactCookies(cookies: unknown): void {
  if (!Array.isArray(cookies)) return;
  for (const cookie of cookies) {
    if (cookie && typeof cookie === "object" && "value" in (cookie as Record<string, unknown>)) {
      (cookie as Record<string, unknown>).value = "[REDACTED]";
    }
  }
}

function redactQuery(items: unknown): void {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (SENSITIVE_QUERY.has(toNameString(rec.name).toLowerCase())) {
      rec.value = "[REDACTED]";
    }
  }
}

function visitHar(node: unknown): unknown {
  if (Array.isArray(node)) {
    for (const item of node) visitHar(item);
    return node;
  }
  if (!node || typeof node !== "object") return node;
  const rec = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(rec)) {
    if (key === "url" && typeof value === "string") {
      rec[key] = redactText(sanitizeUrl(value));
    } else if (typeof value === "string") {
      rec[key] = redactText(value);
    } else if (key === "headers") {
      redactHeaders(value);
      visitHar(value);
    } else if (key === "cookies") {
      redactCookies(value);
      visitHar(value);
    } else if (key === "queryString") {
      redactQuery(value);
      visitHar(value);
    } else {
      visitHar(value);
    }
  }
  return rec;
}

export function redactHarPayload(payload: unknown): unknown {
  // clone to avoid mutating caller unexpectedly
  const cloned = redactUnknown(payload);
  return visitHar(cloned);
}

export function redactTraceText(text: string): string {
  let out = redactText(text);
  out = out.replace(
    /("?(?:authorization|cookie|set-cookie|x-api-key|proxy-authorization)"?\s*[:=]\s*"?)[^"\n,}]{1,}/gi,
    "$1[REDACTED]",
  );
  out = out.replace(
    /("?(?:token|access_token|id_token|api_key|apikey|secret|password|passwd|session|sessionid|jwt|auth|code)"?\s*[:=\s]\s*"?)[^"\s&,}\n]{1,}/gi,
    "$1[REDACTED]",
  );
  return out;
}

/**
 * Best-effort redaction of Playwright trace zip bytes. Text entries are
 * redacted; binary entries are preserved. If the input is not a zip archive,
 * returns original bytes.
 */
export async function redactTraceBytes(data: Uint8Array | Buffer): Promise<Uint8Array> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  // Minimal zip parse/redact for stored text entries (Playwright traces are zip archives).
  return Promise.resolve(redactZipTextEntries(bytes));
}

function readUint16LE(buf: Uint8Array, off: number): number {
  return buf[off]! | (buf[off + 1]! << 8);
}
function readUint32LE(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>> 0;
}
function writeUint16LE(buf: Uint8Array, off: number, val: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
}
function writeUint32LE(buf: Uint8Array, off: number, val: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
  buf[off + 2] = (val >>> 16) & 0xff;
  buf[off + 3] = (val >>> 24) & 0xff;
}

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]!) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEOCD(buf: Uint8Array): number {
  // EOCD min 22 bytes, search backwards
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (readUint32LE(buf, i) === 0x06054b50) return i;
  }
  return -1;
}

function isProbablyText(buf: Uint8Array): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 512));
  let nonText = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 7 || (b > 13 && b < 32)) nonText++;
  }
  return nonText / Math.max(1, sample.length) < 0.1;
}

function redactZipTextEntries(input: Uint8Array): Uint8Array {
  try {
    const eocd = findEOCD(input);
    if (eocd < 0) return input;
    const cdCount = readUint16LE(input, eocd + 10);
    readUint32LE(input, eocd + 12); // cdSize (unused)
    const cdOffset = readUint32LE(input, eocd + 16);

    type Entry = {
      name: Uint8Array;
      extra: Uint8Array;
      comment: Uint8Array;
      flags: number;
      method: number;
      time: number;
      date: number;
      crc: number;
      compSize: number;
      uncompSize: number;
      localExtra: Uint8Array;
      data: Uint8Array;
    };
    const entries: Entry[] = [];
    let p = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (readUint32LE(input, p) !== 0x02014b50) return input;
      const flags = readUint16LE(input, p + 8);
      const method = readUint16LE(input, p + 10);
      const time = readUint16LE(input, p + 12);
      const date = readUint16LE(input, p + 14);
      const crc = readUint32LE(input, p + 16);
      const compSize = readUint32LE(input, p + 20);
      const uncompSize = readUint32LE(input, p + 24);
      const nameLen = readUint16LE(input, p + 28);
      const extraLen = readUint16LE(input, p + 30);
      const commentLen = readUint16LE(input, p + 32);
      const localOff = readUint32LE(input, p + 42);
      const name = input.slice(p + 46, p + 46 + nameLen);
      const extra = input.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      const comment = input.slice(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen);
      if (readUint32LE(input, localOff) !== 0x04034b50) return input;
      const lhNameLen = readUint16LE(input, localOff + 26);
      const lhExtraLen = readUint16LE(input, localOff + 28);
      const localExtra = input.slice(localOff + 30 + lhNameLen, localOff + 30 + lhNameLen + lhExtraLen);
      const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
      const data = input.slice(dataStart, dataStart + compSize);
      let outData = data;
      let outCrc = crc;
      let outComp = compSize;
      let outUncomp = uncompSize;
      // Only redact stored (method 0) text entries to keep implementation safe/deterministic.
      if (method === 0 && isProbablyText(data)) {
        const text = new TextDecoder().decode(data);
        const redacted = redactTraceText(text);
        if (redacted !== text) {
          outData = new TextEncoder().encode(redacted);
          outCrc = crc32(outData);
          outComp = outData.length;
          outUncomp = outData.length;
        }
      }
      entries.push({ name, extra, comment, flags, method, time, date, crc: outCrc, compSize: outComp, uncompSize: outUncomp, localExtra, data: outData });
      p += 46 + nameLen + extraLen + commentLen;
    }

    // Rebuild archive
    const chunks: Uint8Array[] = [];
    const localOffsets: number[] = [];
    let offset = 0;
    for (const e of entries) {
      localOffsets.push(offset);
      const lh = new Uint8Array(30 + e.name.length + e.localExtra.length);
      writeUint32LE(lh, 0, 0x04034b50);
      writeUint16LE(lh, 4, 20);
      writeUint16LE(lh, 6, e.flags);
      writeUint16LE(lh, 8, e.method);
      writeUint16LE(lh, 10, e.time);
      writeUint16LE(lh, 12, e.date);
      writeUint32LE(lh, 14, e.crc);
      writeUint32LE(lh, 18, e.compSize);
      writeUint32LE(lh, 22, e.uncompSize);
      writeUint16LE(lh, 26, e.name.length);
      writeUint16LE(lh, 28, e.localExtra.length);
      lh.set(e.name, 30);
      lh.set(e.localExtra, 30 + e.name.length);
      chunks.push(lh, e.data);
      offset += lh.length + e.data.length;
    }
    const cdStart = offset;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const cd = new Uint8Array(46 + e.name.length + e.extra.length + e.comment.length);
      writeUint32LE(cd, 0, 0x02014b50);
      writeUint16LE(cd, 4, 20);
      writeUint16LE(cd, 6, 20);
      writeUint16LE(cd, 8, e.flags);
      writeUint16LE(cd, 10, e.method);
      writeUint16LE(cd, 12, e.time);
      writeUint16LE(cd, 14, e.date);
      writeUint32LE(cd, 16, e.crc);
      writeUint32LE(cd, 20, e.compSize);
      writeUint32LE(cd, 24, e.uncompSize);
      writeUint16LE(cd, 28, e.name.length);
      writeUint16LE(cd, 30, e.extra.length);
      writeUint16LE(cd, 32, e.comment.length);
      writeUint16LE(cd, 34, 0);
      writeUint16LE(cd, 36, 0);
      writeUint32LE(cd, 38, 0);
      writeUint32LE(cd, 42, localOffsets[i]!);
      cd.set(e.name, 46);
      cd.set(e.extra, 46 + e.name.length);
      cd.set(e.comment, 46 + e.name.length + e.extra.length);
      chunks.push(cd);
      offset += cd.length;
    }
    const cdEnd = offset;
    const eocdBuf = new Uint8Array(22);
    writeUint32LE(eocdBuf, 0, 0x06054b50);
    writeUint16LE(eocdBuf, 4, 0);
    writeUint16LE(eocdBuf, 6, 0);
    writeUint16LE(eocdBuf, 8, entries.length);
    writeUint16LE(eocdBuf, 10, entries.length);
    writeUint32LE(eocdBuf, 12, cdEnd - cdStart);
    writeUint32LE(eocdBuf, 16, cdStart);
    writeUint16LE(eocdBuf, 20, 0);
    chunks.push(eocdBuf);

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  } catch {
    return input;
  }
}
