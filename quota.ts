// Data access and formatting for the local quota plugin.
//
// Deliberately free of any OpenCode imports so it can be exercised directly
// with `node --experimental-strip-types`.
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"

export const PLUGIN_ID = "subscription-quota"

const SYNC_SCRIPT = fileURLToPath(new URL("./sync-auth.mjs", import.meta.url))

// `opencode-quota` comes from `npm install -g @slkiser/opencode-quota`.
export const BINARY = "opencode-quota"

// An absolute path from `options.binary` is tried first, for when the TUI
// inherits a PATH without the npm global bin directory.
export function binaries(binary?: string): string[] {
  return binary ? [binary, BINARY] : [BINARY]
}

// Providers to always account for, even when they report nothing. Without this
// an expired Codex token silently looks identical to "provider not configured".
export const DEFAULT_WATCH: Record<string, string> = {
  anthropic: "Claude",
  openai: "Codex",
}

// The sidebar shows every provider that reports a percentage window. These
// short labels replace upstream names that are too wide for the column;
// providers without one fall back to their provider id. Set `options.sidebar` to
// pick providers and labels explicitly.
export const SIDEBAR_LABELS: Record<string, string> = {
  anthropic: "Claude",
  openai: "Codex",
}

// Upstream window names are too wide for a sidebar column.
const WINDOW_LABELS: Record<string, string> = {
  Weekly: "7d",
  Monthly: "30d",
  Daily: "24h",
}

// The alert dialog is about 54 columns wide, and it hard-wraps rather than
// scrolling horizontally. Budget for the widest row:
// label(20) + bar(8) + " 100%" + " → " + "09-30 19:00" = 53.
const BAR_WIDTH = 8
const LABEL_WIDTH = 20
const VALUE_WIDTH = 18

// Upstream keeps its own cache TTL and refuses to re-poll providers on every
// call, so a few minutes of age is normal. Only flag genuinely stale data.
const STALE_SECONDS = 15 * 60

export type Entry = {
  name?: string
  window?: string
  renderType?: string
  percentRemaining?: number
  value?: string
  resetAt?: number
}

export type Report = {
  providers?: Record<string, { status?: string; entries?: Entry[] } | undefined>
  cacheAgeSeconds?: number
}

export type Run = { stdout: string; stderr: string; missing: boolean }

export function run(binary: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 }, (error: any, stdout, stderr) => {
      resolve({
        stdout: stdout ?? "",
        stderr: (stderr || error?.message || "").trim(),
        missing: error?.code === "ENOENT",
      })
    })
  })
}

export const NOT_INSTALLED = "opencode-quota not found. Install it with: npm install -g @slkiser/opencode-quota"

// The upstream CLI reads credentials from V1's auth.json, which `opencode2 auth
// login` no longer writes. Mirror the active V2 credential across first, or the
// fetch below authenticates with a stale token. See ./sync-auth.mjs.
export async function syncCredentials(): Promise<string | null> {
  const result = await run("node", [SYNC_SCRIPT])
  if (result.missing) return null
  return (result.stdout || result.stderr).trim() || null
}

// Text mode performs the live provider fetch and rewrites the shared cache;
// `--json` only ever reads that cache. The ordering below therefore matters:
// without the warm-up call the JSON stays as stale as the last run.
export async function load(options: { sync?: boolean; binary?: string } = {}): Promise<{ report?: Report; error?: string }> {
  if (options.sync !== false) await syncCredentials()
  let error = NOT_INSTALLED
  for (const binary of binaries(options.binary)) {
    const refreshed = await run(binary, ["show"])
    if (refreshed.missing) continue
    const json = await run(binary, ["show", "--json"])
    if (json.missing) continue
    try {
      return { report: JSON.parse(json.stdout) as Report }
    } catch {
      error = json.stderr || refreshed.stderr || "quota output could not be parsed"
    }
  }
  return { error }
}

export async function diagnose(binary?: string, sync = true): Promise<string | null> {
  const mirror = sync ? await syncCredentials() : null
  for (const candidate of binaries(binary)) {
    const result = await run(candidate, ["status"])
    if (result.missing) continue
    const output = (result.stdout || result.stderr).trim() || "no output"
    return mirror ? `credential sync: ${mirror}\n\n${output}` : output
  }
  return null
}

export function bar(percent: number, width = BAR_WIDTH): string {
  let filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  // Any quota left must show at least one block, or a nearly-exhausted window
  // (Codex at 5% over 8 cells rounds to zero) looks identical to an empty one.
  if (filled === 0 && percent > 0) filled = 1
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export function fit(text: string, width: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= width) return trimmed.padEnd(width)
  return trimmed.slice(0, width - 1) + "…"
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

// Absolute local reset time, widened only as far as it needs to be:
// today -> "20:09", within a week -> "Tue 07:59", beyond -> "09-30 19:00".
// Compared by calendar date rather than 24h chunks, so "today" means today.
export function clock(at?: number, now = Date.now()): string {
  if (typeof at !== "number") return ""
  const date = new Date(at * 1000)
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const days = Math.floor((date.getTime() - startOfToday.getTime()) / 86_400_000)
  if (days <= 0) return time
  if (days < 7) return `${WEEKDAYS[date.getDay()]} ${time}`
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`
}

export type Row = {
  label: string
  /** null when the provider reported nothing usable. */
  percent: number | null
  /** Absolute local wall-clock of the next reset, e.g. "Tue 07:59". */
  at: string
}

// Upstream reports some windows with a sub-plan in the name and no `window`
// field, e.g. "Claude Fable Weekly" beside "Claude Weekly". Keeping only the
// provider label would render both as "Claude", so derive the label from the
// name: the sub-plan keeps its own name and the provider shrinks to an initial.
function variantLabel(name: string, short: string): string | undefined {
  const words = name.split(/\s+/).filter(Boolean)
  const rest = words[0]?.toLowerCase() === short.toLowerCase() ? words.slice(1) : words
  if (!rest.length) return undefined
  const last = rest[rest.length - 1]!
  const window = WINDOW_LABELS[last] ?? (/^\d+[hdwm]$/i.test(last) ? last : undefined)
  const variant = (window ? rest.slice(0, -1) : rest).join(" ")
  if (!variant) return undefined
  return `${variant}(${short.slice(0, 1)})${window ? ` ${window}` : ""}`
}

// Compact rows for the sidebar: only percentage windows, because value-only rows
// (Copilot's "quota details unavailable") have nothing to plot and are left to
// /quota. Without `providers` every provider that reports a percentage is shown.
// With `providers` only those ids are shown, in declaration order, and one that
// reports nothing still gets a row so a broken credential stays visible.
export function rows(report: Report, providers?: Record<string, string>, now = Date.now()): Row[] {
  const selected =
    providers ??
    Object.fromEntries(Object.keys(report.providers ?? {}).map((id) => [id, SIDEBAR_LABELS[id] ?? id]))
  const out: Row[] = []
  for (const [id, short] of Object.entries(selected)) {
    const provider = report.providers?.[id]
    if (provider?.status !== "ok") {
      // Upstream reports every provider it knows about, and most of them are
      // unconfigured, so only an explicitly requested one earns a placeholder.
      if (providers) out.push({ label: short, percent: null, at: "" })
      continue
    }
    let found = false
    for (const entry of provider.entries ?? []) {
      if (entry.renderType !== "percent" || typeof entry.percentRemaining !== "number") continue
      found = true
      const window = entry.window ? (WINDOW_LABELS[entry.window] ?? entry.window) : ""
      const label = window
        ? `${short} ${window}`
        : ((entry.name && variantLabel(entry.name, short)) ?? short)
      out.push({
        label,
        percent: Math.round(entry.percentRemaining),
        at: clock(entry.resetAt, now),
      })
    }
    if (!found && providers) out.push({ label: short, percent: null, at: "" })
  }
  return out
}

export function format(report: Report, watch: Record<string, string> = DEFAULT_WATCH, now = Date.now()): string {
  const providers = report.providers ?? {}
  const bars: string[] = []
  const plain: string[] = []

  for (const [id, provider] of Object.entries(providers)) {
    if (provider?.status !== "ok") continue
    for (const entry of provider.entries ?? []) {
      const name = fit(entry.name ?? id, LABEL_WIDTH)
      const at = clock(entry.resetAt, now)
      if (entry.renderType === "percent" && typeof entry.percentRemaining === "number") {
        const percent = Math.round(entry.percentRemaining)
        bars.push(`${name} ${bar(percent)} ${String(percent).padStart(3)}%${at ? ` → ${at}` : ""}`)
      } else if (entry.value) {
        plain.push(`${name} ${fit(entry.value, VALUE_WIDTH).trimEnd()}${at ? ` → ${at}` : ""}`)
      }
    }
  }

  // Surface watched providers that returned nothing, so a broken credential is
  // visibly different from an unconfigured provider.
  const silent = Object.entries(watch)
    .filter(([id]) => providers[id]?.status !== "ok")
    .map(([, name]) => `${fit(name, LABEL_WIDTH)} no data · /quota_diag`)

  const lines = [...bars, ...plain, ...silent]
  if (!lines.length) return "No quota data. Run /quota_diag to see which providers are configured."
  lines.unshift("remaining → next reset", "")

  const age = report.cacheAgeSeconds
  if (typeof age === "number" && age > STALE_SECONDS) lines.push("", `(cached ${Math.round(age / 60)}m ago)`)
  return lines.join("\n")
}
