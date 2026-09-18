#!/usr/bin/env node
// Mirror OpenCode V2 OAuth credentials into the V1 auth.json store.
//
// V2 keeps credentials in the `credential` table of opencode.db. The upstream
// quota CLI (@slkiser/opencode-quota v4) predates that and only reads
// auth.json, so after `opencode2 auth login` the CLI keeps using whatever stale
// token auth.json happens to hold and reports "Token expired".
//
// This script copies the *active* V2 credential across, but only when it is
// newer than what auth.json already has. It is deliberately standalone so it
// can be audited and run by hand:
//
//   node sync-auth.mjs            # default providers
//   node sync-auth.mjs openai     # explicit
//
// Only the named providers are touched; every other entry in auth.json is left
// byte-for-byte alone. anthropic is not a default because the upstream CLI
// resolves Claude quota through its own credential fallback chain, and other
// plugins may own that auth.json entry; pass it explicitly to mirror it anyway.
import { DatabaseSync } from "node:sqlite"
import { chmodSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

const DEFAULT_PROVIDERS = ["openai"]
const DATA_DIR = process.env.XDG_DATA_HOME
  ? join(process.env.XDG_DATA_HOME, "opencode")
  : join(homedir(), ".local", "share", "opencode")
const AUTH_PATH = join(DATA_DIR, "auth.json")
const DB_PATH = join(DATA_DIR, "opencode.db")

const providers = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PROVIDERS

function readV2Credential(db, provider) {
  const row = db
    .prepare(
      `select value, time_updated from credential
       where integration_id = ? and active = 1
       order by time_updated desc limit 1`,
    )
    .get(provider)
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

// V2 nests the account id under metadata and carries a methodID that V1 has no
// field for; everything else maps across unchanged.
function toV1(credential) {
  if (credential?.type !== "oauth") return null
  if (!credential.access || !credential.expires) return null
  const entry = { type: "oauth" }
  for (const key of ["refresh", "access", "expires"]) {
    if (credential[key] !== undefined) entry[key] = credential[key]
  }
  const accountID = credential.metadata?.accountID
  if (accountID) entry.accountId = accountID
  return entry
}

function writeAtomic(path, data) {
  let mode = 0o600
  try {
    mode = statSync(path).mode & 0o777
  } catch (error) {
    // V2 no longer creates auth.json, so the compatibility mirror may need to
    // create it on its first run. Keep credentials owner-readable only.
    if (error?.code !== "ENOENT") throw error
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-auth-"))
  const staged = join(dir, "auth.json")
  try {
    writeFileSync(staged, data, { mode })
    chmodSync(staged, mode)
    renameSync(staged, path)
  } catch (error) {
    // renameSync across filesystems fails with EXDEV; fall back to writing in
    // place beside the original so the mode is still inherited correctly.
    if (error?.code !== "EXDEV") throw error
    const sibling = join(dirname(path), `.auth.json.${process.pid}`)
    writeFileSync(sibling, data, { mode })
    chmodSync(sibling, mode)
    renameSync(sibling, path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

let db
try {
  db = new DatabaseSync(DB_PATH, { readOnly: true })
} catch (error) {
  console.log(`skip: cannot open V2 credential store (${error.code ?? error.message})`)
  process.exit(0)
}

let auth
try {
  auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"))
} catch (error) {
  if (error?.code === "ENOENT") {
    auth = {}
  } else {
    console.log(`skip: cannot read auth.json (${error.code ?? error.message})`)
    process.exit(0)
  }
}

const updated = []
for (const provider of providers) {
  const entry = toV1(readV2Credential(db, provider))
  if (!entry) continue
  const current = auth[provider]
  // Only move forward. A V1-side login can legitimately be the fresher one.
  if (current?.expires && current.expires >= entry.expires) continue
  auth[provider] = { ...current, ...entry }
  updated.push(`${provider} -> ${new Date(entry.expires).toISOString().slice(0, 19)}Z`)
}
db.close()

if (!updated.length) {
  console.log("up to date")
  process.exit(0)
}

writeAtomic(AUTH_PATH, JSON.stringify(auth, null, 2))
console.log(`synced: ${updated.join(", ")}`)
