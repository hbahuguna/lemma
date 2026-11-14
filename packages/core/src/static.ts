import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

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
        if (CI_NAMES.has(fileName)) inventory.ci_files.push(rel);
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
