// Shared OpenCodeReview settings stored as settings.json in Timpan4/ocr-review.
// Keep these rules identical to the "Load settings" step in that repository's
// .github/workflows/review.yml, which validates the same file before a review.

export const EFFORTS = ["", "low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Settings {
  model: string;
  effort: Effort;
  noFilter: boolean;
  exclude: string[];
  maxTokensBudget: number;
  timeoutMinutes: number;
}

export const SETTING_KEYS = [
  "model",
  "effort",
  "noFilter",
  "exclude",
  "maxTokensBudget",
  "timeoutMinutes",
] as const satisfies readonly (keyof Settings)[];

export class SettingsError extends Error {}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
// The review job's timeout-minutes in Timpan4/ocr-review. A longer group timeout
// can never fire, and much larger values overflow OCR's duration and disable it.
export const MAX_TIMEOUT_MINUTES = 60;
const WHOLE = /^[0-9]+$/;

function isEffort(value: unknown): value is Effort {
  return EFFORTS.some((effort) => effort === value);
}

function checkExclude(patterns: string[]): void {
  for (const pattern of patterns) {
    // Same rule as the workflow: a comma or control character (NUL above all)
    // would split the pattern into extra OCR arguments.
    if (pattern === "" || /[,\x00-\x1f\x7f]/.test(pattern)) {
      throw new SettingsError("Exclude patterns must not be empty or contain commas or control characters.");
    }
  }
}

/** Parses settings.json content, rejecting anything the workflow would reject. */
export function parseSettings(value: unknown): Settings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsError("settings.json must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      throw new SettingsError(`settings.json has an unknown key: ${key}.`);
    }
  }
  for (const key of SETTING_KEYS) {
    if (!(key in record)) throw new SettingsError(`settings.json is missing ${key}.`);
  }
  const { model, effort, noFilter, exclude, maxTokensBudget, timeoutMinutes } = record;
  if (typeof model !== "string" || !MODEL.test(model)) {
    throw new SettingsError("Model must be a model name such as gpt-6.1-sol.");
  }
  if (!isEffort(effort)) throw new SettingsError("Effort must be default, low, medium or high.");
  if (typeof noFilter !== "boolean") throw new SettingsError("noFilter must be true or false.");
  if (!Array.isArray(exclude) || !exclude.every((p): p is string => typeof p === "string")) {
    throw new SettingsError("exclude must be a list of patterns.");
  }
  checkExclude(exclude);
  for (const [name, number] of [
    ["Token budget", maxTokensBudget],
    ["Timeout", timeoutMinutes],
  ] as const) {
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
      throw new SettingsError(`${name} must be a whole number, 0 or more.`);
    }
  }
  if ((timeoutMinutes as number) > MAX_TIMEOUT_MINUTES) {
    throw new SettingsError(`Timeout must be at most ${MAX_TIMEOUT_MINUTES} minutes, the review job's own limit.`);
  }
  return {
    model,
    effort,
    noFilter,
    exclude,
    maxTokensBudget: maxTokensBudget as number,
    timeoutMinutes: timeoutMinutes as number,
  };
}

function wholeNumber(form: FormData, field: string, label: string): number {
  const raw = String(form.get(field) ?? "").trim();
  const value = Number(raw);
  if (!WHOLE.test(raw) || !Number.isSafeInteger(value)) {
    throw new SettingsError(`${label} must be a whole number, 0 or more.`);
  }
  return value;
}

/** Reads the settings form. Exclude patterns are one per line. */
export function parseForm(form: FormData): Settings {
  const exclude = String(form.get("exclude") ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return parseSettings({
    model: String(form.get("model") ?? "").trim(),
    effort: String(form.get("effort") ?? ""),
    noFilter: form.get("noFilter") === "on",
    exclude,
    maxTokensBudget: wholeNumber(form, "maxTokensBudget", "Token budget"),
    timeoutMinutes: wholeNumber(form, "timeoutMinutes", "Timeout"),
  });
}

/** settings.json content with a fixed key order and a trailing newline. */
export function serializeSettings(settings: Settings): string {
  const ordered = Object.fromEntries(SETTING_KEYS.map((key) => [key, settings[key]]));
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function changedKeys(before: Settings, after: Settings): (keyof Settings)[] {
  return SETTING_KEYS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
