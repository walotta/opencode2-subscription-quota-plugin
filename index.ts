// Server-side half of the quota plugin.
//
// It intentionally does no work: all quota reading happens in the CLI process
// (see ./tui.tsx). This entrypoint exists so OpenCode discovers the package as a
// plugin with both a server and a TUI entrypoint, which is the layout documented
// at https://opencode.ai/v2/docs/cli/plugins.
import { PLUGIN_ID } from "./quota.ts"

export default {
  id: PLUGIN_ID,
  setup() {},
}
