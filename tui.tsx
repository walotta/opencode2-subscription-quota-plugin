// Show subscription quota inside the OpenCode V2 TUI: a persistent sidebar panel
// plus /quota and /quota_diag.
//
// Why this exists: @slkiser/opencode-quota is a V1 plugin (it peer-depends on
// @opencode-ai/plugin) and fails to load in V2 with "Plugin must export a
// default definition with an id and an effect or setup function". Upstream V2
// support is still open (issue #229 / PR #196). Its *CLI* works fine though, so
// this plugin keeps upstream as the data source and only re-implements the V2
// presentation layer.
//
// Import the specifier OpenCode aliases at runtime. A deeper subpath such as
// "@opencode/plugin/tui/context" is not aliased: it resolves only when
// @opencode/plugin happens to be installed next to the plugin, so an installed
// package fails to load its TUI half, silently and with nothing in the log.
// @opencode/plugin stays a devDependency, for typechecking only.
import { Plugin } from "@opencode/plugin/tui"
import { bar, DEFAULT_WATCH, diagnose, fit, format, load, PLUGIN_ID, rows, type Row } from "./quota.ts"

// Upstream keeps its own provider-side cache, so polling faster mostly re-reads
// the same numbers. Five minutes keeps the sidebar current without hammering.
const REFRESH_MS = 5 * 60 * 1000

// The sidebar column is about 37 wide. label(10) + bar(8) + " 100%" + reset(9,
// e.g. "Tue 07:59") lands at 34.
const LABEL_WIDTH = 10
const BAR_WIDTH = 8

type State = { rows: Row[]; error: string | null; loaded: boolean }

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    const watch: Record<string, string> = {
      ...DEFAULT_WATCH,
      ...((context.options?.watch as Record<string, string> | undefined) ?? {}),
    }
    // Options come from the cli.json `plugins` entry. Options attached to an
    // opencode.json(c) entry configure the server half and never arrive here:
    //   "sidebar": { "anthropic": "Claude" }  pick sidebar providers and labels
    //   "binary": "/path/to/opencode-quota"   when it is not on PATH
    //   "sync": false                         stop mirroring V2 credentials
    const sidebar = context.options?.sidebar as Record<string, string> | undefined
    const binary = context.options?.binary as string | undefined
    const sync = context.options?.sync !== false

    const [state, update] = context.storage.memory<State>("sidebar", {
      initial: { rows: [], error: null, loaded: false },
    })

    async function refresh() {
      const { report, error } = await load({ sync, binary })
      update((draft) => {
        draft.loaded = true
        if (report) {
          draft.rows = rows(report, sidebar)
          draft.error = null
        } else {
          draft.error = error ?? "unavailable"
        }
      })
    }

    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)

    function colorFor(percent: number | null) {
      if (percent === null) return context.theme.text.subdued
      if (percent < 15) return context.theme.text.feedback.error.default
      if (percent < 40) return context.theme.text.feedback.warning.default
      return context.theme.text.default
    }

    const stopSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <box flexDirection="column">
          <text fg={context.theme.text.subdued}>Quota</text>
          {state.error !== null ? (
            <text fg={context.theme.text.feedback.error.default}>{state.error}</text>
          ) : !state.loaded ? (
            <text fg={context.theme.text.subdued}>loading…</text>
          ) : (
            state.rows.map((row) => (
              <text fg={colorFor(row.percent)}>
                {fit(row.label, LABEL_WIDTH) +
                  " " +
                  (row.percent === null ? "—".padEnd(BAR_WIDTH) : bar(row.percent, BAR_WIDTH)) +
                  " " +
                  (row.percent === null ? "no data" : String(row.percent).padStart(3) + "%") +
                  (row.at ? " " + row.at : "")}
              </text>
            ))
          )}
        </box>
      ),
    })

    // keymap.layer() builds a reactive computation, so it needs an owner. Called
    // straight from setup() the plugin fails to load with no logged error at all
    // (the CLI records nothing for TUI plugin failures; /plugins only shows
    // "failed"). Registering from inside a slot render gives it the owner it
    // expects, which is also how the docs' session-panel example does it.
    const stopCommands = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "subscription-quota.show",
              title: "Show provider quota",
              group: "Quota",
              palette: true,
              slash: { name: "quota" },
              run: async () => {
                const { report, error } = await load({ sync, binary })
                if (!report) {
                  context.ui.toast.show({
                    title: "Quota",
                    message: error ?? "unavailable",
                    variant: "error",
                  })
                  return
                }
                void refresh()
                await context.ui.dialog.alert({ title: "Quota", message: format(report, watch) })
              },
            },
            {
              id: "subscription-quota.diag",
              title: "Diagnose quota providers",
              group: "Quota",
              palette: true,
              slash: { name: "quota_diag" },
              run: async () => {
                const output = await diagnose(binary, sync)
                if (output === null) {
                  context.ui.toast.show({
                    title: "Quota",
                    message: "opencode-quota not found on PATH",
                    variant: "error",
                  })
                  return
                }
                await context.ui.dialog.alert({
                  title: "Quota diagnostics",
                  message: output.slice(0, 4000),
                })
              },
            },
          ],
        }))
        return null
      },
    })

    return () => {
      clearInterval(timer)
      stopSidebar()
      stopCommands()
    }
  },
})
