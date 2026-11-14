import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { EvidenceStore } from "./evidence.js";
import { CheckOutcome, CheckStatus, Severity, Strength } from "./models.js";

export const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".harness",
  ".lemma",
  ".venv",
  "venv",
  "env",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
  ".ruff_cache",
  ".next",
  ".nuxt",
  "coverage",
  "htmlcov",
  ".idea",
  ".vscode",
]);

export const LANGUAGE_BY_EXT: Record<string, string> = {
  ".py": "Python",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".go": "Go",
  ".java": "Java",
  ".kt": "Kotlin",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".rs": "Rust",
  ".swift": "Swift",
  ".scala": "Scala",
  ".sh": "Shell",
  ".html": "HTML",
  ".htm": "HTML",
  ".css": "CSS",
  ".scss": "CSS",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".sql": "SQL",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".json": "JSON",
  ".toml": "TOML",
  ".md": "Markdown",
};

export const CODE_EXTENSIONS = new Set([
  ".py",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".rs",
  ".swift",
  ".scala",
  ".vue",
  ".svelte",
  ".sh",
  ".sql",
]);

export const MARKUP_EXTENSIONS = new Set([".html", ".htm", ".jsx", ".tsx", ".vue", ".svelte"]);

export const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
]);

export const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
]);

export const CI_NAMES = new Set([
  ".gitlab-ci.yml",
  "Jenkinsfile",
  "azure-pipelines.yml",
  ".travis.yml",
  "bitbucket-pipelines.yml",
  "appveyor.yml",
  ".drone.yml",
]);

export const ENV_NAMES = new Set([".env", ".env.local", ".env.production", ".env.staging", ".env.development"]);
export const TEST_HINTS = ["test", "spec", "__tests__", "tests", "e2e", "fixture"];

export const MAX_SCAN_BYTES = 512 * 1024;
export const MAX_SCAN_FILES = 2000;
export const MAX_INVENTORY_FILES = 5000;

// Issue markers are inventoried for the issues category. Counts only are
// persisted, so an inline note cannot leak a credential into evidence.
export const ISSUE_MARKER_PATTERN = /\b(TODO|FIXME|HACK|XXX)\b/g;

// Extended "more" assessment surfaces are inventoried as deterministic counts
// and paths/names only; no file contents are persisted.
export const MORE_DOC_HINTS = new Set([
  "readme",
  "contributing",
  "changelog",
  "changes",
  "license",
  "security",
  "support",
  "code_of_conduct",
  "architecture",
]);
export const MORE_EXAMPLE_HINTS = new Set(["example", "examples", "sample", "samples", "fixture", "fixtures"]);
export const MORE_CONFIG_NAMES = new Set([
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "makefile",
  "justfile",
  "tox.ini",
  "pyproject.toml",
  "package.json",
  "tsconfig.json",
  "webpack.config.js",
  "vite.config.js",
  "vite.config.ts",
  ".eslintrc",
  ".prettierrc",
]);

// Demo/example surfaces are inventoried for the demo category. Only paths and
// entry-point names are persisted, never file contents.
export const DEMO_HINTS = new Set([
  "demo",
  "demos",
  "example",
  "examples",
  "sample",
  "samples",
  "sandbox",
  "playground",
  "quickstart",
]);
export const DEMO_DOC_HINTS = ["quickstart", "getting started", "run the demo", "demo"];
export const DEMO_SCRIPT_NAMES = new Set(["demo", "start", "dev"]);

export interface InventoryData {
  available: boolean;
  root: string;
  files: string[];
  source_files: string[];
  markup_files: string[];
  manifests: string[];
  test_files: string[];
  ci_files: string[];
  lockfiles: string[];
  env_files: string[];
  languages: Record<string, number>;
  total_files: number;
  total_bytes: number;
  truncated: boolean;
  skipped_dirs: string[];
  test_frameworks: string[];
  tracked_available: boolean;
  tracked_file_count: number;
  env_files_tracked: string[];
  env_files_ignored: string[];
  excluded_patterns: string[];
  excluded_paths: string[];
  excluded_file_count: number;
  has_manifest?: boolean;
  has_markup?: boolean;
  has_tests?: boolean;
  has_ci?: boolean;
  has_lockfile?: boolean;
  [key: string]: unknown;
}

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  // simple fnmatch-like glob: *, ?, ** (treated as *)
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += escapeRegex(ch);
    }
  }
  re += "$";
  return new RegExp(re);
}

function patternMatches(rel: string, pattern: string): boolean {
  let p = pattern.replace(/^\/+/, "");
  if (p.endsWith("/")) p = p.replace(/\/+$/, "");
  if (!p) return false;
  if (p.includes("/")) {
    if (rel === p || rel.startsWith(p + "/")) return true;
    return globToRegex(p).test(rel);
  }
  const parts = rel.split("/");
  const rx = globToRegex(p);
  return parts.some((part) => rx.test(part));
}

function defaultIgnoreFiles(root: string): string[] {
  // Canonical lemma scoping file with assay .harnessignore compatibility alias.
  for (const name of [".lemmaignore", ".harnessignore"]) {
    const full = path.join(root, name);
    if (existsSync(full)) return [full];
  }
  return [];
}

export interface SourceInspectorOptions {
  maxFiles?: number;
  ignoreFiles?: string[];
}

export class SourceInspector {
  readonly root: string;
  readonly maxFiles: number;
  readonly excludePatterns: string[];
  readonly hasNegations: boolean;

  constructor(root: string, options: SourceInspectorOptions = {}) {
    this.root = path.resolve(root);
    this.maxFiles = options.maxFiles ?? MAX_INVENTORY_FILES;
    this.excludePatterns = this.loadExcludePatterns(options.ignoreFiles);
    this.hasNegations = this.excludePatterns.some((p) => p.startsWith("!"));
  }

  private loadExcludePatterns(explicit?: string[]): string[] {
    const files = explicit && explicit.length > 0 ? explicit : defaultIgnoreFiles(this.root);
    const patterns: string[] = [];
    for (const file of files) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        const stripped = line.trim();
        if (!stripped || stripped.startsWith("#")) continue;
        patterns.push(stripped);
      }
    }
    return patterns;
  }

  isExcluded(relPath: string): boolean {
    let rel = relPath.replace(/\\/g, "/");
    if (rel.startsWith("./")) rel = rel.slice(2);
    let excluded = false;
    for (const pattern of this.excludePatterns) {
      const negate = pattern.startsWith("!");
      const candidate = negate ? pattern.slice(1).trim() : pattern;
      if (!candidate) continue;
      if (patternMatches(rel, candidate)) excluded = !negate;
    }
    return excluded;
  }

  private gitTrackedFiles(): Set<string> | null {
    try {
      const result = spawnSync("git", ["-C", this.root, "ls-files", "-z"], {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.error) return null;
      if (result.status !== 0) return null;
      const stdout = result.stdout;
      if (!stdout) return new Set();
      const text = stdout.toString("utf8");
      return new Set(text.split("\0").filter((s) => s.length > 0));
    } catch {
      return null;
    }
  }

  private readManifestText(fullPath: string): string {
    try {
      const st = statSync(fullPath);
      if (st.size > MAX_SCAN_BYTES) return "";
      const buf = readFileSync(fullPath);
      if (buf.subarray(0, 2048).includes(0)) return "";
      return buf.toString("utf8");
    } catch {
      return "";
    }
  }

  private detectFrameworks(manifests: string[], testFiles: string[]): string[] {
    let blob = "";
    for (const rel of manifests) {
      blob += this.readManifestText(path.join(this.root, rel)).toLowerCase() + "\n";
    }
    const found: string[] = [];
    for (const name of [
      "pytest",
      "unittest",
      "jest",
      "vitest",
      "mocha",
      "playwright",
      "cypress",
      "@testing-library",
      "ava",
      "rspec",
      "minitest",
      "junit",
      "tox",
      "nox",
    ]) {
      if (blob.includes(name) && !found.includes(name)) found.push(name);
    }
    if (testFiles.some((rel) => rel.endsWith("_test.go"))) found.push("go test");
    if (manifests.some((m) => m.toLowerCase().includes("cargo")) && testFiles.length > 0) {
      found.push("cargo test");
    }
    return found;
  }

  discover(): InventoryData {
    const inventory: InventoryData = {
      available: true,
      root: this.root,
      files: [],
      source_files: [],
      markup_files: [],
      manifests: [],
      test_files: [],
      ci_files: [],
      lockfiles: [],
      env_files: [],
      languages: {},
      total_files: 0,
      total_bytes: 0,
      truncated: false,
      skipped_dirs: [],
      test_frameworks: [],
      tracked_available: false,
      tracked_file_count: 0,
      env_files_tracked: [],
      env_files_ignored: [],
      excluded_patterns: [...this.excludePatterns],
      excluded_paths: [],
      excluded_file_count: 0,
    };

    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(this.root);
    } catch {
      inventory.available = false;
      return this.finalize(inventory);
    }
    if (!st.isDirectory()) {
      inventory.available = false;
      return this.finalize(inventory);
    }

    const tracked = this.gitTrackedFiles();
    if (tracked !== null) {
      inventory.tracked_available = true;
      inventory.tracked_file_count = tracked.size;
    }

    let count = 0;
    let totalBytes = 0;

    const walk = (dir: string, relDir: string): void => {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir).sort();
      } catch {
        return;
      }
      const subdirs: string[] = [];
      const files: string[] = [];
      for (const name of entries) {
        const full = path.join(dir, name);
        let est: ReturnType<typeof statSync>;
        try {
          est = statSync(full);
        } catch {
          continue;
        }
        if (est.isDirectory()) subdirs.push(name);
        else if (est.isFile()) files.push(name);
      }

      for (const name of subdirs) {
        const rel = relDir ? `${relDir}/${name}` : name;
        if (SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".github" && name !== ".circleci")) {
          inventory.skipped_dirs.push(rel);
          continue;
        }
        const excludedDir = this.isExcluded(rel);
        if (excludedDir) {
          if (!inventory.excluded_paths.includes(rel) && inventory.excluded_paths.length < 20) {
            inventory.excluded_paths.push(rel);
          }
        }
        // if negations exist, must still descend because a descendant may be re-included
        if (!excludedDir || this.hasNegations) {
          walk(path.join(dir, name), rel);
        }
      }

      for (const fileName of files) {
        const rel = relDir ? `${relDir}/${fileName}` : fileName;
        const full = path.join(dir, fileName);
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          continue;
        }
        if (this.isExcluded(rel)) {
          inventory.excluded_file_count += 1;
          if (!inventory.excluded_paths.includes(rel) && inventory.excluded_paths.length < 20) {
            inventory.excluded_paths.push(rel);
          }
          continue;
        }

        count += 1;
        totalBytes += size;
        if (count <= this.maxFiles) inventory.files.push(rel);
        else inventory.truncated = true;

        const ext = path.extname(fileName).toLowerCase();
        const language = LANGUAGE_BY_EXT[ext];
        if (language) {
          inventory.languages[language] = (inventory.languages[language] ?? 0) + 1;
        }
        if (MANIFEST_NAMES.has(fileName)) inventory.manifests.push(rel);
        if (LOCKFILE_NAMES.has(fileName)) inventory.lockfiles.push(rel);
        if (CI_NAMES.has(fileName) && !rel.includes("/")) inventory.ci_files.push(rel);
        if (ENV_NAMES.has(fileName)) inventory.env_files.push(rel);
        if (rel.startsWith(".github/workflows/") && (ext === ".yml" || ext === ".yaml")) {
          inventory.ci_files.push(rel);
        }
        if (CODE_EXTENSIONS.has(ext) || MARKUP_EXTENSIONS.has(ext)) {
          inventory.source_files.push(rel);
        }
        if (MARKUP_EXTENSIONS.has(ext)) inventory.markup_files.push(rel);

        const lower = rel.toLowerCase();
        const isTestLike =
          fileName.startsWith("test_") ||
          fileName.endsWith("_test.py") ||
          fileName.endsWith("_test.go") ||
          fileName.includes(".test.") ||
          fileName.includes(".spec.") ||
          TEST_HINTS.some((hint) => lower.includes(hint));
        if (isTestLike && (CODE_EXTENSIONS.has(ext) || MARKUP_EXTENSIONS.has(ext))) {
          if (!inventory.test_files.includes(rel)) inventory.test_files.push(rel);
        }
      }
    };

    walk(this.root, "");

    if (tracked !== null) {
      inventory.env_files_tracked = inventory.env_files.filter((rel) => tracked.has(rel));
      inventory.env_files_ignored = inventory.env_files.filter((rel) => !tracked.has(rel));
      inventory.ci_files = inventory.ci_files.filter((rel) => tracked.has(rel));
    }

    inventory.total_files = count;
    inventory.total_bytes = totalBytes;
    return this.finalize(inventory);
  }

  private finalize(inventory: InventoryData): InventoryData {
    inventory.files = [...inventory.files].sort();
    inventory.source_files = [...inventory.source_files].sort().slice(0, 5000);
    inventory.markup_files = [...inventory.markup_files].sort().slice(0, 1000);
    inventory.test_files = [...inventory.test_files].sort().slice(0, 500);
    inventory.manifests = [...inventory.manifests].sort().slice(0, 200);
    inventory.ci_files = [...new Set(inventory.ci_files)].sort().slice(0, 100);
    inventory.lockfiles = [...new Set(inventory.lockfiles)].sort().slice(0, 100);
    inventory.env_files = [...new Set(inventory.env_files)].sort().slice(0, 50);
    inventory.env_files_tracked = [...new Set(inventory.env_files_tracked)].sort().slice(0, 50);
    inventory.env_files_ignored = [...new Set(inventory.env_files_ignored)].sort().slice(0, 50);
    inventory.skipped_dirs = [...new Set(inventory.skipped_dirs)].sort();
    inventory.test_frameworks = this.detectFrameworks(inventory.manifests, inventory.test_files);
    inventory.has_manifest = inventory.manifests.length > 0;
    inventory.has_markup = inventory.markup_files.length > 0;
    inventory.has_tests = inventory.test_files.length > 0;
    inventory.has_ci = inventory.ci_files.length > 0;
    inventory.has_lockfile = inventory.lockfiles.length > 0;
    return inventory;
  }
}

export function inventoryFromDict(data: Record<string, unknown>): InventoryData {
  const inv: InventoryData = {
    available: Boolean(data.available),
    root: typeof data.root === "string" ? data.root : "",
    files: Array.isArray(data.files) ? data.files.filter((x): x is string => typeof x === "string") : [],
    source_files: Array.isArray(data.source_files) ? data.source_files.filter((x): x is string => typeof x === "string") : [],
    markup_files: Array.isArray(data.markup_files) ? data.markup_files.filter((x): x is string => typeof x === "string") : [],
    manifests: Array.isArray(data.manifests) ? data.manifests.filter((x): x is string => typeof x === "string") : [],
    test_files: Array.isArray(data.test_files) ? data.test_files.filter((x): x is string => typeof x === "string") : [],
    ci_files: Array.isArray(data.ci_files) ? data.ci_files.filter((x): x is string => typeof x === "string") : [],
    lockfiles: Array.isArray(data.lockfiles) ? data.lockfiles.filter((x): x is string => typeof x === "string") : [],
    env_files: Array.isArray(data.env_files) ? data.env_files.filter((x): x is string => typeof x === "string") : [],
    languages: data.languages && typeof data.languages === "object" ? (data.languages as Record<string, number>) : {},
    total_files: typeof data.total_files === "number" ? data.total_files : 0,
    total_bytes: typeof data.total_bytes === "number" ? data.total_bytes : 0,
    truncated: Boolean(data.truncated),
    skipped_dirs: Array.isArray(data.skipped_dirs) ? data.skipped_dirs.filter((x): x is string => typeof x === "string") : [],
    test_frameworks: Array.isArray(data.test_frameworks) ? data.test_frameworks.filter((x): x is string => typeof x === "string") : [],
    tracked_available: Boolean(data.tracked_available),
    tracked_file_count: typeof data.tracked_file_count === "number" ? data.tracked_file_count : 0,
    env_files_tracked: Array.isArray(data.env_files_tracked) ? data.env_files_tracked.filter((x): x is string => typeof x === "string") : [],
    env_files_ignored: Array.isArray(data.env_files_ignored) ? data.env_files_ignored.filter((x): x is string => typeof x === "string") : [],
    excluded_patterns: Array.isArray(data.excluded_patterns) ? data.excluded_patterns.filter((x): x is string => typeof x === "string") : [],
    excluded_paths: Array.isArray(data.excluded_paths) ? data.excluded_paths.filter((x): x is string => typeof x === "string") : [],
    excluded_file_count: typeof data.excluded_file_count === "number" ? data.excluded_file_count : 0,
    ...data,
  };
  inv.has_manifest = Boolean(inv.has_manifest ?? inv.manifests.length > 0);
  inv.has_markup = Boolean(inv.has_markup ?? inv.markup_files.length > 0);
  inv.has_tests = Boolean(inv.has_tests ?? inv.test_files.length > 0);
  inv.has_ci = Boolean(inv.has_ci ?? inv.ci_files.length > 0);
  inv.has_lockfile = Boolean(inv.has_lockfile ?? inv.lockfiles.length > 0);
  return inv;
}

export interface StaticCheckLike {
  id: string;
  [key: string]: unknown;
}

function isTestPath(rel: string): boolean {
  const lower = rel.toLowerCase();
  return TEST_HINTS.some((hint) => lower.includes(hint));
}

function downgradeSeverity(severity: string, rel: string): string {
  if (!isTestPath(rel)) return severity;
  const order = [
    Severity.CRITICAL,
    Severity.HIGH,
    Severity.MEDIUM,
    Severity.LOW,
    Severity.INFO,
  ] as string[];
  const index = order.indexOf(severity);
  if (index === -1 || index >= order.length - 1) return severity;
  return order[index + 1] ?? severity;
}

export interface A11yRule {
  id: string;
  pattern: RegExp;
  severity: string;
  title: string;
  consequence: string;
  remediation: string;
  verification: string;
}

export interface SecretRule {
  id: string;
  pattern: RegExp;
  severity: string;
  title: string;
  consequence: string;
  remediation: string;
  verification: string;
}

function entropy(value: string): number {
  if (!value) return 0.0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const length = value.length;
  let total = 0;
  for (const count of counts.values()) {
    const p = count / length;
    total -= p * Math.log2(p);
  }
  return total;
}

function isTestCredentialFixture(value: string, rel: string): boolean {
  if (!isTestPath(rel)) return false;
  const lower = value.toLowerCase();
  return (
    lower.startsWith("sk_test") ||
    lower.startsWith("pk_test") ||
    lower.startsWith("whsec_test") ||
    lower.startsWith("test-") ||
    lower.startsWith("test_") ||
    lower.startsWith("dummy-") ||
    lower.startsWith("dummy_") ||
    lower.startsWith("llm-") ||
    lower.startsWith("ambient-")
  );
}

export function looksPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  const placeholders = [
    "example",
    "sample",
    "dummy",
    "changeme",
    "change_me",
    "your_",
    "your-",
    "placeholder",
    "xxx",
    "****",
    "...",
    "process.env",
    "os.environ",
    "getenv",
    "${",
    "<",
    ">",
    "redacted",
    "sk_test",
    "pk_test",
    "whsec_test",
    "test-key",
    "test_key",
    "opencode-test",
    "fake",
    "mock",
  ];
  return placeholders.some((token) => lower.includes(token));
}

export function redactSecret(value: string): string {
  value = value.trim();
  if (value.length <= 6) return "[REDACTED]";
  return `${value.slice(0, 4)}…[REDACTED ${value.length} chars]`;
}

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
    severity: Severity.CRITICAL,
    title: "Private key material committed to the repository",
    consequence: "Anyone with repository access can impersonate the key holder or decrypt protected traffic.",
    remediation: "Revoke the key, remove it from history, rotate dependent secrets, and load the replacement from a secret manager.",
    verification: "Re-scan the repository and its history; confirm the key is revoked and no live copy remains.",
  },
  {
    id: "stripe-live",
    pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/,
    severity: Severity.CRITICAL,
    title: "Live payment provider secret is present in source",
    consequence: "A leaked live key can move money, read customer data, or disrupt billing.",
    remediation: "Roll the key immediately, inspect provider audit logs, and move the secret to a managed vault.",
    verification: "Confirm the old key is revoked and the application uses the vault-backed replacement.",
  },
  {
    id: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    severity: Severity.HIGH,
    title: "Cloud access key identifier committed to the repository",
    consequence: "A matching secret could grant cloud account access and data exfiltration.",
    remediation: "Disable the key, review cloud audit logs, and use short-lived role credentials.",
    verification: "Confirm the key is inactive and identify any unexpected API activity.",
  },
  {
    id: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    severity: Severity.HIGH,
    title: "Source-host access token committed to the repository",
    consequence: "The token may permit repository, package, or workflow changes.",
    remediation: "Revoke the token, review organization audit logs, and reissue with least privilege.",
    verification: "Confirm the token is revoked and no unexpected workflow or repository changes occurred.",
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    severity: Severity.HIGH,
    title: "Chat integration token committed to the repository",
    consequence: "The token may allow message access or impersonation in a workspace.",
    remediation: "Revoke the token and use a workspace-scoped secret store.",
    verification: "Confirm revocation and review workspace audit events.",
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/,
    severity: Severity.HIGH,
    title: "Cloud API key committed to the repository",
    consequence: "An unrestricted key may permit billable API calls or data access.",
    remediation: "Restrict or rotate the key and move it to a secret manager.",
    verification: "Confirm restrictions, rotation, and no unexpected quota usage.",
  },
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    severity: Severity.MEDIUM,
    title: "Serialized token embedded in source",
    consequence: "A live token may grant a session or service identity beyond the test environment.",
    remediation: "Confirm whether the token is live; revoke it and replace it with runtime-injected credentials.",
    verification: "Decode the token claims, confirm expiry/revocation, and re-scan.",
  },
  {
    id: "generic-credential",
    pattern: /\b(api[_-]?key|secret|token|password|passwd|client[_-]?secret|access[_-]?key)\b\s*[:=]\s*['"]([^'"]{8,})['"]/i,
    severity: Severity.HIGH,
    title: "Credential-like value hard-coded in source",
    consequence: "The value may grant access to a service, environment, or customer record.",
    remediation: "Move the value to a secret manager, rotate it, and add a pre-commit secret scan.",
    verification: "Confirm the value is no longer present and that the old credential is invalid.",
  },
];

export interface UnsafeRule {
  id: string;
  pattern: RegExp;
  severity: string;
  title: string;
  consequence: string;
  remediation: string;
  verification: string;
}

export const UNSAFE_RULES: readonly UnsafeRule[] = [
  {
    id: "eval",
    // Do not treat member calls such as RegExp.exec(), db.exec(), or
    // child_process.exec() as the bare Python eval/exec primitive.
    pattern: /(?<![\w.])(?:eval|exec)\s*\(/,
    severity: Severity.HIGH,
    title: "Dynamic code execution primitive",
    consequence: "Untrusted input can become arbitrary code execution.",
    remediation: "Remove eval/exec, parse a constrained format, or isolate execution in a sandbox.",
    verification: "Add an adversarial input test and confirm the code path rejects it.",
  },
  {
    id: "node-child-process-exec",
    pattern: /\bchild_process\.(?:exec|execSync)\s*\(/,
    severity: Severity.HIGH,
    title: "Node child_process command execution",
    consequence: "Concatenated input can become arbitrary operating-system command execution.",
    remediation: "Use execFile/spawn with an argument array and validate every argument.",
    verification: "Exercise shell metacharacters and confirm they are treated as data.",
  },
  {
    id: "shell-true",
    pattern: /shell\s*=\s*True/,
    severity: Severity.HIGH,
    title: "Shell command constructed with shell=True",
    consequence: "User-controlled arguments can inject operating-system commands.",
    remediation: "Pass an argument vector with shell=False and validate each argument.",
    verification: "Exercise metacharacters and confirm they are treated as data.",
  },
  {
    id: "os-system",
    pattern: /\bos\.system\s*\(/,
    severity: Severity.HIGH,
    title: "Unsafe operating-system command execution",
    consequence: "Concatenated input can execute arbitrary commands.",
    remediation: "Use subprocess with an argument list and strict validation.",
    verification: "Test shell metacharacters and path traversal inputs.",
  },
  {
    id: "inner-html",
    pattern: /\.innerHTML\s*=/,
    severity: Severity.MEDIUM,
    title: "HTML assigned through innerHTML",
    consequence: "Untrusted content can become script in the customer's browser.",
    remediation: "Use a safe DOM API or a reviewed sanitizer with a strict policy.",
    verification: "Add an XSS payload test and confirm it renders as text.",
  },
  {
    id: "dangerous-html",
    pattern: /dangerouslySetInnerHTML/,
    severity: Severity.MEDIUM,
    title: "React raw HTML injection point",
    consequence: "Unsanitized content can execute script in the customer's browser.",
    remediation: "Render structured content or sanitize with a maintained allowlist.",
    verification: "Test script, event-handler, and URL payloads.",
  },
  {
    id: "tls-verify-off",
    pattern: /verify\s*=\s*False/,
    severity: Severity.HIGH,
    title: "TLS certificate verification disabled",
    consequence: "A network attacker can impersonate the upstream service and read or alter traffic.",
    remediation: "Enable certificate verification and configure a trusted CA bundle.",
    verification: "Confirm a bad certificate is rejected in a test environment.",
  },
  {
    id: "pickle-loads",
    pattern: /\bpickle\.loads?\s*\(/,
    severity: Severity.HIGH,
    title: "Untrusted pickle deserialization",
    consequence: "A crafted payload can execute arbitrary code during deserialization.",
    remediation: "Use a data-only format such as JSON with an explicit schema.",
    verification: "Send a malicious object and confirm it is rejected before deserialization.",
  },
  {
    id: "cors-wildcard",
    pattern: /access-control-allow-origin['"]?\s*[:=]\s*['"]\*['"]/i,
    severity: Severity.MEDIUM,
    title: "Wildcard cross-origin access policy",
    consequence: "Any website can read responses that were intended for a trusted origin.",
    remediation: "Use an explicit allowlist and keep credentials out of wildcard responses.",
    verification: "Send requests from an untrusted origin and confirm they are rejected.",
  },
  {
    id: "debug-true",
    pattern: /\bdebug\s*=\s*True\b/i,
    severity: Severity.MEDIUM,
    title: "Debug mode enabled in source configuration",
    consequence: "Debug pages can expose stack traces, configuration, or interactive consoles.",
    remediation: "Drive debug mode from an environment flag that defaults to false.",
    verification: "Confirm production configuration reports debug as disabled.",
  },
  {
    id: "node-tls-off",
    pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/,
    severity: Severity.HIGH,
    title: "Node TLS verification globally disabled",
    consequence: "All outbound TLS in the process becomes vulnerable to impersonation.",
    remediation: "Remove the global override and fix the trust store instead.",
    verification: "Confirm an invalid certificate is rejected.",
  },
];

export const A11Y_RULES: readonly A11yRule[] = [
  {
    id: "img-alt",
    pattern: /<img\b(?![^>]*\balt\s*=)[^>]*>/i,
    severity: Severity.MEDIUM,
    title: "Image is missing an alt attribute",
    consequence: "Screen-reader users may miss information or hear an unhelpful filename.",
    remediation: "Add meaningful alt text, or alt=\"\" for decorative images.",
    verification: "Inspect the accessibility tree and confirm each image has an intentional alternative.",
  },
  {
    id: "input-label",
    pattern: /<input\b(?![^>]*(?:aria-label|aria-labelledby|id\s*=))[^>]*>/i,
    severity: Severity.LOW,
    title: "Input may lack a programmatic label",
    consequence: "Assistive-technology users may not know what the field expects.",
    remediation: "Associate a visible label with the input, or add aria-label/aria-labelledby.",
    verification: "Confirm the control has an accessible name in the browser tree.",
  },
  {
    id: "html-lang",
    pattern: /<html\b(?![^>]*\blang\s*=)[^>]*>/i,
    severity: Severity.LOW,
    title: "Document language is not declared",
    consequence: "Screen readers may pronounce content with the wrong language rules.",
    remediation: "Add a valid lang attribute to the root html element.",
    verification: "Confirm the language is exposed in the accessibility tree.",
  },
  {
    id: "positive-tabindex",
    pattern: /tabIndex\s*=\s*['"]?[1-9]/i,
    severity: Severity.MEDIUM,
    title: "Positive tabindex changes the natural focus order",
    consequence: "Keyboard users can be sent to unexpected controls and lose context.",
    remediation: "Use DOM order and tabindex=\"0\"/\"-1\" only where necessary.",
    verification: "Tab through the page and confirm the order matches the visual flow.",
  },
  {
    id: "clickable-div",
    pattern: /<div\b[^>]*\bonClick\b/i,
    severity: Severity.LOW,
    title: "Click handler on a non-semantic container",
    consequence: "Keyboard and assistive-technology users may not be able to activate the control.",
    remediation: "Use a button or link, or add the required role, tabindex, and key handling.",
    verification: "Activate the control with keyboard only and inspect its accessible role.",
  },
  {
    id: "aria-hidden-focusable",
    pattern: /<(?:button|a|input|select|textarea)\b[^>]*aria-hidden\s*=\s*['"]true['"]/i,
    severity: Severity.MEDIUM,
    title: "Focusable control is hidden from assistive technology",
    consequence: "Keyboard users can focus a control that screen readers cannot describe.",
    remediation: "Remove aria-hidden from focusable controls or remove them from the tab order.",
    verification: "Confirm focus and accessibility-tree exposure agree.",
  },
];

export class StaticCheckRunner {
  readonly root: string;
  readonly inventory: InventoryData;
  readonly evidence: EvidenceStore;

  constructor(root: string, inventory: InventoryData, evidence: EvidenceStore) {
    this.root = path.resolve(root);
    this.inventory = inventory;
    this.evidence = evidence;
  }

  async run(check: StaticCheckLike): Promise<CheckOutcome> {
    switch (check.id) {
      case "static.inventory":
        return this.checkStaticInventory(check);
      case "static.tests":
        return this.checkStaticTests(check);
      case "static.ci":
        return this.checkStaticCi(check);
      case "static.dependencies":
        return this.checkStaticDependencies(check);
      case "static.secrets":
        return this.checkStaticSecrets(check);
      case "static.unsafe":
        return this.checkStaticUnsafe(check);
      case "static.accessibility":
        return this.checkStaticAccessibility(check);
      case "static.full_assessment":
        return this.checkStaticFullAssessment(check);
      case "static.test_category":
        return this.checkStaticTestCategory(check);
      case "static.functionality_category":
        return this.checkStaticFunctionalityCategory(check);
      case "static.browser_category":
        return this.checkStaticBrowserCategory(check);
      case "static.issues_category":
        return this.checkStaticIssuesCategory(check);
      case "static.demo_category":
        return this.checkStaticDemoCategory(check);
      case "static.more_category":
        return this.checkStaticMoreCategory(check);
      default:
        return new CheckOutcome({
          status: CheckStatus.ERROR,
          actual: `No static runner is registered for check '${check.id}'.`,
        });
    }
  }

  private *iterFiles(extensions?: ReadonlySet<string>): IterableIterator<[string, string]> {
    const wanted = extensions ? new Set(extensions) : null;
    let seen = 0;
    for (const rel of this.inventory.source_files) {
      const full = path.join(this.root, rel);
      if (!existsSync(full)) continue;
      if (wanted !== null && !wanted.has(path.extname(full).toLowerCase())) continue;
      if (path.basename(full).includes(".min.")) continue;
      try {
        const st = statSync(full);
        if (!st.isFile() || st.size > MAX_SCAN_BYTES) continue;
      } catch {
        continue;
      }
      seen += 1;
      if (seen > MAX_SCAN_FILES) break;
      yield [rel, full];
    }
  }

  private readText(fullPath: string): string {
    try {
      const data = readFileSync(fullPath);
      if (data.subarray(0, 2048).includes(0)) return "";
      return data.toString("utf8");
    } catch {
      return "";
    }
  }

  private async save(
    name: string,
    payload: unknown,
    check: StaticCheckLike,
    description: string,
  ): Promise<string> {
    return this.evidence.saveJson(name, payload, "static_analysis", description, check.id);
  }

  async checkStaticInventory(check: StaticCheckLike): Promise<CheckOutcome> {
    const evidence = await this.save(
      "source-inventory",
      this.inventory,
      check,
      "Source inventory: file counts, languages, manifests, tests, and CI configuration.",
    );
    const languages = Object.keys(this.inventory.languages).sort().join(", ") || "none";
    const actual = `${this.inventory.total_files} files, ${this.inventory.total_bytes} bytes; languages: ${languages}; manifests: ${this.inventory.manifests.length}; tests: ${this.inventory.test_files.length}; CI: ${this.inventory.ci_files.length}`;
    return new CheckOutcome({
      status: CheckStatus.PASSED,
      actual,
      evidence: [evidence],
      metadata: { inventory: this.inventory },
    });
  }

  async checkStaticTests(check: StaticCheckLike): Promise<CheckOutcome> {
    const evidence = await this.save(
      "test-inventory",
      {
        test_files: this.inventory.test_files,
        test_frameworks: this.inventory.test_frameworks,
      },
      check,
      "Automated test inventory.",
    );
    const frameworks = this.inventory.test_frameworks.join(", ") || "not detected";
    const outcome = new CheckOutcome({
      status: CheckStatus.PASSED,
      actual: `${this.inventory.test_files.length} test file(s) found; frameworks: ${frameworks}`,
      evidence: [evidence],
    });
    if (this.inventory.test_files.length === 0) {
      outcome.addFinding(
        "No automated tests detected in the release",
        Severity.MEDIUM,
        "functional",
        "Change safety depends on unrecorded manual exploration, so regressions can ship silently.",
        "repository root",
        "Search the source tree for test/spec files and a runnable test command.",
        Strength.SOURCE_PROVEN,
        "Add a focused test suite around the highest-risk customer outcome and run it in CI.",
        "Confirm the suite fails on a seeded regression and passes after the fix.",
        ["coverage-gap"],
      );
    }
    return outcome;
  }

  async checkStaticCi(check: StaticCheckLike): Promise<CheckOutcome> {
    const evidence = await this.save(
      "ci-inventory",
      { ci_files: this.inventory.ci_files },
      check,
      "Continuous integration inventory.",
    );
    const outcome = new CheckOutcome({
      status: CheckStatus.PASSED,
      actual: `CI files: ${this.inventory.ci_files.join(", ") || "none"}`,
      evidence: [evidence],
    });
    if (this.inventory.ci_files.length === 0) {
      outcome.addFinding(
        "No continuous integration configuration detected",
        Severity.LOW,
        "reliability",
        "Test evidence is not refreshed automatically and can drift from the release.",
        "repository root",
        "Inspect for .github/workflows, .gitlab-ci.yml, Jenkinsfile, or another CI config.",
        Strength.SOURCE_PROVEN,
        "Run the test suite and this harness on pull requests.",
        "Open a pull request and confirm the checks execute and report.",
        ["coverage-gap"],
      );
    }
    return outcome;
  }

  async checkStaticDependencies(check: StaticCheckLike): Promise<CheckOutcome> {
    const reportedEnvFiles = this.inventory.tracked_available
      ? this.inventory.env_files_tracked
      : this.inventory.env_files;
    const payload = {
      manifests: this.inventory.manifests,
      lockfiles: this.inventory.lockfiles,
      env_files: this.inventory.env_files,
      env_files_tracked: this.inventory.env_files_tracked,
      env_files_ignored: this.inventory.env_files_ignored,
      tracked_available: this.inventory.tracked_available,
    };
    const evidence = await this.save(
      "dependency-and-env-inventory",
      payload,
      check,
      "Dependency lockfile and committed environment-file inventory.",
    );
    let actual = `Manifests: ${this.inventory.manifests.length}; lockfiles: ${this.inventory.lockfiles.length}; committed env files: ${reportedEnvFiles.length}`;
    if (this.inventory.tracked_available && this.inventory.env_files_ignored.length > 0) {
      actual += `; ${this.inventory.env_files_ignored.length} ignored/untracked env file(s) excluded from the committed claim`;
    }
    const outcome = new CheckOutcome({
      status: CheckStatus.PASSED,
      actual,
      evidence: [evidence],
      metadata: {
        env_files_tracked: this.inventory.env_files_tracked.length,
        env_files_ignored: this.inventory.env_files_ignored.length,
        tracked_available: this.inventory.tracked_available,
      },
    });
    for (const rel of reportedEnvFiles.slice(0, 3)) {
      outcome.addFinding(
        "Local environment file is present in the repository",
        Severity.HIGH,
        "data_integrity",
        "The file may contain live credentials, customer endpoints, or machine-specific settings.",
        rel,
        "Inspect the file's tracked status and confirm whether it contains secrets.",
        Strength.SOURCE_PROVEN,
        "Remove the file from tracking, rotate any exposed values, and ship a .env.example instead.",
        "Confirm .gitignore covers local env files and the value is revoked.",
        ["secrets", "configuration"],
      );
    }
    if (this.inventory.manifests.length > 0 && this.inventory.lockfiles.length === 0) {
      outcome.addFinding(
        "Package manifests exist without a lockfile",
        Severity.LOW,
        "data_integrity",
        "Builds can resolve different dependency versions and produce non-reproducible evidence.",
        this.inventory.manifests.slice(0, 4).join(", "),
        "Compare the manifest inventory with the lockfile inventory.",
        Strength.SOURCE_PROVEN,
        "Commit the ecosystem lockfile and use a frozen install in CI.",
        "Run two clean installs and confirm the resolved dependency set is identical.",
        ["reproducibility"],
      );
    }
    return outcome;
  }

  async checkStaticSecrets(check: StaticCheckLike): Promise<CheckOutcome> {
    const matches: Array<{
      rule: string;
      severity: string;
      file: string;
      line: number;
      excerpt: string;
    }> = [];
    let ignoredFixtures = 0;

    outer: for (const [rel, fullPath] of this.iterFiles()) {
      const text = this.readText(fullPath);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const rule of SECRET_RULES) {
          const match = rule.pattern.exec(line);
          if (!match) continue;
          let redacted: string;
          if (rule.id === "generic-credential") {
            const value = match[2] ?? "";
            if (
              looksPlaceholder(value) ||
              isTestCredentialFixture(value, rel) ||
              entropy(value) < 2.5
            ) {
              ignoredFixtures += 1;
              continue;
            }
            redacted = redactSecret(value);
          } else if (rule.id === "private-key") {
            redacted = "[REDACTED PRIVATE KEY HEADER]";
          } else {
            redacted = redactSecret(match[0] ?? "");
          }
          matches.push({
            rule: rule.id,
            severity: downgradeSeverity(rule.severity, rel),
            file: rel,
            line: i + 1,
            excerpt: redacted,
          });
          if (matches.length >= 25) break outer;
        }
        if (matches.length >= 25) break outer;
      }
    }

    const evidence = await this.save(
      "secret-scan",
      {
        matches,
        ignored_placeholder_or_test_fixture_matches: ignoredFixtures,
        note: "Values are redacted; length and prefix only.",
      },
      check,
      "Redacted secret scan results.",
    );
    const outcome = new CheckOutcome({
      status: CheckStatus.PASSED,
      actual: "No credential-like values found in scanned source.",
      evidence: [evidence],
      metadata: {
        matches: matches.length,
        ignored_placeholder_or_test_fixture_matches: ignoredFixtures,
      },
    });
    if (matches.length === 0) return outcome;

    outcome.actual = `${matches.length} credential-like match(es) found; values are redacted in evidence.`;
    const grouped = new Map<string, { rule: string; file: string; line: number; excerpt: string; severity: string; count: number }>();
    for (const item of matches) {
      const key = `${item.rule}\0${item.file}`;
      if (!grouped.has(key)) {
        grouped.set(key, { ...item, count: 0 });
      }
      grouped.get(key)!.count += 1;
    }
    const ruleMeta = new Map(SECRET_RULES.map((r) => [r.id, r]));
    let emitted = 0;
    for (const g of grouped.values()) {
      if (emitted >= 8) break;
      const rule = ruleMeta.get(g.rule);
      if (!rule) continue;
      outcome.addFinding(
        `${rule.title} (${g.count} match${g.count === 1 ? "" : "es"} in ${g.file})`,
        g.severity,
        "security",
        rule.consequence,
        `${g.file}:${g.line}`,
        "Inspect the redacted match in the evidence file and confirm whether the value is live.",
        Strength.SOURCE_PROVEN,
        rule.remediation,
        rule.verification,
        ["secret", "redacted"],
      );
      emitted += 1;
    }
    return outcome;
  }

  async checkStaticUnsafe(check: StaticCheckLike): Promise<CheckOutcome> {
    const matches: Array<{
      rule: string;
      severity: string;
      file: string;
      line: number;
      excerpt: string;
    }> = [];

    outer: for (const [rel, fullPath] of this.iterFiles(CODE_EXTENSIONS)) {
      const text = this.readText(fullPath);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const rule of UNSAFE_RULES) {
          if (rule.pattern.test(line)) {
            matches.push({
              rule: rule.id,
              severity: downgradeSeverity(rule.severity, rel),
              file: rel,
              line: i + 1,
              excerpt: line.trim().slice(0, 180),
            });
          }
        }
        if (matches.length >= 30) break outer;
      }
    }

    const evidence = await this.save(
      "unsafe-pattern-scan",
      { matches },
      check,
      "High-risk source pattern matches.",
    );
    const outcome = new CheckOutcome({
      status: CheckStatus.PASSED,
      actual: "No high-risk source patterns matched.",
      evidence: [evidence],
      metadata: { matches: matches.length },
    });
    if (matches.length === 0) return outcome;

    outcome.actual = `${matches.length} high-risk source pattern match(es) found.`;
    const grouped = new Map<string, { rule: string; file: string; line: number; excerpt: string; severity: string; count: number }>();
    for (const item of matches) {
      const key = `${item.rule}\0${item.file}`;
      if (!grouped.has(key)) {
        grouped.set(key, { ...item, count: 0 });
      }
      grouped.get(key)!.count += 1;
    }
    const ruleMeta = new Map(UNSAFE_RULES.map((r) => [r.id, r]));
    let emitted = 0;
    for (const g of grouped.values()) {
      if (emitted >= 8) break;
      const rule = ruleMeta.get(g.rule);
      if (!rule) continue;
      outcome.addFinding(
        `${rule.title} (${g.count} occurrence${g.count === 1 ? "" : "s"} in ${g.file})`,
        g.severity,
        "security",
        rule.consequence,
        `${g.file}:${g.line}`,
        "Inspect the cited line and trace whether untrusted input can reach it.",
        Strength.SOURCE_PROVEN,
        rule.remediation,
        rule.verification,
        ["unsafe-pattern", g.rule],
      );
      emitted += 1;
    }
    return outcome;
  }

  async checkStaticAccessibility(check: StaticCheckLike): Promise<CheckOutcome> {
    const matches: Array<{
      rule: string;
      severity: string;
      file: string;
      line: number;
      excerpt: string;
    }> = [];

    for (const [rel, fullPath] of this.iterFiles(MARKUP_EXTENSIONS)) {
      const text = this.readText(fullPath);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const rule of A11Y_RULES) {
          if (rule.pattern.test(line)) {
            matches.push({
              rule: rule.id,
              severity: downgradeSeverity(rule.severity, rel),
              file: rel,
              line: i + 1,
              excerpt: line.trim().slice(0, 180),
            });
          }
        }
        if (matches.length >= 30) break;
      }
      if (matches.length >= 30) break;
    }

    const evidence = await this.save(
      "source-accessibility-scan",
      { matches, files_scanned: this.inventory.markup_files },
      check,
      "Static accessibility heuristics on markup and component templates.",
    );
    const outcome = new CheckOutcome({
      status: CheckStatus.PASSED,
      actual: "No obvious source-level accessibility barriers matched.",
      evidence: [evidence],
      metadata: { matches: matches.length },
    });
    if (matches.length === 0) return outcome;

    outcome.actual = `${matches.length} source-level accessibility match(es) across ${this.inventory.markup_files.length} markup file(s).`;
    const grouped = new Map<string, { rule: string; file: string; line: number; excerpt: string; severity: string; count: number }>();
    for (const item of matches) {
      const key = `${item.rule}\0${item.file}`;
      if (!grouped.has(key)) {
        grouped.set(key, { ...item, count: 0 });
      }
      grouped.get(key)!.count += 1;
    }
    const ruleMeta = new Map(A11Y_RULES.map((r) => [r.id, r]));
    let emitted = 0;
    for (const g of grouped.values()) {
      if (emitted >= 8) break;
      const rule = ruleMeta.get(g.rule);
      if (!rule) continue;
      outcome.addFinding(
        `${rule.title} (${g.count} occurrence${g.count === 1 ? "" : "s"} in ${g.file})`,
        g.severity,
        "accessibility",
        rule.consequence,
        `${g.file}:${g.line}`,
        "Inspect the cited markup and verify the rendered accessibility tree.",
        Strength.SOURCE_PROVEN,
        rule.remediation,
        rule.verification,
        ["accessibility", g.rule],
      );
      emitted += 1;
    }
    return outcome;
  }

  private readRootFile(rel: string): string {
    try {
      const full = path.join(this.root, rel);
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_SCAN_BYTES) return "";
      const data = readFileSync(full);
      if (data.subarray(0, 2048).includes(0)) return "";
      return data.toString("utf8");
    } catch {
      return "";
    }
  }

  async checkStaticFullAssessment(check: StaticCheckLike): Promise<CheckOutcome> {
    const payload = {
      category: "full",
      intent: (check as { intent?: unknown }).intent ?? "",
      expected: (check as { expected?: unknown }).expected ?? "",
      source_available: this.inventory.available,
      source_files: this.inventory.source_files.length,
      test_files: this.inventory.test_files.length,
      markup_files: this.inventory.markup_files.length,
      manifests: this.inventory.manifests.length,
    };
    const evidence = await this.save(
      "full-assessment-scope",
      payload,
      check,
      "Full category assessment scope and inventory summary.",
    );
    return new CheckOutcome({
      status: CheckStatus.PASSED,
      actual: `Full category assessment recorded for ${this.inventory.source_files.length} source file(s).`,
      evidence: [evidence],
      metadata: { category: "full" },
    });
  }

  async checkStaticTestCategory(check: StaticCheckLike): Promise<CheckOutcome> {
    const payload = {
      category: "test",
      intent: (check as { intent?: unknown }).intent ?? "",
      expected: (check as { expected?: unknown }).expected ?? "",
      source_available: this.inventory.available,
      source_files: this.inventory.source_files.length,
      test_files: this.inventory.test_files.length,
      test_frameworks: this.inventory.test_frameworks,
      manifests: this.inventory.manifests.length,
    };
    const evidence = await this.save(
      "test-category-scope",
      payload,
      check,
      "Test category assessment scope and test inventory summary.",
    );
    return new CheckOutcome({
      status: CheckStatus.PASSED,
      actual: `Test category assessment recorded with ${this.inventory.test_files.length} test file(s).`,
      evidence: [evidence],
      metadata: { category: "test" },
    });
  }

  async checkStaticFunctionalityCategory(check: StaticCheckLike): Promise<CheckOutcome> {
    const payload = {
      category: "functionality",
      intent: (check as { intent?: unknown }).intent ?? "",
      expected: (check as { expected?: unknown }).expected ?? "",
      source_available: this.inventory.available,
      source_files: this.inventory.source_files.length,
      test_files: this.inventory.test_files.length,
      test_frameworks: this.inventory.test_frameworks,
      manifests: this.inventory.manifests.length,
    };
    const evidence = await this.save(
      "functionality-category-scope",
      payload,
      check,
      "Functionality category assessment scope and inventory summary.",
    );
    return new CheckOutcome({
      status: CheckStatus.PASSED,
      actual: `Functionality category assessment recorded for ${this.inventory.source_files.length} source file(s).`,
      evidence: [evidence],
      metadata: { category: "functionality" },
    });
  }

  async checkStaticBrowserCategory(check: StaticCheckLike): Promise<CheckOutcome> {
    const payload = {
      category: "browser",
      intent: (check as { intent?: unknown }).intent ?? "",
      expected: (check as { expected?: unknown }).expected ?? "",
      source_available: this.inventory.available,
      source_files: this.inventory.source_files.length,
      markup_files: this.inventory.markup_files.length,
      manifests: this.inventory.manifests.length,
    };
    const evidence = await this.save(
      "browser-category-scope",
      payload,
      check,
      "Browser category assessment scope and inventory summary.",
    );
    return new CheckOutcome({
      status: CheckStatus.PASSED,
      actual: `Browser category assessment recorded for ${this.inventory.source_files.length} source file(s).`,
      evidence: [evidence],
      metadata: { category: "browser" },
    });
  }

  async checkStaticIssuesCategory(check: StaticCheckLike): Promise<CheckOutcome> {
    const markerCounts: Record<string, number> = {};
    const markerFiles: string[] = [];
    for (const [rel, fullPath] of this.iterFiles(CODE_EXTENSIONS)) {
      const text = this.readText(fullPath);
      if (!text) continue;
      const matches = [...text.matchAll(ISSUE_MARKER_PATTERN)].map((m) => m[1] ?? "").filter(Boolean);
      if (matches.length === 0) continue;
      markerFiles.push(rel);
      for (const marker of matches) {
        const key = marker.toUpperCase();
        markerCounts[key] = (markerCounts[key] ?? 0) + 1;
      }
    }
    const payload = {
      category: "issues",
      intent: (check as { intent?: unknown }).intent ?? "",
      expected: (check as { expected?: unknown }).expected ?? "",
      source_available: this.inventory.available,
      source_files: this.inventory.source_files.length,
      test_files: this.inventory.test_files.length,
      manifests: this.inventory.manifests.length,
      issue_markers: markerCounts,
      files_with_issue_markers: markerFiles.slice(0, 20),
    };
    const evidence = await this.save(
      "issues-category-scope",
      payload,
      check,
      "Issues category assessment scope and issue-marker inventory summary.",
    );
    const markerTotal = Object.values(markerCounts).reduce((a, b) => a + b, 0);
    return new CheckOutcome({
      status: CheckStatus.PASSED,
      actual: `Issues category assessment recorded with ${markerTotal} issue marker(s) in ${markerFiles.length} file(s).`,
      evidence: [evidence],
      metadata: {
        category: "issues",
        issue_markers: markerTotal,
        files_with_issue_markers: markerFiles.length,
      },
    });
  }

  private demoEntrypoints(): string[] {
    const found: string[] = [];
    const packageText = this.readRootFile("package.json");
    if (packageText) {
      try {
        const data = JSON.parse(packageText) as Record<string, unknown>;
        const scripts = data.scripts;
        if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
          for (const name of Object.keys(scripts).sort()) {
            if (DEMO_SCRIPT_NAMES.has(name) || name.startsWith("demo:")) {
              found.push(`script:${name}`);
            }
          }
        }
      } catch {
        // ignore malformed package.json
      }
    }
    const makefileText = this.readRootFile("Makefile");
    if (makefileText) {
      for (const line of makefileText.split(/\r?\n/)) {
        const m = /^([A-Za-z0-9_.-]+):(?!=)/.exec(line);
        if (m && DEMO_SCRIPT_NAMES.has(m[1]!)) {
          found.push(`make:${m[1]!}`);
        }
      }
    }
    return [...new Set(found)].sort().slice(0, 10);
  }

  async checkStaticDemoCategory(check: StaticCheckLike): Promise<CheckOutcome> {
    const demoPaths: string[] = [];
    const demoDirectories: string[] = [];
    for (const rel of this.inventory.files) {
      const parts = rel.split("/");
      if (parts.length === 0) continue;
      const directories = parts.slice(0, -1).map((p) => p.toLowerCase());
      const stem = path.basename(parts[parts.length - 1]!, path.extname(parts[parts.length - 1]!)).toLowerCase();
      if (!directories.some((part) => DEMO_HINTS.has(part)) && !DEMO_HINTS.has(stem)) continue;
      demoPaths.push(rel);
      for (const part of directories) {
        if (DEMO_HINTS.has(part) && !demoDirectories.includes(part)) {
          demoDirectories.push(part);
        }
      }
    }
    const sortedDemoPaths = [...demoPaths].sort().slice(0, 20);
    const sortedDemoDirs = [...demoDirectories].sort().slice(0, 10);
    const demoEntrypoints = this.demoEntrypoints();

    const quickstartDocs: string[] = [];
    for (const rel of [...this.inventory.files].sort()) {
      const lower = rel.toLowerCase();
      if (!lower.endsWith(".md") && !lower.endsWith(".mdx") && !lower.endsWith(".rst") && !lower.endsWith(".txt")) continue;
      if (!lower.includes("readme") && !(`/${lower}`).includes("/docs/")) continue;
      const text = this.readRootFile(rel).toLowerCase();
      if (!text) continue;
      if (DEMO_DOC_HINTS.some((hint) => text.includes(hint))) {
        quickstartDocs.push(rel);
      }
    }

    const limitation = "Demo surface inventory only; no behavioral demo evidence was collected because no URL was provided.";
    const payload = {
      category: "demo",
      intent: (check as { intent?: unknown }).intent ?? "",
      expected: (check as { expected?: unknown }).expected ?? "",
      source_available: this.inventory.available,
      source_files: this.inventory.source_files.length,
      manifests: this.inventory.manifests.length,
      demo_paths: sortedDemoPaths,
      demo_directories: sortedDemoDirs,
      demo_entrypoints: demoEntrypoints,
      quickstart_docs: quickstartDocs.slice(0, 10),
      behavioral_evidence: false,
      limitation,
    };
    const evidence = await this.save(
      "demo-category-scope",
      payload,
      check,
      "Demo category assessment scope, demo assets, and entry-point summary.",
    );
    return new CheckOutcome({
      status: CheckStatus.PASSED,
      actual: `Demo surface inventory recorded with ${sortedDemoPaths.length} demo path(s), ${demoEntrypoints.length} entry point(s), and ${quickstartDocs.length} documentation reference(s). No demo was launched or rendered.`,
      evidence: [evidence],
      metadata: {
        category: "demo",
        demo_paths: sortedDemoPaths.length,
        demo_entrypoints: demoEntrypoints.length,
        quickstart_docs: quickstartDocs.length,
        behavioral_evidence: false,
        limitation,
      },
    });
  }

  async checkStaticMoreCategory(check: StaticCheckLike): Promise<CheckOutcome> {
    const files = [...this.inventory.files].sort();
    const docs: string[] = [];
    const examples: string[] = [];
    const configs: string[] = [];
    const scripts: string[] = [];

    for (const rel of files) {
      const lower = rel.toLowerCase();
      const name = path.basename(lower);
      const stem = path.basename(name, path.extname(name));
      const parts = rel.split("/").map((p) => p.toLowerCase());
      if (
        (lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".rst") || lower.endsWith(".txt") || lower.endsWith(".adoc")) &&
        (MORE_DOC_HINTS.has(stem) || name.includes("readme") || (`/${lower}`).includes("/docs/") || lower.startsWith("docs/"))
      ) {
        docs.push(rel);
      }
      if (parts.slice(0, -1).some((part) => MORE_EXAMPLE_HINTS.has(part)) || MORE_EXAMPLE_HINTS.has(stem)) {
        examples.push(rel);
      }
      if (
        MORE_CONFIG_NAMES.has(name) ||
        (((name.endsWith(".yml") || name.endsWith(".yaml")) && (name.includes("docker") || name.includes("compose"))))
      ) {
        configs.push(rel);
      }
    }

    const packageText = this.readRootFile("package.json");
    if (packageText) {
      try {
        const data = JSON.parse(packageText) as Record<string, unknown>;
        const scriptMap = data.scripts;
        if (scriptMap && typeof scriptMap === "object" && !Array.isArray(scriptMap)) {
          for (const name of Object.keys(scriptMap).sort().slice(0, 20)) {
            scripts.push(`script:${name}`);
          }
        }
      } catch {
        // ignore
      }
    }

    for (const makeName of ["Makefile", "makefile", "Justfile", "justfile"]) {
      const text = this.readRootFile(makeName);
      if (!text) continue;
      for (const line of text.split(/\r?\n/).slice(0, 200)) {
        const m = /^([A-Za-z0-9_.-]+):(?!=)/.exec(line);
        if (m) scripts.push(`task:${m[1]!}`);
      }
    }
    const uniqueScripts = [...new Set(scripts)].sort().slice(0, 20);
    const uniqueConfigs = [...new Set(configs)].sort().slice(0, 20);

    const payload = {
      category: "more",
      intent: (check as { intent?: unknown }).intent ?? "",
      expected: (check as { expected?: unknown }).expected ?? "",
      source_available: this.inventory.available,
      source_files: this.inventory.source_files.length,
      test_files: this.inventory.test_files.length,
      docs: docs.slice(0, 20),
      examples: examples.slice(0, 20),
      configs: uniqueConfigs,
      scripts: uniqueScripts,
      ci_files: [...(this.inventory.ci_files ?? [])].sort().slice(0, 20),
      manifests: this.inventory.manifests.slice(0, 20),
    };
    const evidence = await this.save(
      "more-category-scope",
      payload,
      check,
      "Extended 'more' category assessment scope and additional surface inventory.",
    );
    return new CheckOutcome({
      status: CheckStatus.PASSED,
      actual: `More category assessment recorded with ${docs.length} doc(s), ${examples.length} example path(s), ${new Set(configs).size} config file(s), and ${uniqueScripts.length} script/task entry point(s).`,
      evidence: [evidence],
      metadata: {
        category: "more",
        docs: docs.length,
        examples: examples.length,
        configs: new Set(configs).size,
        scripts: uniqueScripts.length,
      },
    });
  }
}
