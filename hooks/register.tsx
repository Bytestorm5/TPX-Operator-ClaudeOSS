/**
 * TPX Operator for Claude Code: the person's remote servers ("terminals")
 * over SSH from their own machine, with TPX Operator's toolset.
 *
 *   session.start   registers /tpx and the tools, loads the terminal registry
 *   tool.call       serves mcp__tpx-operator__* (ssh, sftp, memory)
 *   prompt.compose  tells the model which terminals exist, plus its memory
 *   ui.render       draws the Operator pane
 */
import { read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TpxTerminal } from '../types'
import { startActivity } from './activity'
import { runTpxCommand } from './commands'
import type { Host } from './host'
import { memorySection } from './memory'
import { PANE_ID, PANE_TITLE, renderPane } from './pane'
import { DEFAULT_SSH, type SshSettings } from './ssh'
import { targetOf } from './terminals'
import { DeclinedError, TOOLS, ToolInputError, type ToolContext } from './tools'

const PLUGIN = 'tpx-operator'
const STORE_TERMINALS = 'terminals'
const TERMINALS = { plugin: 'tpx-operator', key: 'terminals' } as const
const HEALTH = { plugin: 'tpx-operator', key: 'health' } as const
const ACTIVITY = { plugin: 'tpx-operator', key: 'activity' } as const
const NOTICE = { plugin: 'tpx-operator', key: 'notice' } as const
const TOOL_PREFIX = `mcp__${PLUGIN}__`
const BY_NAME = new Map(TOOLS.map(tool => [`${TOOL_PREFIX}${tool.name}`, tool]))

function settingsFrom(options: Readonly<Record<string, unknown>>): SshSettings {
  const timeout = Number(options.connectTimeoutSeconds)
  return {
    ...DEFAULT_SSH,
    hostKeyChecking: typeof options.hostKeyChecking === 'string' ? options.hostKeyChecking : DEFAULT_SSH.hostKeyChecking,
    connectTimeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? Math.min(120, timeout) : DEFAULT_SSH.connectTimeoutSeconds,
  }
}

async function storedTerminals($: EngineInterface): Promise<TpxTerminal[]> {
  const stored = await $.store.get(STORE_TERMINALS)
  return Array.isArray(stored) ? (stored as TpxTerminal[]) : []
}

/** The engine, as the rest of the mod uses it (see host.ts). */
function hostOf($: EngineInterface): Host {
  return {
    run: (argv, init) => $.process.run(argv, init),
    readText: path => $.fs.read(path),
    readBase64: async path => (await $.fs.read(path, { as: 'bytes' })).base64,
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    stat: path => $.fs.stat(path),
    list: path => $.fs.list(path),
    home: async () => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')),
    now: () => $.clock.now(),
    loadTerminals: () => storedTerminals($),
    saveTerminals: async terminals => {
      await $.store.set(STORE_TERMINALS, terminals)
      await $.state.set(TERMINALS, terminals)
    },
    updateHealth: async change => {
      await update($, HEALTH, health => change(health ?? {}))
    },
    updateActivity: async change => {
      await update($, ACTIVITY, activity => change(activity ?? []))
    },
    setNotice: async text => {
      await $.state.set(NOTICE, text)
    },
    ask: (question, options) => $.ui.ask(question, { header: 'TPX Operator', options }),
    toast: text => $.ui.toast(text, { timeoutMs: 6000 }),
    status: text => $.ui.status(text),
    copy: async (text, surface) =>
      (await $.ui.copy(surface ? { text, surface: surface as never } : { text })).isCopied,
  }
}

export const register: Register = (on, options) => {
  const settings = settingsFrom(options)
  const confirmDestructive = options.confirmDestructive !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.state.set(TERMINALS, await storedTerminals($))
    await $.command.register({
      name: 'tpx',
      description: 'TPX Operator: open the pane, or add/remove/test remote terminals (/tpx help)',
      argumentHint: '[add|keygen|remove|list|test|set|ssh|help]',
    })
    for (const tool of TOOLS)
      await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
    return started
  })

  on('command.run', { command: 'tpx' }, async ($, e) => {
    const { text, openPane } = await runTpxCommand(hostOf($), e.args, settings)
    if (openPane) {
      const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
      if (!opened.isPlaced) return { text: 'The TPX Operator pane will show once the terminal is wide enough.' }
    }
    return { text }
  })

  on('tool.call', async ($, e, next) => {
    const tool = BY_NAME.get(e.tool)
    if (!tool) return next(e)
    const { tool: _name, tool_use_id: _id, agentId: _agent, ...args } = e as Record<string, unknown>
    const terminal = typeof args.terminal === 'string' ? args.terminal : ''
    const host = hostOf($)
    const activity = tool.isRemote
      ? await startActivity(host, { terminal, action: tool.name, detail: tool.summarize(args) })
      : null
    if (tool.isRemote) $.ui.status(`TPX · ${tool.name} on ${terminal}`)
    const ctx: ToolContext = { host, settings, confirmDestructive }
    try {
      const text = await tool.run(ctx, args)
      await activity?.finish('ok')
      return { result: text }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof DeclinedError) {
        await activity?.finish('denied')
        return { deny: `${tool.summarize(args)}: ${message}` }
      }
      await activity?.finish('error')
      return { result: error instanceof ToolInputError ? message : `error: ${message}`, isError: true } as never
    } finally {
      if (tool.isRemote) $.ui.status(undefined)
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const terminals = await storedTerminals($)
    const listed =
      terminals.length === 0
        ? 'No terminals have been added yet. If the user asks for remote work, tell them to add one with ' +
          '/tpx add <name> <user@host[:port]> <private-key> (or /tpx to open the Operator pane).'
        : `The user's terminals:\n${terminals
            .map(t => `- ${t.name}: ${targetOf(t)}${t.description ? ` — ${t.description}` : ''}`)
            .join('\n')}`
    const text = [
      '# TPX Operator',
      `You can operate the user's remote servers ("terminals") over SSH from this machine with the ${TOOL_PREFIX}* tools, ` +
        'naming a terminal by its name. run_command runs shell commands; list_files, read_file, edit_file, write_file ' +
        "and delete_file work on the terminal's files over SFTP; upload_file and download_file move files between this " +
        'machine and a terminal. The local Read/Edit/Bash tools act on THIS machine, not on a terminal.',
      listed,
      'Prefer safe, read-only commands first. Destructive actions (delete_file, restart_server) ask the user for ' +
        'confirmation and may be declined. Report results concisely and never fabricate command output.',
      await memorySection(hostOf($)),
    ].join('\n\n')
    return { sections: [...composed.sections, { id: `${PLUGIN}:operator`, text, scope: 'session' }] }
  })

  on('ui.render', { component: 'Pane', requestId: 'tpx-operator' }, async ($, e) => {
    const view = {
      terminals: (await read($, TERMINALS)) ?? [],
      health: (await read($, HEALTH)) ?? {},
      activity: (await read($, ACTIVITY)) ?? [],
      notice: (await read($, NOTICE)) ?? '',
      columns: e.props.bodyColumns,
      surface: e.surface,
    }
    return renderPane($.ui.resolve(e), hostOf($), view, settings)
  })
}
