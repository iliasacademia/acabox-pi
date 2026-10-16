/**
 * Importing a skill from GitHub.
 *
 * One HTTPS request fetches a repository tarball from `codeload.github.com`;
 * `/usr/bin/tar` extracts the one subdirectory we want. No git, no auth, no
 * clone, no registry client. Everything below was measured against the real
 * endpoints while writing it, and the measurements are recorded inline because
 * several of them contradict what the obvious implementation would assume.
 *
 * WHY NOT THE OTHER THREE OPTIONS
 * -------------------------------
 * - **git.** `/usr/bin/git` on macOS is a 118 KB Command Line Tools *shim* that
 *   fails outright without Xcode CLT installed. `/usr/bin/tar` is a real
 *   275 KB Mach-O bsdtar (libarchive 3.7.4, confirmed on this machine), so it
 *   is the only extractor safe to depend on. The CLI's own `/plugin install`
 *   resolves subdirectories with git sparse-checkout, which is exactly why we
 *   cannot reuse it.
 * - **`api.github.com` for content.** 60 requests/hour unauthenticated
 *   (measured: `x-ratelimit-limit: 60`), and its contents API returns
 *   `content: null` for directories, one level deep. Reserved here strictly
 *   for metadata: resolving a ref to a commit SHA, and the update check.
 * - **`raw.githubusercontent.com`.** Sends `cache-control: max-age=300` even
 *   on SHA-pinned, immutable URLs. A five-minute stale window on bytes we are
 *   about to hash into a provenance record is not acceptable.
 *
 * WHAT WAS MEASURED, AND WHAT IT COSTS US
 * ---------------------------------------
 * 1. **codeload sends no `content-length`** — the response is chunked, and the
 *    only headers are `etag`, `content-type: application/x-gzip` and
 *    `content-disposition`. So download progress can report *bytes received*
 *    and nothing else. It must NOT report a percentage: there is no
 *    denominator, and inventing one is exactly the fabricated-status rule this
 *    codebase already wrote down. (This is the one way the download here is
 *    unlike `selfUpdater.downloadWithProgress`, whose size comes from a signed
 *    manifest. The streaming/backpressure/throttle shape is copied from it.)
 * 2. **codeload returns no rate-limit headers at all.** Tarball fetches are
 *    free; the 60/hr budget is spent only by `resolveRef` and
 *    `checkForUpdate`. Neither may ever run on a timer.
 * 3. **bsdtar refuses `..` traversal but happily materialises symlinks** —
 *    both absolute (`link-out -> /etc/passwd`) and escaping-relative
 *    (`nested/rel-out -> ../../../../../../etc/hosts`). Both were extracted
 *    and dereferenced successfully while writing this. Acabox's symlink reaper
 *    (`containerService.syncWorkspaceSymlinks`) only inspects workspace-ROOT
 *    entries, so a link nested inside `.claude/skills/<id>/` survives every
 *    boot forever. `stripSymlinks` is therefore not hygiene, it is the
 *    mitigation for a real hole. It runs before anything else looks at the
 *    tree.
 * 4. **A git blob SHA is locally recomputable**: `sha1("blob <len>\0" + bytes)`
 *    reproduced `d3e046a5ae107a6cb23cfb16c219837094ab35d3` byte-identically
 *    for `anthropics/skills@b29e7cf:skills/pdf/SKILL.md` against the tree API.
 *    That is what makes the update check *per file* and one API call: we can
 *    fill `upstreamBlobs` at import time from the archive bytes with zero
 *    extra requests, then diff a single tree listing against it later.
 *
 * INTEGRITY MODEL, STATED PLAINLY
 * -------------------------------
 * There is no signed manifest for a skill and there cannot be one. Integrity
 * rests on TLS plus the 40-character commit SHA — which makes an import
 * reproducible and auditable, and does not make it safe. An imported
 * `SKILL.md` is instructions the model will follow, and a bundled script runs
 * with the user's full privileges the moment Claude invokes it, because Bash
 * is auto-approved in this app with no permission handler. Hence `execCount` /
 * `execPaths`: the caller is expected to state them before committing.
 */

import { net } from 'electron';
import { createWriteStream, promises as fsp } from 'fs';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { once } from 'events';
import path from 'path';
import os from 'os';
import log from 'electron-log';

import {
  type SkillDeclaredMetadata,
  type SkillFrontmatter,
  type SkillSource,
  SKILL_DESCRIPTION_MAX_CHARS,
  parseSkillFrontmatter,
  validateSkillId,
} from '../../shared/skills';
import { PRODUCT_DISPLAY_NAME } from '../../shared/product';

const execFileAsync = promisify(execFile);

export const CODELOAD_ORIGIN = 'https://codeload.github.com';
export const GITHUB_API_ORIGIN = 'https://api.github.com';

/**
 * bsdtar. Absolute, never `tar` off PATH: `buildSubprocessEnv` prepends the
 * venv and npm-prefix `bin/` directories, and a mini-app is free to install
 * something called `tar` into either of them.
 */
export const TAR_BIN = '/usr/bin/tar';

/**
 * Safety ceilings. None of these are close to the real corpus — the whole
 * `openai/plugins` repo is 21 MB and the largest shipped skill is a few
 * hundred KB — so hitting one means something is wrong, not that the limit is
 * tight.
 */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_SKILL_BYTES = 64 * 1024 * 1024;
export const MAX_SKILL_FILES = 4000;

/** `SKILL.md` is what makes a directory a skill. */
const SKILL_FILE = 'SKILL.md';

/**
 * Marketplace manifests, in the two locations that exist in the wild:
 * `openai/plugins` uses the first, `anthropics/skills` the second. Both are
 * optional — the catalogue is built by finding `SKILL.md` files, and the
 * manifest only decorates the result with a catalogue name, plugin grouping
 * and category.
 */
const MARKETPLACE_PATHS = [
  path.join('.agents', 'plugins', 'marketplace.json'),
  path.join('.claude-plugin', 'marketplace.json'),
];

// ---------------------------------------------------------------------------
// Parsing what the user pasted
// ---------------------------------------------------------------------------

export interface GithubTarget {
  owner: string;
  repo: string;
  /**
   * The ref as pasted — a branch, tag or SHA. Undefined means the repository's
   * default branch. Display and resolution input only; the pin is the SHA.
   */
  ref?: string;
  /** Path inside the repo. `''` means the repository root. */
  subpath: string;
}

/** GitHub owner/repo charset. Deliberately strict — this becomes a URL. */
const GH_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * A subpath we are willing to hand to bsdtar as a member pattern. Glob
 * metacharacters are refused rather than escaped: bsdtar treats the argument
 * as a pattern, and a `*` in a path would silently select a different subtree
 * than the one the user picked.
 */
const SUBPATH_ILLEGAL = /[*?[\]\\]/;

function normalizeSubpath(raw: string): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return '';
  if (SUBPATH_ILLEGAL.test(trimmed)) {
    throw new Error(`Path "${trimmed}" contains characters that are not allowed in a repository path.`);
  }
  const parts = trimmed.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`Path "${trimmed}" is not a plain repository path.`);
  }
  return parts.join('/');
}

/**
 * Parse a GitHub repo or tree URL, or the `owner/repo[/tree/<ref>/<path>]`
 * shorthand. Returns null for anything that is not GitHub — the caller shows
 * its own message, because "that is not a GitHub URL" and "that repo does not
 * exist" want different copy.
 *
 * KNOWN AMBIGUITY, not fixable client-side: in `/tree/<ref>/<subpath>` a
 * branch name may itself contain slashes (`feature/x`), and nothing in the URL
 * distinguishes `tree/feature/x/skills/a` from a branch `feature` with subpath
 * `x/skills/a`. GitHub resolves this server-side against its ref list; we
 * would need one API call per candidate split, against a 60/hr budget. So the
 * first segment is taken as the ref — correct for every SHA, tag and
 * single-segment branch, which is everything the import flow actually sees —
 * and a caller with better information can override `ref`.
 */
export function parseGithubUrl(input: string): GithubTarget | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;

  let rest: string;
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return null;
    rest = url.pathname;
  } else if (/^git@github\.com:/i.test(raw)) {
    rest = raw.slice(raw.indexOf(':') + 1);
  } else {
    rest = raw;
  }

  const segments = rest.replace(/^\/+/, '').split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');
  if (!GH_NAME.test(owner) || !GH_NAME.test(repo)) return null;

  // `/tree/<ref>/<subpath>` and `/blob/<ref>/<subpath>` both appear in URLs
  // people copy out of the address bar.
  let ref: string | undefined;
  let subpath = '';
  if (segments.length > 2) {
    const kind = segments[2];
    if (kind !== 'tree' && kind !== 'blob') return null;
    ref = segments[3] ? decodeURIComponent(segments[3]) : undefined;
    subpath = segments.slice(4).map((s) => decodeURIComponent(s)).join('/');
    // A pasted /blob/ URL points at SKILL.md itself; the skill is its parent.
    if (kind === 'blob' && subpath.toLowerCase().endsWith(`/${SKILL_FILE.toLowerCase()}`)) {
      subpath = subpath.slice(0, -(SKILL_FILE.length + 1));
    }
  }

  return { owner, repo, ref, subpath: normalizeSubpath(subpath) };
}

// ---------------------------------------------------------------------------
// api.github.com — metadata only, never on a timer
// ---------------------------------------------------------------------------

interface ApiOptions {
  signal?: AbortSignal;
  /** Optional PAT. Absent today; see §7 of the design doc. */
  token?: string;
}

function apiHeaders(accept: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    // GitHub rejects API requests with no User-Agent. Chromium supplies one,
    // but naming ourselves makes the request identifiable in their logs and in
    // a proxy trace.
    'User-Agent': PRODUCT_DISPLAY_NAME,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Turn a 403 into something a user can act on. Unauthenticated GitHub gives 60
 * requests per hour per IP, and the difference between "you are rate limited
 * until 18:04" and "HTTP 403" is the difference between waiting and filing a
 * bug.
 */
function describeApiFailure(res: Response, what: string): string {
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if ((res.status === 403 || res.status === 429) && remaining === '0' && Number.isFinite(reset)) {
    const at = new Date(reset * 1000).toLocaleTimeString();
    return `GitHub's hourly request limit is used up (60 per hour without a token). It resets at ${at}.`;
  }
  if (res.status === 404) {
    return `${what} was not found on GitHub. Check the owner, repository and path.`;
  }
  return `${what} failed: HTTP ${res.status}.`;
}

/**
 * Resolve a branch, tag or short SHA to the full 40-character commit SHA.
 *
 * A pin recorded as a branch name is not a pin — the bytes it names change
 * under it — so nothing downstream accepts anything but the resolved value.
 * One request, and with `Accept: application/vnd.github.sha` the whole
 * response body is the 40 characters (measured: `content-length: 40`).
 */
export async function resolveRef(
  owner: string,
  repo: string,
  ref?: string,
  opts: ApiOptions = {},
): Promise<string> {
  const wanted = (ref ?? 'HEAD').trim() || 'HEAD';
  // Already a full SHA: no request at all. Worth the branch — the update flow
  // re-imports at a SHA it already holds, and the budget is 60/hr.
  if (/^[0-9a-f]{40}$/i.test(wanted)) return wanted.toLowerCase();

  const url = `${GITHUB_API_ORIGIN}/repos/${owner}/${repo}/commits/${encodeURIComponent(wanted)}`;
  const res = await net.fetch(url, {
    headers: apiHeaders('application/vnd.github.sha', opts.token),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(describeApiFailure(res, `Resolving ${owner}/${repo}@${wanted}`));
  }
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`GitHub returned "${sha.slice(0, 60)}" instead of a commit SHA.`);
  }
  return sha.toLowerCase();
}

// ---------------------------------------------------------------------------
// codeload.github.com — the bytes
// ---------------------------------------------------------------------------

export interface DownloadProgress {
  receivedBytes: number;
  /**
   * Undefined for a codeload tarball, always. The response is chunked with no
   * `content-length`, so there is no total and therefore no percentage. A
   * caller must render bytes, not a progress bar.
   */
  totalBytes?: number;
}

export interface FetchOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  token?: string;
}

/**
 * Stream `<owner>/<repo>` at `sha` to `destPath`. Returns bytes written.
 *
 * Streaming shape (reader loop, `out.write` backpressure via `drain`, progress
 * throttled to 200 ms) is lifted from `selfUpdater.downloadWithProgress`. What
 * is deliberately NOT lifted: the sha512 manifest check, which has no
 * counterpart here — see the integrity note in the file header.
 */
async function downloadTarball(
  owner: string,
  repo: string,
  sha: string,
  destPath: string,
  opts: FetchOptions,
): Promise<number> {
  const url = `${CODELOAD_ORIGIN}/${owner}/${repo}/tar.gz/${sha}`;
  log.info(`[SkillImport] Downloading ${url}`);

  const res = await net.fetch(url, {
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : undefined,
    signal: opts.signal,
  });
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`${owner}/${repo} has no commit ${sha.slice(0, 7)}, or the repository is private.`);
    }
    throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  }
  if (!res.body) throw new Error('Download failed: response had no body.');

  const out = createWriteStream(destPath);
  const reader = res.body.getReader();
  let received = 0;
  let lastReport = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_ARCHIVE_BYTES) {
        throw new Error(
          `${owner}/${repo} is larger than the ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB import limit.`,
        );
      }
      if (!out.write(value)) await once(out, 'drain');
      const now = Date.now();
      if (opts.onProgress && now - lastReport > 200) {
        lastReport = now;
        opts.onProgress({ receivedBytes: received });
      }
    }
  } finally {
    out.end();
  }
  await once(out, 'close');

  opts.onProgress?.({ receivedBytes: received });
  log.info(`[SkillImport] Downloaded ${received} bytes of ${owner}/${repo}@${sha.slice(0, 7)}`);
  return received;
}

/**
 * Extract one subtree of a codeload tarball so that its *contents* land
 * directly in `destDir`.
 *
 * codeload roots every entry at `<repo>-<sha>/`, so the member pattern is
 * `<repo>-<sha>/<subpath>` and the strip depth is one plus the number of
 * subpath segments. Getting that arithmetic wrong is silent: too few strips
 * and you get `destDir/skills/pdf/SKILL.md`, which reads as "no SKILL.md" two
 * functions later.
 *
 * The four `--no-*` flags refuse extended attributes, ACLs, BSD file flags and
 * AppleDouble metadata out of the archive. GitHub tarballs carry none of them;
 * a hand-crafted one could, and none of it is anything a skill needs. (They
 * are extract-mode-only options — bsdtar rejects them under `-t`.)
 */
async function extractSubpath(
  tarPath: string,
  repo: string,
  sha: string,
  subpath: string,
  destDir: string,
): Promise<void> {
  const root = `${repo}-${sha}`;
  const member = subpath ? `${root}/${subpath}` : root;
  const strip = 1 + (subpath ? subpath.split('/').length : 0);

  await fsp.mkdir(destDir, { recursive: true });
  try {
    await execFileAsync(TAR_BIN, [
      '-xzf', tarPath,
      '-C', destDir,
      `--strip-components=${strip}`,
      '--no-same-owner',
      '--no-xattrs',
      '--no-acls',
      '--no-fflags',
      '--no-mac-metadata',
      member,
    ]);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/Not found in archive/i.test(message)) {
      throw new Error(`"${subpath || '/'}" does not exist in ${repo} at ${sha.slice(0, 7)}.`);
    }
    throw new Error(`Extracting "${subpath || '/'}" failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// The safety pass
// ---------------------------------------------------------------------------

export interface StrippedLink {
  /** Path relative to the skill root, POSIX separators. */
  path: string;
  /** What it pointed at, kept so the disclosure can be specific. */
  target: string;
}

/**
 * Delete every symlink in the extracted tree, depth-first, and report what was
 * removed.
 *
 * This is the mitigation for the hole documented in the file header: bsdtar
 * blocks `..` in a *path* but materialises a *symlink* to anywhere, and
 * Acabox's reaper never looks inside `.claude/skills/<id>/`. A surviving
 * absolute link is a permanent read/write handle into the user's home
 * directory that the agent reaches with an ordinary relative path.
 *
 * Deleted rather than resolved-and-copied: a skill has no legitimate use for a
 * link out of its own directory, and copying the target in would import bytes
 * the pinned commit does not contain — the provenance record would be a lie.
 *
 * `lstat` throughout, never `stat`: `stat` follows the link and would report a
 * dangling one as missing and a directory link as a directory to recurse into.
 */
export async function stripSymlinks(root: string): Promise<StrippedLink[]> {
  const removed: StrippedLink[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        const target = await fsp.readlink(abs).catch(() => '(unreadable)');
        await fsp.unlink(abs);
        removed.push({ path: relPath, target });
        continue;
      }
      // isDirectory() is false for a symlink-to-directory, so this recursion
      // can only ever descend into real directories.
      if (entry.isDirectory()) await walk(abs, relPath);
    }
  }

  await walk(root, '');
  if (removed.length > 0) {
    log.warn(
      `[SkillImport] Stripped ${removed.length} symlink(s) from ${root}: ` +
        removed.map((r) => `${r.path} -> ${r.target}`).join(', '),
    );
  }
  return removed;
}

export interface TreeScan {
  /** Relative POSIX paths of every regular file, sorted. */
  files: string[];
  fileCount: number;
  /** Files carrying any exec bit. Disclosed, never hidden. */
  execPaths: string[];
  execCount: number;
  totalBytes: number;
}

/**
 * Walk a stripped tree. Call this only after `stripSymlinks`, so that anything
 * left is a real file or a real directory.
 */
export async function scanTree(root: string): Promise<TreeScan> {
  const files: string[] = [];
  const execPaths: string[] = [];
  let totalBytes = 0;

  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fsp.lstat(abs);
      files.push(relPath);
      totalBytes += stat.size;
      if ((stat.mode & 0o111) !== 0) execPaths.push(relPath);
    }
  }

  await walk(root, '');
  files.sort();
  execPaths.sort();
  return { files, fileCount: files.length, execPaths, execCount: execPaths.length, totalBytes };
}

// ---------------------------------------------------------------------------
// git blob SHAs
// ---------------------------------------------------------------------------

/**
 * The git object id of a blob: `sha1("blob " + byteLength + "\0" + bytes)`.
 *
 * Verified against the real tree API — `anthropics/skills@b29e7cf`'s
 * `skills/pdf/SKILL.md` (8,072 bytes) recomputes to
 * `d3e046a5ae107a6cb23cfb16c219837094ab35d3`, which is what GitHub reports.
 * That equivalence is the whole update-check design: the archive we already
 * downloaded gives us upstream's own hashes for free, so a later check is one
 * metadata call and a map comparison instead of a second 21 MB download.
 */
export function gitBlobSha(bytes: Buffer): string {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex');
}

/** Git blob SHAs for every file in a tree, keyed by relative POSIX path. */
export async function computeBlobShas(root: string, files: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of files) {
    out[rel] = gitBlobSha(await fsp.readFile(path.join(root, ...rel.split('/'))));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation — never rewriting
// ---------------------------------------------------------------------------

export interface SkillImportProblem {
  level: 'error' | 'warning';
  message: string;
}

/**
 * Check an extracted skill against the Agent Skills spec, and say nothing
 * about how to fix it by editing it.
 *
 * 62 of the 607 `openai/plugins` skills declare a frontmatter `name` that
 * disagrees with their directory name. The CLI does not care — `ydH` keys the
 * skill on the dirent's name and files the frontmatter `name` under
 * `displayName` — and neither do we. Rewriting the file to make them agree
 * would register as a local modification against the import baseline the
 * instant the skill lands, permanently marking a pristine import MODIFIED and
 * destroying the "what did I change" signal on day one.
 *
 * An `error` means the directory cannot become a store skill. A `warning` is
 * something the user should see on the confirm screen and may accept.
 */
export function validateImportedSkill(id: string, frontmatter: SkillFrontmatter): SkillImportProblem[] {
  const problems: SkillImportProblem[] = [];

  const idCheck = validateSkillId(id);
  if (!idCheck.ok) problems.push({ level: 'error', message: idCheck.error });

  if (!frontmatter.ok) {
    // Not fatal, and that is deliberate: the CLI loads such a skill anyway,
    // synthesising a description from the body's first heading. Refusing the
    // import would hide a skill the user would otherwise see behaving oddly.
    problems.push({
      level: 'warning',
      message: `This skill's header is malformed (${frontmatter.error}); I'll guess its purpose from its first heading.`,
    });
    return problems;
  }

  if (!frontmatter.description) {
    problems.push({
      level: 'warning',
      message: 'This skill has no description, so I have nothing to decide when to use it on.',
    });
  } else if (frontmatter.description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    problems.push({
      level: 'warning',
      message: `Its description is long (${frontmatter.description.length} characters, over the ${SKILL_DESCRIPTION_MAX_CHARS} limit), which slows every chat a little.`,
    });
  }

  return problems;
}

export interface ImportIdDecision {
  /** The id the skill would take. Unchanged from the source directory name. */
  id: string;
  /** Set when `id` is already taken in the store. */
  collides: boolean;
  /**
   * A free id, offered so the UI can present "import as …" as one click.
   * Absent when there is no collision. NEVER applied automatically.
   */
  suggestedId?: string;
}

/**
 * The name-collision policy, which §7 of the design doc leaves open.
 *
 * **Decision: never rename silently, never replace silently. Report the
 * collision and offer a free id; the user chooses.**
 *
 * The case is real, not hypothetical, though NOT where the design doc says it
 * is. Measured against both catalogues at their current heads:
 *
 * - `anthropics/skills` ships `docx`, `pdf`, `pptx` and `xlsx`, and Acabox
 *   ships built-ins with all four names. **That** is the collision.
 * - `openai/plugins` ships none of the four. Its 581 browsable skills collide
 *   with nothing Acabox ships — the design doc's §7 prerequisite attributes
 *   the document-skill collision to the wrong repository.
 * - `openai/plugins` does collide with ITSELF: six ids appear twice
 *   (`react-best-practices`, `stripe-best-practices`, `cli`, `agents-sdk`,
 *   `setup`, `chronograph-portfolio-company-one-pager`). Importing both
 *   copies of one hits this function on the second, which is why the check is
 *   against the store's ids rather than against a builtin list.
 *
 * The three available policies and why this one:
 *
 * - *Suffix automatically.* The id is what the model types into
 *   `Skill({skill})` and what the skill's own prose refers to; changing it
 *   without saying so produces a skill whose body describes a name that does
 *   not exist.
 * - *Replace the built-in.* Destroys the user's built-in silently on a button
 *   labelled "Import", and the store's revert path would then have two
 *   pristine sources for one id.
 * - *Refuse outright.* Correct but useless — `anthropics/skills`'s `pdf` may
 *   genuinely be the one the user wants.
 *
 * So: surface it. The suggestion is `<id>-<owner>` (`pdf-anthropics`), which
 * is both free and self-explanatory, falling back to a numeric suffix.
 */
export function resolveImportId(
  id: string,
  source: SkillSource,
  existingIds: readonly string[],
): ImportIdDecision {
  const taken = new Set(existingIds);
  if (!taken.has(id)) return { id, collides: false };

  const candidates: string[] = [];
  const owner = (source.owner ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (owner) candidates.push(`${id}-${owner}`);
  for (let n = 2; n <= 20; n++) candidates.push(`${id}-${n}`);

  const suggestedId = candidates.find((c) => !taken.has(c) && validateSkillId(c).ok);
  return { id, collides: true, suggestedId };
}

// ---------------------------------------------------------------------------
// Fetching one skill
// ---------------------------------------------------------------------------

export interface FetchedSkill {
  /** The DIRECTORY name. The identity the CLI uses; see `validateImportedSkill`. */
  id: string;
  /** Where the bytes are — the staging directory the caller passed in. */
  path: string;
  source: SkillSource;
  frontmatter: SkillFrontmatter;
  declared: SkillDeclaredMetadata;
  /** Frontmatter `name` disagrees with the directory name. Display only. */
  aliasOfDirName: boolean;
  skillMdBytes: number;
  fileCount: number;
  execCount: number;
  execPaths: string[];
  totalBytes: number;
  /** Removed by the safety pass. Non-empty is worth showing the user. */
  strippedSymlinks: StrippedLink[];
  /**
   * relPath -> git blob SHA at the pinned commit, computed locally from the
   * archive bytes. Goes straight into the provenance record; `checkForUpdate`
   * diffs a tree listing against it later.
   */
  upstreamBlobs: Record<string, string>;
  problems: SkillImportProblem[];
  /** The body, so the caller can show it before committing. */
  skillMd: string;
}

export interface GithubSubdirRequest {
  owner: string;
  repo: string;
  /** Resolved 40-char commit SHA. Callers get one from `resolveRef`. */
  sha: string;
  subpath: string;
  /** The ref the user pasted, carried into the provenance record for display. */
  ref?: string;
}

function githubTreeUrl(req: GithubSubdirRequest): string {
  const suffix = req.subpath ? `/${req.subpath}` : '';
  return `https://github.com/${req.owner}/${req.repo}/tree/${req.sha}${suffix}`;
}

/**
 * Download `<owner>/<repo>@<sha>`, extract `<subpath>` into `destDir`, make it
 * safe, and describe it.
 *
 * `destDir` is a STAGING directory owned by the caller: it must not already
 * exist, and it is removed again if anything here throws, so a failed import
 * never leaves half a skill behind for the store's reconciler to adopt. The
 * caller does the atomic move into the store.
 */
export async function fetchSubtree(
  req: GithubSubdirRequest,
  destDir: string,
  opts: FetchOptions = {},
): Promise<FetchedSkill> {
  if (!/^[0-9a-f]{40}$/i.test(req.sha)) {
    throw new Error(`"${req.sha}" is not a resolved 40-character commit SHA.`);
  }
  const subpath = normalizeSubpath(req.subpath);

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'acabox-skill-'));
  const tarPath = path.join(workDir, 'repo.tar.gz');
  try {
    await downloadTarball(req.owner, req.repo, req.sha, tarPath, opts);
    await extractSubpath(tarPath, req.repo, req.sha, subpath, destDir);
    return await describeExtractedSkill(
      destDir,
      {
        kind: 'github-subdir',
        owner: req.owner,
        repo: req.repo,
        ref: req.ref,
        sha: req.sha.toLowerCase(),
        subpath,
        url: githubTreeUrl({ ...req, subpath }),
      },
      // A repo whose root IS the skill takes the repo's own name.
      subpath ? (subpath.split('/').pop() as string) : req.repo,
    );
  } catch (err) {
    await fsp.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Everything after the bytes have landed: strip links, scan, hash, parse,
 * validate. Shared by the tarball path, the catalogue path and the
 * local-folder path so all three disclose exactly the same things.
 *
 * `id` is passed in rather than taken from `basename(dir)` because `dir` is a
 * staging directory whose name is the caller's business. The identity of a
 * skill is the directory name it had AT ITS SOURCE — the last segment of the
 * repo subpath, or of the local folder — and that is what the CLI will see
 * once the store renders the symlink.
 */
async function describeExtractedSkill(
  dir: string,
  source: SkillSource,
  id: string,
): Promise<FetchedSkill> {
  // Order matters: nothing else may look at the tree until the links are gone.
  const strippedSymlinks = await stripSymlinks(dir);
  const scan = await scanTree(dir);

  if (scan.fileCount > MAX_SKILL_FILES) {
    throw new Error(`This directory holds ${scan.fileCount} files, past the ${MAX_SKILL_FILES}-file import limit. It is probably a whole repository rather than one skill.`);
  }
  if (scan.totalBytes > MAX_SKILL_BYTES) {
    throw new Error(`This directory is ${Math.round(scan.totalBytes / 1024 / 1024)} MB, past the ${Math.round(MAX_SKILL_BYTES / 1024 / 1024)} MB import limit.`);
  }
  if (!scan.files.includes(SKILL_FILE)) {
    throw new Error(`No ${SKILL_FILE} here, so this is not a skill. A skill is a directory with ${SKILL_FILE} at its root.`);
  }

  const skillMdPath = path.join(dir, SKILL_FILE);
  const skillMd = await fsp.readFile(skillMdPath, 'utf8');
  const skillMdBytes = (await fsp.lstat(skillMdPath)).size;
  const frontmatter = parseSkillFrontmatter(skillMd);

  const declared: SkillDeclaredMetadata = {
    name: frontmatter.name,
    description: frontmatter.description,
    license: frontmatter.license,
  };

  return {
    id,
    path: dir,
    source,
    frontmatter,
    declared,
    aliasOfDirName: Boolean(frontmatter.name && frontmatter.name !== id),
    skillMdBytes,
    fileCount: scan.fileCount,
    execCount: scan.execCount,
    execPaths: scan.execPaths,
    totalBytes: scan.totalBytes,
    strippedSymlinks,
    upstreamBlobs: await computeBlobShas(dir, scan.files),
    problems: validateImportedSkill(id, frontmatter),
    skillMd,
  };
}

/**
 * Import a directory the user already has on disk. Copied (never linked) into
 * a staging dir and put through the identical safety pass, because a local
 * folder can hold a symlink just as easily as a tarball can.
 *
 * `upstreamBlobs` is still populated: git blob SHAs are a property of the
 * bytes, not of GitHub, so a local import that is later pointed at a repo can
 * be diffed without re-reading everything.
 */
export async function importLocalFolder(srcDir: string, destDir: string): Promise<FetchedSkill> {
  const resolved = path.resolve(srcDir);
  const stat = await fsp.lstat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`${resolved} is not a directory.`);
  }
  try {
    // dereference: a link inside the source is followed once here and then
    // cannot exist in the copy, which is the same end state stripSymlinks
    // reaches — except that a link the user deliberately placed brings its
    // bytes along rather than vanishing.
    await fsp.cp(resolved, destDir, { recursive: true, dereference: true, errorOnExist: true, force: false });
    return await describeExtractedSkill(
      destDir,
      { kind: 'local-folder', localPath: resolved },
      path.basename(resolved),
    );
  } catch (err) {
    await fsp.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The catalogue path — one tarball, the whole browsable list
// ---------------------------------------------------------------------------

export interface CatalogueSkill {
  /** Directory name, i.e. the id this skill would take in the store. */
  id: string;
  /** Path inside the repository, e.g. `plugins/airtable/skills/airtable-cli`. */
  subpath: string;
  declaredName?: string;
  description?: string;
  whenToUse?: string;
  license?: string;
  frontmatterOk: boolean;
  frontmatterError?: string;
  skillMdBytes: number;
  fileCount: number;
  execCount: number;
  /** Plugin that owns it, when a marketplace manifest says so. */
  plugin?: string;
  category?: string;
}

export interface SkillCatalogue {
  owner: string;
  repo: string;
  ref?: string;
  sha: string;
  /** `marketplace.json`'s `name`, e.g. `openai-curated`. The `importedFrom` value. */
  marketplaceName?: string;
  /**
   * The repo-relative path `stagingDir` is rooted at — `''` for a whole repo.
   * `CatalogueSkill.subpath` is always repo-relative so the provenance record
   * and the tree URL are right; this is what converts one back to the other.
   */
  scopeSubpath: string;
  /** Where the archive is unpacked. Valid until `dispose()`. */
  stagingDir: string;
  skills: CatalogueSkill[];
  /** Bytes downloaded, so the caller can say what the browse cost. */
  archiveBytes: number;
  dispose(): Promise<void>;
}

interface MarketplacePlugin {
  name?: unknown;
  category?: unknown;
  source?: unknown;
  skills?: unknown;
}

/**
 * Read a marketplace manifest if the repo has one, and reduce it to the only
 * two things a browse list needs: a catalogue name, and a path -> plugin map.
 *
 * Two shapes exist in the wild and neither is a standard:
 * - `openai/plugins` (`.agents/plugins/marketplace.json`): 180 entries, each
 *   `{name, source: {source: 'local', path: './plugins/x'}, category}`. The
 *   path is a PREFIX — the skills live at `plugins/x/skills/*`.
 * - `anthropics/skills` (`.claude-plugin/marketplace.json`): entries carry an
 *   explicit `skills: ['./skills/xlsx', …]` list, which is an EXACT match.
 *
 * Anything unrecognised is ignored rather than guessed at: the catalogue is
 * built from `SKILL.md` files on disk, and the manifest only decorates it. A
 * skill with no manifest entry gets no plugin chip, which is the honest
 * rendering.
 */
async function readMarketplace(stagingDir: string): Promise<{
  name?: string;
  exact: Map<string, { plugin?: string; category?: string }>;
  prefixes: Array<{ prefix: string; plugin?: string; category?: string }>;
}> {
  const exact = new Map<string, { plugin?: string; category?: string }>();
  const prefixes: Array<{ prefix: string; plugin?: string; category?: string }> = [];

  for (const rel of MARKETPLACE_PATHS) {
    const file = path.join(stagingDir, rel);
    const text = await fsp.readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      log.warn(`[SkillImport] ${rel} is not valid JSON, ignoring: ${(err as Error).message}`);
      continue;
    }

    const name = typeof parsed.name === 'string' ? parsed.name : undefined;
    const plugins = Array.isArray(parsed.plugins) ? (parsed.plugins as MarketplacePlugin[]) : [];
    for (const plugin of plugins) {
      const pluginName = typeof plugin?.name === 'string' ? plugin.name : undefined;
      const category = typeof plugin?.category === 'string' ? plugin.category : undefined;

      if (Array.isArray(plugin?.skills)) {
        for (const entry of plugin.skills) {
          if (typeof entry !== 'string') continue;
          exact.set(cleanManifestPath(entry), { plugin: pluginName, category });
        }
        continue;
      }
      const src = plugin?.source;
      const srcPath =
        typeof src === 'string'
          ? src
          : src && typeof src === 'object' && typeof (src as { path?: unknown }).path === 'string'
            ? (src as { path: string }).path
            : undefined;
      // `source: './'` means the whole repo, which would claim every skill.
      const prefix = srcPath ? cleanManifestPath(srcPath) : '';
      if (prefix) prefixes.push({ prefix, plugin: pluginName, category });
    }
    return { name, exact, prefixes };
  }

  return { exact, prefixes };
}

/** `./plugins/linear` -> `plugins/linear`. */
function cleanManifestPath(raw: string): string {
  return raw.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Download a whole repository once and enumerate every skill in it.
 *
 * This is the `https://github.com/openai/plugins` case, measured at its
 * current head: 21,668,963 bytes in ~6 s, 608 `SKILL.md` files, **581 browse
 * entries**, and **zero further API calls** — the descriptions the browse list
 * shows are parsed off local disk, and picking one costs a copy rather than a
 * second request. The alternative (one contents call per directory) is 581
 * requests against a 60/hr budget, i.e. ten hours.
 *
 * The 608 → 581 gap is `findSkillDirs`'s two rules, and both are deliberate:
 * 26 files sit inside another skill's directory (`plugins/zoom/skills/
 * contact-center/{android,ios,web}`) and travel with their parent rather than
 * being offered as fragments, and 1 sits in a dot-directory
 * (`.agents/skills/plugin-creator`, the repo's own authoring tooling). A
 * dot-directory skill is still importable by pasting its URL directly.
 *
 * The archive stays unpacked in `stagingDir` for exactly that reason. The
 * caller MUST `dispose()` it when the picker closes.
 */
export async function fetchCatalogue(
  target: { owner: string; repo: string; sha: string; ref?: string; subpath?: string },
  opts: FetchOptions = {},
): Promise<SkillCatalogue> {
  if (!/^[0-9a-f]{40}$/i.test(target.sha)) {
    throw new Error(`"${target.sha}" is not a resolved 40-character commit SHA.`);
  }
  const scopeSubpath = normalizeSubpath(target.subpath ?? '');

  const stagingDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'acabox-catalogue-'));
  const tarPath = path.join(stagingDir, 'repo.tar.gz');
  const treeDir = path.join(stagingDir, 'tree');

  const dispose = async () => {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    const archiveBytes = await downloadTarball(target.owner, target.repo, target.sha, tarPath, opts);
    await extractSubpath(tarPath, target.repo, target.sha, scopeSubpath, treeDir);
    // Freeing 21 MB before we walk the tree; nothing below re-reads it.
    await fsp.rm(tarPath, { force: true }).catch(() => undefined);

    // The safety pass runs over the WHOLE archive, not per pick. A catalogue
    // is browsed by reading files out of it, and a link planted three
    // directories away from the skill the user eventually picks is still a
    // link we materialised on their disk.
    await stripSymlinks(treeDir);

    const marketplace = await readMarketplace(treeDir);
    const skillDirs = await findSkillDirs(treeDir);

    const skills: CatalogueSkill[] = [];
    for (const relDir of skillDirs) {
      const abs = path.join(treeDir, ...relDir.split('/'));
      const skillMdPath = path.join(abs, SKILL_FILE);
      const [text, stat, scan] = await Promise.all([
        fsp.readFile(skillMdPath, 'utf8').catch(() => ''),
        fsp.lstat(skillMdPath).catch(() => null),
        scanTree(abs),
      ]);
      const frontmatter = parseSkillFrontmatter(text);
      const decoration =
        marketplace.exact.get(relDir) ??
        marketplace.prefixes.find((p) => relDir === p.prefix || relDir.startsWith(`${p.prefix}/`));

      const id = relDir.split('/').pop() ?? relDir;
      skills.push({
        id,
        // Paths are reported relative to the REPO, not to the scope, so the
        // provenance record and the tree URL are right whether the user
        // pasted a repo root or a subdirectory.
        subpath: scopeSubpath ? `${scopeSubpath}/${relDir}` : relDir,
        declaredName: frontmatter.name && frontmatter.name !== id ? frontmatter.name : undefined,
        description: frontmatter.description,
        whenToUse: frontmatter.whenToUse,
        license: frontmatter.license,
        frontmatterOk: frontmatter.ok,
        frontmatterError: frontmatter.error,
        skillMdBytes: stat?.size ?? 0,
        fileCount: scan.fileCount,
        execCount: scan.execCount,
        plugin: decoration?.plugin,
        category: decoration?.category,
      });
    }
    skills.sort((a, b) => (a.subpath < b.subpath ? -1 : a.subpath > b.subpath ? 1 : 0));

    log.info(
      `[SkillImport] Catalogue ${target.owner}/${target.repo}@${target.sha.slice(0, 7)}: ` +
        `${skills.length} skills from ${archiveBytes} bytes, 0 API calls`,
    );

    return {
      owner: target.owner,
      repo: target.repo,
      ref: target.ref,
      sha: target.sha.toLowerCase(),
      marketplaceName: marketplace.name,
      scopeSubpath,
      stagingDir: treeDir,
      skills,
      archiveBytes,
      dispose,
    };
  } catch (err) {
    await dispose();
    throw err;
  }
}

/**
 * Every directory in the tree holding a `SKILL.md`, relative to `root`.
 *
 * Does NOT descend into a directory that already has one: `references/` and
 * `assets/` belong to their skill, and a nested `SKILL.md` (the
 * `skill-creator` template case) is documentation, not a second skill.
 * Dot-directories are skipped so `.claude-plugin` and `.github` never appear.
 */
async function findSkillDirs(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => e.isFile() && e.name === SKILL_FILE)) {
      if (rel) found.push(rel);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      await walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
    }
  }

  await walk(root, '');
  found.sort();
  return found;
}

/**
 * Take one skill out of an already-downloaded catalogue. No network at all —
 * this is the payoff for holding the staging directory open.
 */
export async function importFromCatalogue(
  catalogue: SkillCatalogue,
  subpath: string,
  destDir: string,
): Promise<FetchedSkill> {
  const entry = catalogue.skills.find((s) => s.subpath === subpath);
  if (!entry) {
    throw new Error(`"${subpath}" is not in the ${catalogue.owner}/${catalogue.repo} catalogue.`);
  }
  // `subpath` is repo-relative; the staging tree is rooted at the scope the
  // catalogue was fetched with, so strip that prefix back off.
  const scope = catalogue.scopeSubpath;
  const stagingRel = scope ? entry.subpath.slice(scope.length + 1) : entry.subpath;
  const srcDir = path.join(catalogue.stagingDir, ...stagingRel.split('/').filter(Boolean));

  try {
    await fsp.cp(srcDir, destDir, { recursive: true, errorOnExist: true, force: false });
    return await describeExtractedSkill(
      destDir,
      {
        kind: 'github-subdir',
        owner: catalogue.owner,
        repo: catalogue.repo,
        ref: catalogue.ref,
        sha: catalogue.sha,
        subpath: entry.subpath,
        url: githubTreeUrl({
          owner: catalogue.owner,
          repo: catalogue.repo,
          sha: catalogue.sha,
          subpath: entry.subpath,
        }),
      },
      entry.id,
    );
  } catch (err) {
    await fsp.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Update check — one API call, zero downloads
// ---------------------------------------------------------------------------

export type SkillFileUpdateStatus = 'unchanged' | 'changed' | 'added' | 'removed';

export interface SkillFileUpdate {
  path: string;
  status: SkillFileUpdateStatus;
  /** Blob SHA upstream has now. Absent when the file is gone upstream. */
  upstreamSha?: string;
  /** Blob SHA recorded at the pin. Absent when upstream added the file. */
  pinnedSha?: string;
}

export interface SkillUpdateReport {
  owner: string;
  repo: string;
  /** The ref that was queried, which may be a moving branch. */
  ref: string;
  /** The commit SHA the skill is pinned at. */
  pinnedSha: string;
  /** Tree SHA of the subpath at `ref` right now. */
  treeSha: string;
  /** Nothing changed, added or removed. */
  upToDate: boolean;
  files: SkillFileUpdate[];
  /**
   * Paths skipped because they are symlinks or submodules upstream. We strip
   * symlinks on import, so comparing them would report a phantom deletion on
   * every check forever. Listed rather than hidden.
   */
  skipped: string[];
}

interface TreeEntry {
  path?: unknown;
  type?: unknown;
  mode?: unknown;
  sha?: unknown;
}

/**
 * Ask GitHub what the pinned subpath looks like now, and compare it file by
 * file against the blob SHAs recorded at import.
 *
 * ONE metadata request. Never on a timer — 60/hr is the entire budget and it
 * is shared with `resolveRef`. This is the "Check for updates" button on a
 * row, and nothing else.
 *
 * The verdict is per file on purpose. Two independent hash sets exist in the
 * provenance record (`upstreamBlobs` here, `baseline` in the store), and it is
 * the pairing that lets a user take an upstream fix to `scripts/run.py` while
 * keeping their own accreted edits to `SKILL.md`. A repo-level "outdated" flag
 * cannot express that.
 *
 * The tree endpoint takes `<ref>:<subpath>` and `?recursive=1`, so one call
 * returns the whole subtree. `truncated` (>100k entries) is reported as an
 * error rather than silently producing a diff missing half the files.
 */
export async function checkForUpdate(
  source: SkillSource,
  pinnedBlobs: Record<string, string>,
  opts: ApiOptions = {},
): Promise<SkillUpdateReport> {
  if (source.kind !== 'github-subdir' || !source.owner || !source.repo) {
    throw new Error('This skill was not imported from GitHub, so there is nothing to check it against.');
  }
  const { owner, repo } = source;
  const ref = source.ref?.trim() || 'HEAD';
  const subpath = normalizeSubpath(source.subpath ?? '');

  // `<ref>:<subpath>` — the colon is meaningful to GitHub and the subpath's
  // own slashes must survive, so encode the path components, not the whole
  // expression.
  const spec = subpath ? `${encodeURIComponent(ref)}:${encodeURIComponent(subpath)}` : encodeURIComponent(ref);
  const url = `${GITHUB_API_ORIGIN}/repos/${owner}/${repo}/git/trees/${spec}?recursive=1`;

  const res = await net.fetch(url, {
    headers: apiHeaders('application/vnd.github+json', opts.token),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(describeApiFailure(res, `Checking ${owner}/${repo}@${ref}`));
  }
  const body = (await res.json()) as { sha?: unknown; tree?: unknown; truncated?: unknown };
  if (body.truncated === true) {
    throw new Error(`GitHub truncated its listing of ${owner}/${repo}:${subpath || '/'}; it is too large to compare.`);
  }
  const tree = Array.isArray(body.tree) ? (body.tree as TreeEntry[]) : [];

  const upstream = new Map<string, string>();
  const skipped: string[] = [];
  for (const entry of tree) {
    if (typeof entry?.path !== 'string' || typeof entry?.sha !== 'string') continue;
    if (entry.type === 'tree') continue;
    // 120000 is a symlink, `commit` is a submodule. We import neither, so
    // comparing them would report a permanent phantom difference.
    if (entry.type === 'commit' || entry.mode === '120000') {
      skipped.push(entry.path);
      continue;
    }
    upstream.set(entry.path, entry.sha.toLowerCase());
  }

  const files: SkillFileUpdate[] = [];
  for (const [rel, upstreamSha] of upstream) {
    const pinnedSha = pinnedBlobs[rel]?.toLowerCase();
    if (!pinnedSha) {
      files.push({ path: rel, status: 'added', upstreamSha });
    } else {
      files.push({
        path: rel,
        status: pinnedSha === upstreamSha ? 'unchanged' : 'changed',
        upstreamSha,
        pinnedSha,
      });
    }
  }
  for (const rel of Object.keys(pinnedBlobs)) {
    if (!upstream.has(rel) && !skipped.includes(rel)) {
      files.push({ path: rel, status: 'removed', pinnedSha: pinnedBlobs[rel].toLowerCase() });
    }
  }
  // Code-point order, not `localeCompare`: ICU collation is locale-dependent,
  // and this list is compared against a recorded one.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    owner,
    repo,
    ref,
    pinnedSha: (source.sha ?? '').toLowerCase(),
    treeSha: typeof body.sha === 'string' ? body.sha : '',
    upToDate: files.every((f) => f.status === 'unchanged'),
    files,
    skipped,
  };
}
