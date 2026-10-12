import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import * as fs from "fs/promises";
import log from "electron-log";
import Anthropic from "@anthropic-ai/sdk";
import { upsertScannedFiles } from "../../db/scannedFilesRepository";
import { createBriefing } from "../../db/briefingsRepository";
import { extractText } from "../../fileMonitor/textExtractor";
import { REFERENCES_DIR, REFERENCES_INDEX } from "../../../shared/paths";
import { BACKGROUND_MODEL, BACKGROUND_REQUEST, messageText } from "../../../shared/models";
import {
  SYSTEM_PROMPT_PREAMBLE,
  buildCommonQueryOptions,
  consumeAgentStream,
  formatTreesForPrompt,
  type ScanContext,
  type TaggedFileParsed,
  type TreeOutput,
} from "../shared";

interface ManuscriptCandidate {
  filePath: string;
  scannerDescription: string;
}

export interface FileTaggingResult {
  taggedFiles: TaggedFileParsed[];
}

export async function runFileTaggingAgent(
  ctx: ScanContext,
): Promise<FileTaggingResult> {
  const startTime = Date.now();
  log.info("[DirectoryScanner:FileTagging] Starting file tagging agent");

  const agentQuery = query({
    prompt: buildPrompt(ctx.directoryPaths, ctx.treeOutputs),
    options: {
      ...buildCommonQueryOptions(ctx),
      model: BACKGROUND_MODEL,
      systemPrompt: buildSystemPrompt(),
      maxTurns: 15,
      maxBudgetUsd: 1,
      outputFormat: {
        type: "json_schema",
        schema: FILE_TAGGING_SCHEMA,
      },
    },
  });

  const { tagged_files } = await consumeAgentStream<{
    tagged_files: TaggedFileParsed[];
  }>(agentQuery);

  const seconds = Math.round((Date.now() - startTime) / 1000);
  log.info(
    `[DirectoryScanner:FileTagging] Completed in ${seconds}s (${tagged_files.length} tagged files)`,
  );

  const autoTagged = await autoTagReferencePdfs(tagged_files, ctx);
  const allFiles = [...tagged_files, ...autoTagged];

  persistTaggedFiles(allFiles, ctx.workspaceId, ctx.reportId, ctx.directoryPaths);
  await enrichManuscripts(extractManuscriptCandidates(allFiles), ctx);
  await enrichReferences(extractReferenceCandidates(allFiles), ctx);
  return { taggedFiles: allFiles };
}

const MIN_TEXT_LENGTH_FOR_REFERENCE = 500;

async function findAllPdfs(dirPath: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.toLowerCase().endsWith(".pdf")) {
        results.push(fullPath.slice(dirPath.length + 1));
      }
    }
  }
  await walk(dirPath);
  return results;
}

async function autoTagReferencePdfs(
  taggedFiles: TaggedFileParsed[],
  ctx: ScanContext,
): Promise<TaggedFileParsed[]> {
  const scanDirs = ctx.directoryPaths;
  const taggedPaths = new Set(
    taggedFiles.map((f) =>
      normalizeFilePath(getFilePath(f) ?? "", scanDirs),
    ),
  );

  const allPdfs: string[] = [];
  for (const dir of scanDirs) {
    allPdfs.push(...(await findAllPdfs(dir)));
  }
  const untagged = allPdfs.filter((p) => !taggedPaths.has(p));
  if (untagged.length === 0) return [];

  log.info(
    `[DirectoryScanner:AutoTag] Inspecting ${untagged.length} untagged PDFs`,
  );

  const client = new Anthropic({ apiKey: ctx.apiKey, baseURL: ctx.baseURL });
  const results: TaggedFileParsed[] = [];
  for (const relPath of untagged) {
    try {
      const absolutePath = await resolveFilePath(relPath, scanDirs);
      const text = await extractText(absolutePath);
      if (!text || text.length < MIN_TEXT_LENGTH_FOR_REFERENCE) continue;

      const excerpt = text.slice(0, 1500);
      const message = await client.messages.create({
        ...BACKGROUND_REQUEST,
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content: `Is this a published academic research paper, journal article, or preprint? Answer only YES or NO.

Not research papers: grant applications, cover letters, letters of support, biosketches, budgets, presentations, reports, memos, forms, CVs, charts, or any administrative document.

Filename: ${relPath.split("/").pop()}

Text excerpt:
${excerpt}`,
          },
        ],
      });

      const answer = messageText(message).trim().toUpperCase();
      if (answer?.startsWith("YES")) {
        results.push({
          file_path: relPath,
          file_name: relPath.split("/").pop() ?? relPath,
          file_type: "reference",
        } as any);
        log.info(`[DirectoryScanner:AutoTag] ${relPath} → reference`);
      }
    } catch {
      // skip files that can't be read or classified
    }
  }

  log.info(
    `[DirectoryScanner:AutoTag] Tagged ${results.length}/${untagged.length} untagged PDFs as references`,
  );
  return results;
}

function normalizeFilePath(filePath: string, scanDirs: string | string[]): string {
  const dirs = Array.isArray(scanDirs) ? scanDirs : [scanDirs];
  const withSlash = "/" + filePath;
  for (const dir of dirs) {
    if (withSlash.startsWith(dir + "/")) {
      return withSlash.slice(dir.length + 1);
    }
  }
  return filePath;
}

function persistTaggedFiles(
  taggedFiles: TaggedFileParsed[],
  workspaceId: string,
  reportId: string,
  scanDirs: string[],
): void {
  try {
    const seen = new Set<string>();
    const normalised = taggedFiles
      .map((f) => ({
        file_path: normalizeFilePath(
          ((f as any).file_path ?? (f as any).path) as string,
          scanDirs,
        ),
        file_name: ((f as any).file_name ?? (f as any).filename) as string,
        file_type: ((f as any).file_type ?? (f as any).type) as string,
      }))
      .filter((f) => {
        if (!f.file_path || !f.file_name) return false;
        if (f.file_name.startsWith("~$")) return false;
        if (seen.has(f.file_path)) return false;
        seen.add(f.file_path);
        return true;
      });
    upsertScannedFiles(workspaceId, reportId, normalised);
  } catch (err) {
    log.error("[DirectoryScanner] Failed to persist tagged files:", err);
  }
}

function extractManuscriptCandidates(
  taggedFiles: TaggedFileParsed[],
): ManuscriptCandidate[] {
  return taggedFiles
    .filter((f) => {
      const p = getFilePath(f);
      if (!p || !p.toLowerCase().endsWith(".docx")) return false;
      const name = p.split("/").pop() ?? "";
      if (name.startsWith("~$")) return false;
      const fileType = (
        typeof f.file_type === "string"
          ? f.file_type
          : typeof (f as any).type === "string"
            ? (f as any).type
            : ""
      ).toLowerCase();
      return fileType === "manuscript";
    })
    .map((f) => ({ filePath: getFilePath(f)!, scannerDescription: "" }));
}

function getFilePath(f: {
  file_path?: unknown;
  path?: unknown;
}): string | undefined {
  if (typeof f.file_path === "string") return f.file_path;
  if (typeof f.path === "string") return f.path;
  return undefined;
}

const FILE_TAGGING_SCHEMA = {
  type: "object" as const,
  properties: {
    tagged_files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Relative path to the file from the workspace root.",
          },
          file_name: {
            type: "string",
            description: "The filename only (basename, including extension).",
          },
          file_type: {
            type: "string",
            enum: ["manuscript", "grant", "presentation", "reference"],
            description:
              "manuscript = academic paper, thesis, chapter, or dissertation (.tex, .docx, .md). grant = grant proposal, funding application, NIH/NSF/R01 submission. presentation = .pptx, .key, talks, slides, lab-meeting files. reference = published journal articles, preprints, or background reading PDFs (NOT generated analysis plots, figures, or charts).",
          },
        },
        required: ["file_path", "file_name", "file_type"],
      },
      description:
        "All manuscript, grant, presentation, and reference files found in the directory.",
    },
  },
  required: ["tagged_files"],
};

function buildSystemPrompt(): string {
  return `You are a research directory file tagger. Your job is to quickly scan a researcher's file directory and identify all manuscripts, grants, presentations, and references.

${SYSTEM_PROMPT_PREAMBLE}

## Output

Produce a JSON report with one field:

**tagged_files**: A comprehensive list of ALL manuscript, grant, presentation, and reference files you find. For each file, record the relative path, the filename, and its type:
- \`manuscript\`: .tex, .docx, .md files that are academic papers, theses, chapters, or dissertations
- \`grant\`: files or directories whose names or contents indicate grant proposals, funding applications, or NIH/NSF/R01 submissions
- \`presentation\`: .pptx or .key files, or directories with names like "talks", "slides", "lab-meeting"
- \`reference\`: PDF files that are published journal articles, preprints, or background reading papers written by OTHER researchers that this researcher is citing or reading. Filenames often contain author names, journal abbreviations, or publication years.
  **NOT references**: PDFs that are generated computational outputs — plots, figures, charts, heatmaps, enrichment results, statistical summaries, or any file produced by an analysis pipeline. These typically sit inside sequencing, proteomics, or bioinformatics analysis directories and have short descriptive names. Do NOT tag these as references.
  When in doubt about a PDF, skip it — false positives clutter the reference list.

Cast a wide net for manuscripts, grants, and presentations. For references, be selective — only tag PDFs you are confident are published papers or preprints, not analysis outputs. This list populates file pickers in writing tools, so accuracy matters. Do NOT include code, data, or general documents.

You can largely identify files from the directory tree — use file extensions and directory names. Only use Read/Grep on ambiguous files where you need to check content to determine the type.`;
}

function buildPrompt(directoryPaths: string[], treeOutputs: TreeOutput[]): string {
  const multi = directoryPaths.length > 1;
  const dirDescription = multi
    ? `The directories to analyze are:\n${directoryPaths.map((dp, i) => `${i + 1}. ${dp}`).join("\n")}`
    : `The directory to analyze is: ${directoryPaths[0]}`;

  const treeSection = multi
    ? formatTreesForPrompt(treeOutputs)
    : `\`\`\`\n${treeOutputs[0].tree}\n\`\`\``;

  return `Identify and tag all manuscript, grant, presentation, and reference files in ${multi ? "these research directories" : "this research directory"}.

${dirDescription}

Use the directory ${multi ? "trees" : "tree"} below to identify files. You can determine most file types from extensions and directory names alone. Only read files when you need to disambiguate.

Work as quickly as possible.

## Directory ${multi ? "trees" : "tree"}

All non-hidden files in the workspace, sorted by modification time (most recent first), with dates:

${treeSection}`;
}

function isWithinAllowedDirs(resolved: string, directoryPaths: string[]): boolean {
  return directoryPaths.some((dp) => {
    const root = path.resolve(dp);
    return resolved === root || resolved.startsWith(root + path.sep);
  });
}

async function resolveFilePath(filePath: string, directoryPaths: string[]): Promise<string> {
  const candidates: string[] = [];

  if (path.isAbsolute(filePath)) {
    candidates.push(path.resolve(filePath));
  } else {
    for (const dp of directoryPaths) {
      candidates.push(path.resolve(dp, filePath));
      // tree-node-cli includes the directory basename as the tree root,
      // so the agent may return paths like "DemoWorkspace/file.docx" —
      // strip the prefix to avoid doubling when joined with the full path.
      const basename = path.basename(dp);
      if (filePath.startsWith(basename + '/')) {
        candidates.push(path.resolve(dp, filePath.slice(basename.length + 1)));
      }
    }
  }

  for (const candidate of candidates) {
    if (!isWithinAllowedDirs(candidate, directoryPaths)) continue;
    try { await fs.access(candidate); return candidate; } catch {}
  }

  return path.resolve(directoryPaths[0], filePath);
}

const WRITING_AGENT_KICKOFF_PROMPT =
  "Review this manuscript. Read the document, assess its current state, and provide a structured peer review.";

function extractReferenceCandidates(
  taggedFiles: TaggedFileParsed[],
): string[] {
  return taggedFiles
    .filter((f) => {
      const fileType = (
        typeof f.file_type === "string"
          ? f.file_type
          : typeof (f as any).type === "string"
            ? (f as any).type
            : ""
      ).toLowerCase();
      if (fileType !== "reference") return false;
      const p = getFilePath(f);
      if (!p) return false;
      const name = p.split("/").pop() ?? "";
      return !name.startsWith("~$");
    })
    .map((f) => getFilePath(f)!);
}

function resolveSourcePath(sourceDir: string, filePath: string): string {
  const resolved = path.resolve(sourceDir, filePath);
  const boundary = path.resolve(sourceDir) + path.sep;
  if (!resolved.startsWith(boundary) && resolved !== path.resolve(sourceDir)) {
    throw new Error(`Path traversal detected: ${filePath} escapes ${sourceDir}`);
  }
  return resolved;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

async function readRefIndex(refsDir: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(
      path.join(refsDir, REFERENCES_INDEX),
      "utf-8",
    );
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeRefIndex(
  refsDir: string,
  index: Record<string, string>,
): Promise<void> {
  await fs.writeFile(
    path.join(refsDir, REFERENCES_INDEX),
    JSON.stringify(index, null, 2),
    "utf-8",
  );
}

async function convertSingleReference(
  filePath: string,
  absolutePath: string,
  refsDir: string,
  client: Anthropic,
): Promise<string | null> {
  const fullText = await extractText(absolutePath);
  if (!fullText) {
    log.warn(
      `[ReferenceConversion] Could not extract text from ${filePath}, skipping`,
    );
    return null;
  }

  const excerpt = fullText.slice(0, 2000);
  const fileName = filePath.split("/").pop() ?? filePath;
  let title = path.basename(fileName, path.extname(fileName));

  try {
    const message = await client.messages.create({
      ...BACKGROUND_REQUEST,
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: `Extract the title of this academic paper from the excerpt below. Return ONLY the title, nothing else. If you cannot determine the title, return the text "UNKNOWN".

Filename: ${fileName}

Excerpt:
${excerpt}`,
        },
      ],
    });

    const extracted = messageText(message).trim();
    if (extracted && extracted !== "UNKNOWN") {
      title = sanitizeFilename(extracted);
    }
  } catch (err) {
    log.warn(
      `[ReferenceConversion] Title extraction failed for ${filePath}, using filename`,
    );
  }

  const mdFilename = `${title}.md`;
  const mdPath = path.join(refsDir, mdFilename);
  const mdContent = `---\nsource: ${filePath}\ntitle: "${title.replace(/"/g, '\\"')}"\n---\n\n${fullText}`;
  await fs.writeFile(mdPath, mdContent, "utf-8");

  log.info(`[ReferenceConversion] Converted: ${filePath} → ${mdFilename}`);
  return mdFilename;
}

async function enrichReferences(
  filePaths: string[],
  ctx: ScanContext,
): Promise<void> {
  if (filePaths.length === 0) return;

  const academiaDir = path.dirname(ctx.memoryDir);
  const refsDir = path.join(academiaDir, REFERENCES_DIR);
  await fs.mkdir(refsDir, { recursive: true });

  const index = await readRefIndex(refsDir);
  const client = new Anthropic({ apiKey: ctx.apiKey, baseURL: ctx.baseURL });
  const total = filePaths.length;
  log.info(
    `[ReferenceConversion] Converting ${total} reference files to markdown`,
  );

  let converted = 0;
  for (const filePath of filePaths) {
    if (index[filePath]) continue;
    try {
      const absolutePath = await resolveFilePath(filePath, ctx.directoryPaths);
      const mdFilename = await convertSingleReference(
        filePath,
        absolutePath,
        refsDir,
        client,
      );
      if (mdFilename) {
        index[filePath] = mdFilename;
        converted++;
      }
    } catch (err) {
      log.error(`[ReferenceConversion] Failed to convert ${filePath}:`, err);
    }
  }

  await writeRefIndex(refsDir, index);
  log.info(
    `[ReferenceConversion] Complete — ${converted}/${total} files converted`,
  );
}

/**
 * Convert a single reference file to markdown. Called when the user
 * manually tags a file as "reference" outside of the scan flow.
 */
export async function convertReferenceFile(opts: {
  filePath: string;
  sourceDir: string;
  workspacePath: string;
  apiKey: string;
  baseURL?: string;
}): Promise<void> {
  const absolutePath = resolveSourcePath(opts.sourceDir, opts.filePath);

  const refsDir = path.join(opts.workspacePath, REFERENCES_DIR);
  await fs.mkdir(refsDir, { recursive: true });

  const index = await readRefIndex(refsDir);
  if (index[opts.filePath]) return;

  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
  });
  const mdFilename = await convertSingleReference(
    opts.filePath,
    absolutePath,
    refsDir,
    client,
  );
  if (mdFilename) {
    index[opts.filePath] = mdFilename;
    await writeRefIndex(refsDir, index);
  }
}

async function enrichManuscripts(
  manuscripts: ManuscriptCandidate[],
  ctx: ScanContext,
): Promise<void> {
  if (manuscripts.length === 0) return;

  const client = new Anthropic({ apiKey: ctx.apiKey, baseURL: ctx.baseURL });

  for (const { filePath, scannerDescription } of manuscripts) {
    try {
      const absolutePath = await resolveFilePath(filePath, ctx.directoryPaths);
      const fullText = await extractText(absolutePath);
      const excerpt = fullText ? fullText.slice(0, 2000) : "";

      if (!excerpt) {
        log.warn(
          `[ManuscriptEnrichment] Could not extract text from ${filePath}, creating with defaults`,
        );
        createBriefing({
          workspaceId: ctx.workspaceId,
          type: "writing_agent",
          sourceReportId: ctx.reportId,
          whyImSuggestingThis:
            scannerDescription ||
            "I can review the introduction of this manuscript and suggest edits.",
          briefingData: {
            file_path: filePath,
            description: scannerDescription,
            chat_prompt: WRITING_AGENT_KICKOFF_PROMPT,
          },
        });
        continue;
      }

      const fileName = filePath.split("/").pop() ?? filePath;
      const message = await client.messages.create({
        ...BACKGROUND_REQUEST,
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: `You are generating a briefing card for a writing assistant that reviews the introduction section of manuscripts. Given this manuscript excerpt, return JSON with:
- "title": A short card title (5-10 words) that references the manuscript's topic and focuses on the introduction, e.g. "Review the intro of your cortisol paper" or "Strengthen the introduction of your HIF-2α draft". Start with "Review" or "Strengthen".
- "description": One sentence describing what the introduction review will focus on, specific to this manuscript's content. E.g. "I'll review how your introduction motivates the RPTEC timecourse study and propose 2–3 edits to strengthen it."

Filename: ${fileName}

Manuscript excerpt:
${excerpt}

Output JSON only. No prose, no code fences.`,
          },
        ],
      });

      const text = messageText(message);
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      let title = "Review your manuscript introduction";
      let description = scannerDescription;

      if (jsonMatch) {
        try {
          const generated = JSON.parse(jsonMatch[0]) as {
            title?: unknown;
            description?: unknown;
          };
          if (typeof generated.title === "string" && generated.title.trim()) {
            title = generated.title.trim();
          }
          if (
            typeof generated.description === "string" &&
            generated.description.trim()
          ) {
            description = generated.description.trim();
          }
        } catch {
          log.warn(
            `[ManuscriptEnrichment] Failed to parse Haiku JSON for ${filePath}`,
          );
        }
      }

      log.info(`[ManuscriptEnrichment] ${filePath} → "${title}"`);
      createBriefing({
        workspaceId: ctx.workspaceId,
        type: "writing_agent",
        sourceReportId: ctx.reportId,
        whyImSuggestingThis:
          description ||
          "I can review the introduction of this manuscript and suggest edits.",
        briefingData: {
          file_path: filePath,
          title,
          description,
          chat_prompt: WRITING_AGENT_KICKOFF_PROMPT,
        },
      });
    } catch (err) {
      log.error(`[ManuscriptEnrichment] Failed to enrich ${filePath}:`, err);
      createBriefing({
        workspaceId: ctx.workspaceId,
        type: "writing_agent",
        sourceReportId: ctx.reportId,
        whyImSuggestingThis:
          scannerDescription ||
          "I can review the introduction of this manuscript and suggest edits.",
        briefingData: {
          file_path: filePath,
          description: scannerDescription,
          chat_prompt: WRITING_AGENT_KICKOFF_PROMPT,
        },
      });
    }
  }
}
