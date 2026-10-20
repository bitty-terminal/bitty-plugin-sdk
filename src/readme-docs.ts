/**
 * Plugin README user-documentation contract.
 *
 * Each plugin repository's `README.md` is its single canonical user document:
 * the GitHub landing page today and the future website ingestion source. The
 * six required H2 sections lead the document in fixed order, and the
 * `Configuration` section carries one table row per declared
 * `bitty-plugin.toml` `[settings]` key. This module validates that shape and
 * renders the table so authors can keep it generated instead of hand-drifted.
 *
 * Validation is pure and offline: two source strings in, diagnostics out.
 */

import { error, type Diagnostic } from "./diagnostics.js";
import {
  ManifestModelError,
  loadManifestModel,
  type ManifestModel,
  type SettingDeclaration,
} from "./manifest-model.js";

/** Canonical README file name at a plugin repository root. */
export const README_FILE_NAME = "README.md";

/** Maximum README size read by the check (1 MiB). */
export const README_MAX_BYTES = 1024 * 1024;

/** Required H2 sections, in the order they must lead the README. */
export const REQUIRED_README_SECTIONS = [
  "Overview",
  "Install",
  "Commands",
  "Configuration",
  "Keybindings",
  "Troubleshooting",
] as const;

/** Required columns of the Configuration settings table. */
export const SETTINGS_TABLE_COLUMNS = [
  "Setting",
  "Type",
  "Default",
  "Description",
] as const;

/** Sentence required when the manifest declares no settings. */
export const NO_SETTINGS_SENTENCE = "This plugin declares no settings.";

/** A README-contract diagnostic tagged with the file it belongs to. */
export interface ReadmeDiagnostic extends Diagnostic {
  /** `bitty-plugin.toml` or `README.md` label. */
  readonly file: string;
}

/** Inputs for one README contract check. */
export interface ReadmeDocsOptions {
  /** Raw `bitty-plugin.toml` source. */
  readonly manifestSource: string;
  /** Raw `README.md` source. */
  readonly readmeSource: string;
  /** Manifest label used in diagnostics (default `bitty-plugin.toml`). */
  readonly manifestPath?: string;
  /** README label used in diagnostics (default `README.md`). */
  readonly readmePath?: string;
}

/** Outcome of one README contract check. */
export interface ReadmeDocsResult {
  readonly valid: boolean;
  readonly diagnostics: readonly ReadmeDiagnostic[];
}

interface Heading {
  readonly level: number;
  readonly text: string;
  readonly line: number;
}

interface TableRow {
  readonly cells: readonly string[];
  readonly line: number;
}

interface FenceState {
  marker: string;
  length: number;
}

const ANY_HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

function stripClosingHashes(text: string): string {
  return text.replace(/\s+#+\s*$/, "").trim();
}

/**
 * Scan ATX headings outside fenced code blocks. Fences are tracked by marker
 * character and length so `##` examples inside documentation code blocks never
 * count as document structure.
 */
function scanHeadings(source: string): Heading[] {
  const headings: Heading[] = [];
  let fence: FenceState | undefined;
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const fenceMatch = FENCE.exec(line);
    if (fence !== undefined) {
      if (
        fenceMatch !== null &&
        fenceMatch[1]?.startsWith(fence.marker) === true &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch !== null) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      continue;
    }
    const match = ANY_HEADING.exec(line);
    if (match === null) continue;
    headings.push({
      level: match[1]!.length,
      text: stripClosingHashes(match[2]!),
      line: index,
    });
  }
  return headings;
}

/** Lines of the first H2 with `text`, up to the next H1/H2. */
function sectionLines(
  source: string,
  headings: readonly Heading[],
  text: string,
):
  { readonly heading: Heading; readonly lines: readonly string[] } | undefined {
  const index = headings.findIndex(
    (heading) => heading.level === 2 && heading.text === text,
  );
  if (index === -1) return undefined;
  const heading = headings[index]!;
  const next = headings.find(
    (candidate) => candidate.level <= 2 && candidate.line > heading.line,
  );
  const all = source.split(/\r?\n/);
  return {
    heading,
    lines: all.slice(
      heading.line + 1,
      next === undefined ? all.length : next.line,
    ),
  };
}

/** Split one GFM table row into cells, honoring `\|` escapes. */
function splitTableRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return undefined;
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  return cells.slice(1);
}

/** Strip optional inline-code backticks from a table cell. */
function plainCell(cell: string): string {
  const trimmed = cell.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isSeparatorRow(cells: readonly string[]): boolean {
  return (
    cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
  );
}

/** Locate the canonical settings table in a section. */
function findSettingsTable(
  lines: readonly string[],
):
  | { readonly headerLine: number; readonly rows: readonly TableRow[] }
  | undefined {
  let fence: FenceState | undefined;
  let headerLine = -1;
  for (const [index, line] of lines.entries()) {
    const fenceMatch = FENCE.exec(line);
    if (fence !== undefined) {
      if (
        fenceMatch !== null &&
        fenceMatch[1]?.startsWith(fence.marker) === true &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch !== null) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      continue;
    }
    const cells = splitTableRow(line);
    if (cells === undefined) continue;
    const header = cells.map(plainCell);
    if (
      header.length === SETTINGS_TABLE_COLUMNS.length &&
      header.every((cell, column) => cell === SETTINGS_TABLE_COLUMNS[column])
    ) {
      headerLine = index;
      break;
    }
  }
  if (headerLine === -1) return undefined;

  const separator = lines[headerLine + 1];
  if (separator === undefined) return undefined;
  const separatorCells = splitTableRow(separator);
  if (separatorCells === undefined || !isSeparatorRow(separatorCells)) {
    return undefined;
  }

  const rows: TableRow[] = [];
  let bodyFence: FenceState | undefined;
  for (let index = headerLine + 2; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = FENCE.exec(line);
    if (bodyFence !== undefined) {
      if (
        fenceMatch !== null &&
        fenceMatch[1]?.startsWith(bodyFence.marker) === true &&
        fenceMatch[1].length >= bodyFence.length
      ) {
        bodyFence = undefined;
      }
      continue;
    }
    if (fenceMatch !== null) break;
    const cells = splitTableRow(line);
    if (cells === undefined) break;
    rows.push({ cells, line: headerLine + 2 + rows.length });
  }
  return { headerLine, rows };
}

function describeKey(key: string): string {
  return `'${key}'`;
}

function checkHeadings(
  headings: readonly Heading[],
  readmePath: string,
  diagnostics: ReadmeDiagnostic[],
): void {
  const h2 = headings.filter((heading) => heading.level === 2);
  const firstSix = h2.slice(0, REQUIRED_README_SECTIONS.length);
  for (const [index, required] of REQUIRED_README_SECTIONS.entries()) {
    const actual = firstSix[index];
    if (actual === undefined) {
      diagnostics.push({
        ...error(
          "readme.section.missing",
          required,
          `required H2 section '${required}' is missing; expected position ${index + 1}`,
        ),
        file: readmePath,
      });
      continue;
    }
    if (actual.text !== required) {
      diagnostics.push({
        ...error(
          "readme.section.order",
          required,
          `expected '${required}' at H2 position ${index + 1}, found '${actual.text}' (line ${actual.line + 1})`,
        ),
        file: readmePath,
      });
    }
  }

  for (const required of REQUIRED_README_SECTIONS) {
    const occurrences = h2.filter(
      (heading) => heading.text === required,
    ).length;
    if (occurrences > 1) {
      diagnostics.push({
        ...error(
          "readme.section.duplicate",
          required,
          `H2 section '${required}' appears ${occurrences} times; keep one canonical section`,
        ),
        file: readmePath,
      });
    }
  }
}

function checkSettingsTable(
  model: ManifestModel,
  configuration: { readonly lines: readonly string[] } | undefined,
  readmePath: string,
  diagnostics: ReadmeDiagnostic[],
): void {
  const declared = [...model.settings.entries()];
  if (configuration === undefined) {
    // The missing Configuration heading is already reported by checkHeadings.
    return;
  }
  const report = (diagnostic: Diagnostic): void => {
    diagnostics.push({ ...diagnostic, file: readmePath });
  };

  const table = findSettingsTable(configuration.lines);
  if (declared.length === 0) {
    const text = configuration.lines.join("\n");
    if (!text.includes(NO_SETTINGS_SENTENCE) && table === undefined) {
      report(
        error(
          "readme.settings.none",
          "Configuration",
          `the manifest declares no settings; write '${NO_SETTINGS_SENTENCE}' or keep an empty settings table`,
        ),
      );
      return;
    }
    if (table !== undefined && table.rows.length > 0) {
      report(
        error(
          "readme.settings.extra",
          "Configuration",
          `settings table has ${table.rows.length} row(s) but the manifest declares no settings`,
        ),
      );
    }
    return;
  }

  if (table === undefined) {
    report(
      error(
        "readme.settings.table",
        "Configuration",
        'missing the settings table with header "| Setting | Type | Default | Description |"',
      ),
    );
    return;
  }

  const seen = new Map<string, number>();
  const rowKeys: string[] = [];
  for (const row of table.rows) {
    if (row.cells.length !== SETTINGS_TABLE_COLUMNS.length) {
      report(
        error(
          "readme.settings.columns",
          "Configuration",
          `table row ${row.line + 1} has ${row.cells.length} column(s); expected ${SETTINGS_TABLE_COLUMNS.length}`,
        ),
      );
      continue;
    }
    const key = plainCell(row.cells[0]!);
    const type = plainCell(row.cells[1]!);
    const defaultValue = row.cells[2]!.trim();
    const description = row.cells[3]!.trim();
    if (key.length === 0) {
      report(
        error(
          "readme.settings.key",
          "Configuration",
          `table row ${row.line + 1} has an empty Setting cell`,
        ),
      );
      continue;
    }
    const previous = seen.get(key);
    if (previous !== undefined) {
      report(
        error(
          "readme.settings.duplicate",
          key,
          `setting ${describeKey(key)} appears in rows ${previous + 1} and ${row.line + 1}`,
        ),
      );
      continue;
    }
    seen.set(key, row.line);
    rowKeys.push(key);
    const declaration = model.settings.get(key);
    if (declaration === undefined) {
      report(
        error(
          "readme.settings.extra",
          key,
          `setting ${describeKey(key)} is not declared in bitty-plugin.toml [settings]`,
        ),
      );
      continue;
    }
    if (type !== declaration.kind) {
      report(
        error(
          "readme.settings.type",
          key,
          `setting ${describeKey(key)} declares type '${declaration.kind}' but the table says '${type}'`,
        ),
      );
    }
    if (defaultValue.length === 0) {
      report(
        error(
          "readme.settings.default",
          key,
          `setting ${describeKey(key)} has an empty Default cell`,
        ),
      );
    }
    if (description.length === 0) {
      report(
        error(
          "readme.settings.description",
          key,
          `setting ${describeKey(key)} has an empty Description cell`,
        ),
      );
    }
  }

  for (const [key] of declared) {
    if (!seen.has(key)) {
      report(
        error(
          "readme.settings.missing",
          key,
          `declared setting ${describeKey(key)} is missing from the Configuration table`,
        ),
      );
    }
  }

  const declaredKeys = declared.map(([key]) => key);
  const sameOrder = rowKeys.every((key, index) => key === declaredKeys[index]);
  const sameSet =
    rowKeys.length === declaredKeys.length &&
    rowKeys.every((key) => declaredKeys.includes(key));
  if (sameSet && !sameOrder) {
    report(
      error(
        "readme.settings.order",
        "Configuration",
        `settings rows must follow bitty-plugin.toml declaration order: ${declaredKeys.join(", ")}`,
      ),
    );
  }
}

function escapeCell(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

/** Render one setting default as a table cell fragment. */
function renderDefault(declaration: SettingDeclaration): string {
  const value = declaration.default;
  if (declaration.kind === "string" && typeof value === "string") {
    return escapeCell(`"${value}"`);
  }
  if (declaration.kind === "string-array" && Array.isArray(value)) {
    const items = value.filter(
      (entry): entry is string => typeof entry === "string",
    );
    return escapeCell(`[${items.map((entry) => `"${entry}"`).join(", ")}]`);
  }
  return escapeCell(String(value));
}

/**
 * Render the Configuration settings table for a manifest.
 *
 * Descriptions are author-supplied prose because the accepted `[settings]`
 * shape carries only `type` and `default`; the key, type, default, and row
 * order are derived from the manifest.
 */
export function renderSettingsTable(
  model: Pick<ManifestModel, "settings" | "hasSettingsTable">,
  descriptions: Readonly<Record<string, string>> = {},
): string {
  if (model.settings.size === 0) {
    return NO_SETTINGS_SENTENCE;
  }
  const lines = [
    `| ${SETTINGS_TABLE_COLUMNS.join(" | ")} |`,
    `| ${SETTINGS_TABLE_COLUMNS.map(() => "---").join(" | ")} |`,
  ];
  for (const [key, declaration] of model.settings) {
    const description = descriptions[key] ?? "";
    lines.push(
      `| \`${key}\` | ${declaration.kind} | ${renderDefault(declaration)} | ${escapeCell(description)} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Check one plugin README against the canonical user-documentation contract.
 *
 * The manifest is validated first with the accepted linter; an invalid
 * manifest is reported as such and the README shape is not judged against a
 * contract the plugin cannot satisfy.
 */
export function checkPluginReadme(
  options: ReadmeDocsOptions,
): ReadmeDocsResult {
  const manifestPath = options.manifestPath ?? "bitty-plugin.toml";
  const readmePath = options.readmePath ?? README_FILE_NAME;
  const readmeBytes = Buffer.byteLength(options.readmeSource, "utf8");

  if (readmeBytes > README_MAX_BYTES) {
    return {
      valid: false,
      diagnostics: [
        {
          ...error(
            "readme.size",
            "",
            `README is ${readmeBytes} bytes; limit is ${README_MAX_BYTES} bytes`,
          ),
          file: readmePath,
        },
      ],
    };
  }

  let model: ManifestModel;
  try {
    model = loadManifestModel(options.manifestSource);
  } catch (cause) {
    if (cause instanceof ManifestModelError) {
      return {
        valid: false,
        diagnostics: cause.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          file: manifestPath,
        })),
      };
    }
    return {
      valid: false,
      diagnostics: [
        {
          ...error(
            "readme.manifest",
            "",
            `cannot read ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
          file: manifestPath,
        },
      ],
    };
  }

  const diagnostics: ReadmeDiagnostic[] = [];
  const headings = scanHeadings(options.readmeSource);
  checkHeadings(headings, readmePath, diagnostics);
  const configuration = sectionLines(
    options.readmeSource,
    headings,
    "Configuration",
  );
  checkSettingsTable(model, configuration, readmePath, diagnostics);

  return {
    valid: diagnostics.every((entry) => entry.severity !== "error"),
    diagnostics,
  };
}
