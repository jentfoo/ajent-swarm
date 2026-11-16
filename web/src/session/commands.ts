// ajent's slash-command table plus the query rules behind the composer's
// command menu. The table is data so an ajent addition is a one-line change
// ajent's dispatch stays authoritative for what a submitted line does.

export interface CommandDoc {
  name: string // dispatch name, without the leading slash
  description: string // one line, mirroring ajent's registry
}

// commandDocs lists every command ajent's driver registers, in /help order:
// the built-ins first, then the plan and init feature commands.
export const commandDocs: readonly CommandDoc[] = [
  { name: 'help', description: 'list commands and keybindings' },
  { name: 'model', description: 'show or pick the active model' },
  { name: 'reasoning', description: 'show or set the reasoning level' },
  { name: 'usage', description: 'show session token usage and context status' },
  { name: 'copy', description: 'copy the last agent response to the clipboard' },
  { name: 'compact', description: 'reduce context toward the compaction threshold' },
  { name: 'tools', description: 'enable tools for this session' },
  { name: 'session', description: "show or set this session's name" },
  { name: 'mcp', description: 'manage MCP servers' },
  { name: 'agents', description: 'list and stop sub-agents' },
  { name: 'settings', description: 'view and edit configuration' },
  { name: 'update', description: 'reinstall ajent from the latest release' },
  { name: 'exit', description: 'quit' },
  { name: 'plan', description: 'start a two-model plan, implement and review workflow' },
  {
    name: 'plan-stop',
    description: 'stop the plan workflow and restore the original model and tools',
  },
  { name: 'plan-status', description: "show the plan workflow's phase, round and models" },
  { name: 'init', description: 'survey the project and write AGENTS.md' },
]

// matchCommands answers one menu query: prefix matches lead in table order,
// then substring matches, both case-insensitive the way ajent resolves a
// dispatched name. An empty query lists every command.
export function matchCommands(query: string): CommandDoc[] {
  const q = query.toLowerCase()
  const prefix = commandDocs.filter((c) => c.name.startsWith(q))
  const inside = commandDocs.filter((c) => !c.name.startsWith(q) && c.name.includes(q))
  return prefix.concat(inside)
}

// slashQuery returns the command query the caret sits in, or null when the
// menu must stay closed: the token has to be line-initial, open with `/`, and
// hold the caret with no whitespace before it, so `//x`, arguments past a
// space and pasted multi-line drafts all stay plain prompts.
export function slashQuery(text: string, caret: number): string | null {
  const upto = text.slice(0, Math.max(0, Math.min(caret, text.length)))
  if (!upto.startsWith('/')) return null
  if (/\s/.test(upto)) return null
  return upto.slice(1)
}
