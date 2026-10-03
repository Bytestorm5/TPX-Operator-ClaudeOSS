/**
 * The terminal registry: the remote servers the person added, each a name,
 * an SSH target and the private key on this machine that opens it.
 *
 * Kept in `$.store` (it survives sessions) and mirrored into `$.state` so the
 * pane redraws when it changes (register.tsx's Host does both). Only the person adds or removes terminals:
 * the model refers to them by name.
 */
import type { TpxTerminal } from '../types'
import type { Host } from './host'

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$|^\[?[0-9A-Fa-f:.]+\]?$/

export class TerminalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TerminalError'
  }
}

export function validateName(name: string): string {
  const trimmed = name.trim()
  if (!NAME_RE.test(trimmed))
    throw new TerminalError(
      `invalid terminal name ${JSON.stringify(name)}: letters, digits, dots, dashes and underscores, starting with a letter or digit`,
    )
  return trimmed
}

/** Parses `user@host`, `user@host:port` or `user@[v6addr]:port`. */
export function parseTarget(target: string): { user: string; host: string; port: number } {
  const match = /^([^@\s]+)@(\[[^\]]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(target.trim())
  if (!match) throw new TerminalError(`invalid target ${JSON.stringify(target)}: expected user@host or user@host:port`)
  const [, user = '', rawHost = '', rawPort] = match
  const host = rawHost.replace(/^\[|\]$/g, '')
  const port = rawPort === undefined ? 22 : Number(rawPort)
  if (!USER_RE.test(user)) throw new TerminalError(`invalid SSH user ${JSON.stringify(user)}`)
  if (!HOST_RE.test(host) || host.startsWith('-')) throw new TerminalError(`invalid host ${JSON.stringify(host)}`)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TerminalError(`invalid port ${rawPort}`)
  return { user, host, port }
}

export function targetOf(terminal: Pick<TpxTerminal, 'user' | 'host' | 'port'>): string {
  const host = terminal.host.includes(':') ? `[${terminal.host}]` : terminal.host
  return `${terminal.user}@${host}${terminal.port === 22 ? '' : `:${terminal.port}`}`
}

/** Expands a leading `~` against the home directory; leaves other paths alone. */
export function expandHome(path: string, home: string | undefined): string {
  const trimmed = path.trim()
  if (home && (trimmed === '~' || trimmed.startsWith('~/'))) return home + trimmed.slice(1)
  return trimmed
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

export async function findTerminal(host: Host, name: string): Promise<TpxTerminal> {
  const terminals = await host.loadTerminals()
  const found = terminals.find(t => t.name === name.trim())
  if (found) return found
  const known = terminals.map(t => t.name)
  throw new TerminalError(
    known.length === 0
      ? `no terminal named "${name}" — no terminals have been added yet (the user adds them with /tpx add)`
      : `no terminal named "${name}" — known terminals: ${known.join(', ')}`,
  )
}

function sorted(terminals: TpxTerminal[]): TpxTerminal[] {
  return [...terminals].sort((a, b) => a.name.localeCompare(b.name))
}

export async function addTerminal(host: Host, terminal: TpxTerminal): Promise<{ replaced: boolean }> {
  const terminals = await host.loadTerminals()
  const replaced = terminals.some(t => t.name === terminal.name)
  await host.saveTerminals(sorted([...terminals.filter(t => t.name !== terminal.name), terminal]))
  return { replaced }
}

export async function updateTerminal(
  host: Host,
  name: string,
  change: (terminal: TpxTerminal) => TpxTerminal,
): Promise<TpxTerminal> {
  const terminal = await findTerminal(host, name)
  const updated = change(terminal)
  const terminals = await host.loadTerminals()
  await host.saveTerminals(sorted(terminals.map(t => (t.name === terminal.name ? updated : t))))
  return updated
}

export async function removeTerminal(host: Host, name: string): Promise<boolean> {
  const terminals = await host.loadTerminals()
  const kept = terminals.filter(t => t.name !== name.trim())
  if (kept.length === terminals.length) return false
  await host.saveTerminals(kept)
  return true
}
