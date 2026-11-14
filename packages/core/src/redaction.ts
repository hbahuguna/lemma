const SENSITIVE_URL_KEYS = [
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "key",
  "api_key",
  "apikey",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "code",
  "session",
  "sessionid",
  "jwt",
  "auth",
  "authorization",
  "signature",
  "sig",
  "cookie",
] as const;

function hasSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_URL_KEYS.some((token) => lower.includes(token));
}

export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (hasSensitiveKey(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    // redact credentials in userinfo
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "[REDACTED]" : "";
      parsed.password = parsed.password ? "[REDACTED]" : "";
    }
    return parsed.toString();
  } catch {
    // fallback: simple query redaction without throwing; avoid leaking on parse errors
    return String(url).replace(
      /([?&])(token|access_token|id_token|refresh_token|key|api_key|apikey|secret|client_secret|password|passwd|code|session|sessionid|jwt|auth|authorization|signature|sig|cookie)=([^&#]*)/gi,
      "$1$2=[REDACTED]",
    );
  }
}

type Replacer = (substring: string, ...args: string[]) => string;
type Pattern = { re: RegExp; replace: string | Replacer };

// Order matters: specific/high-signal patterns first.
const TEXT_PATTERNS: Pattern[] = [
  // Private/SSH keys
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "[REDACTED_PRIVATE_KEY]" },
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replace: "[REDACTED_PRIVATE_KEY]" },

  // Connection strings with credentials
  { re: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, replace: "$1[REDACTED]:[REDACTED]@" },

  // Authorization/Cookie/Set-Cookie style headers and inline assignments
  { re: /\b(Authorization\s*[:=]\s*Bearer\s+)[^\s,"'`]+/gi, replace: "$1[REDACTED]" },
  { re: /\b(Authorization\s*[:=]\s*Basic\s+)[^\s,"'`]+/gi, replace: "$1[REDACTED]" },
  { re: /\b(Proxy-Authorization\s*[:=]\s*(?:Bearer|Basic)\s+)[^\s,"'`]+/gi, replace: "$1[REDACTED]" },
  { re: /\b((?:Cookie|Set-Cookie)\s*[:=]\s*)([^\r\n]+)/gi, replace: (_m, p1: string) => `${p1}[REDACTED]` },
  { re: /\b(atlassian\.xsrf\.token|cloud\.session\.token|sessionid|session|sid)\s*=\s*([^;\s,"'`]+)/gi, replace: "$1=[REDACTED]" },

  // Named secrets in key/value text
  {
    re: /\b(password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?key|accountkey|token|id_token|access_token|refresh_token|auth_token)\b\s*[:=]\s*("([^"]*)"|'([^']*)'|`([^`]*)`|[^\s,;]+)/gi,
    replace: (_m: string, key: string) => `${key}=[REDACTED]`,
  },

  // JSON/storage-state style "value": "..." for sensitive names
  {
    re: /("?(?:password|passwd|secret|client_secret|api[_-]?key|access[_-]?key|token|id_token|access_token|refresh_token|auth_token|session|cookie|authorization|accountkey)"?\s*[:=]\s*")([^"]*)(")/gi,
    replace: "$1[REDACTED]$3",
  },
  {
    re: /("name"\s*:\s*"(?:session|auth_token|token|password|secret|cookie|authorization|sid)"\s*,\s*"value"\s*:\s*")([^"]*)(")/gi,
    replace: "$1[REDACTED]$3",
  },

  // JWTs and bearer-like tokens
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: "[REDACTED_JWT]" },

  // Common token/key prefixes
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED_AWS_KEY]" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: "[REDACTED_API_KEY]" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED_TOKEN]" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: "[REDACTED_TOKEN]" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED_TOKEN]" },
  { re: /\bnpm_[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED_TOKEN]" },
  { re: /\bpypi-[A-Za-z0-9_-]{20,}\b/g, replace: "[REDACTED_TOKEN]" },
  { re: /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, replace: "https://hooks.slack.com/services/[REDACTED]" },

  // Azure-style AccountKey values
  { re: /\b(AccountKey=)([^\s;"']+)/gi, replace: "$1[REDACTED]" },
];

export function redactText(value: string): string {
  if (typeof value !== "string" || value.length === 0) return value;
  let text = value;
  // multiple passes for overlapping patterns/idempotence stability
  for (let pass = 0; pass < 3; pass++) {
    const before = text;
    for (const { re, replace } of TEXT_PATTERNS) {
      re.lastIndex = 0;
      text = text.replace(re, replace as string & Replacer);
    }
    if (text === before) break;
  }
  return text;
}

export function redactSecretValue(value: string): string {
  const trimmed = String(value).trim();
  if (trimmed.length <= 6) return "[REDACTED]";
  return `${trimmed.slice(0, 4)}…[REDACTED ${trimmed.length} chars]`;
}

export function redactUnknown(value: unknown, keyHint = ""): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (hasSensitiveKey(keyHint)) return "[REDACTED]";
    // also sanitize URLs embedded in strings
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        return redactText(sanitizeUrl(trimmed));
      } catch {
        // fall through
      }
    }
    return redactText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (hasSensitiveKey(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactUnknown(v, k);
      }
    }
    return out;
  }
  if (typeof value === "symbol") return redactText(value.toString());
  if (typeof value === "bigint") return redactText(value.toString());
  if (typeof value === "function") return "[REDACTED]";
  try {
    return redactText(JSON.stringify(value));
  } catch {
    return "[REDACTED]";
  }
}

export function containsRedactionMarker(value: string): boolean {
  return /\[REDACTED(?:_[A-Z_]+)?(?: [^\]]+)?\]/.test(value);
}
