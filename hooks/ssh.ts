/**
 * The wire: every remote operation is the machine's own OpenSSH client run by
 * argument vector (no local shell). `ssh` runs commands, `sftp` in batch mode
 * moves and manages files — the same two channels TPX Operator uses, from the
 * person's machine instead of the platform.
 *
 * BatchMode keeps ssh from ever prompting (a passphrase-protected key needs
 * ssh-agent); IdentitiesOnly makes the terminal's own key the one offered.
 */
import type { ProcessRunResult } from 'claude-code'

import type { TpxTerminal } from '../types'
import type { Host } from './host'

export type SshSettings = {
  /** `accept-new` (trust on first use), `yes` (known hosts only) or `no`. */
  hostKeyChecking: string
  connectTimeoutSeconds: number
  /** The ssh executable, `ssh` on PATH by default. */
  sshPath: string
  sftpPath: string
}

export const DEFAULT_SSH: SshSettings = {
  hostKeyChecking: 'accept-new',
  connectTimeoutSeconds: 15,
  sshPath: 'ssh',
  sftpPath: 'sftp',
}

/** ssh exits 255 when it could not connect or authenticate. */
export const SSH_CONNECT_FAILURE = 255

/** `$.process.run`'s ceiling. */
export const MAX_TIMEOUT_MS = 10 * 60 * 1000

function commonOptions(terminal: TpxTerminal, settings: SshSettings): string[] {
  const checking = ['accept-new', 'yes', 'no'].includes(settings.hostKeyChecking)
    ? settings.hostKeyChecking
    : 'accept-new'
  return [
    '-i',
    terminal.identityFile,
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    `StrictHostKeyChecking=${checking}`,
    '-o',
    `ConnectTimeout=${settings.connectTimeoutSeconds}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    '-o',
    'LogLevel=ERROR',
  ]
}

function destination(terminal: TpxTerminal): string {
  return `${terminal.user}@${terminal.host}`
}

export function sshArgv(terminal: TpxTerminal, command: string, settings: SshSettings = DEFAULT_SSH): string[] {
  return [
    settings.sshPath,
    ...commonOptions(terminal, settings),
    '-p',
    String(terminal.port),
    '-T',
    destination(terminal),
    '--',
    command,
  ]
}

export function sftpArgv(terminal: TpxTerminal, settings: SshSettings = DEFAULT_SSH): string[] {
  return [
    settings.sftpPath,
    '-q',
    '-b',
    '-',
    ...commonOptions(terminal, settings),
    '-P',
    String(terminal.port),
    destination(terminal),
  ]
}

/** The command the person runs for an interactive session on the terminal. */
export function interactiveCommand(terminal: TpxTerminal): string {
  const quote = (s: string) => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
  const port = terminal.port === 22 ? [] : ['-p', String(terminal.port)]
  return ['ssh', '-i', terminal.identityFile, ...port, destination(terminal)].map(quote).join(' ')
}

/**
 * Quotes one path for an sftp batch line: inside double quotes, with `\`, `"`
 * and the glob characters sftp would otherwise expand escaped.
 */
export function sftpQuote(path: string): string {
  if (/[\r\n\0]/.test(path)) throw new Error(`path ${JSON.stringify(path)} contains a control character`)
  return `"${path.replace(/[\\"*?[\]]/g, c => `\\${c}`)}"`
}

export class RemoteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteError'
  }
}

/** The last meaningful line of stderr, for one-line errors. */
export function errorLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('sftp>'))
  return lines.at(-1) ?? ''
}

function describeFailure(result: ProcessRunResult, what: string): string {
  const reason = errorLine(result.stderr) || errorLine(result.stdout)
  if (result.exitCode === SSH_CONNECT_FAILURE)
    return `could not connect for ${what}${reason ? `: ${reason}` : ''}`
  return `${what} failed${reason ? `: ${reason}` : ` (exit ${result.exitCode})`}`
}

async function runProcess(
  host: Host,
  argv: string[],
  init: { stdin?: string; timeoutMs: number },
  what: string,
): Promise<ProcessRunResult> {
  try {
    return await host.run(argv, { ...init, timeoutMs: Math.min(init.timeoutMs, MAX_TIMEOUT_MS) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/timed? ?out|still running/i.test(message))
      throw new RemoteError(`${what} timed out after ${Math.round(init.timeoutMs / 1000)} s`)
    if (/ENOENT|not found|cannot start|spawn/i.test(message))
      throw new RemoteError(
        `${what}: could not start ${argv[0]} — is the OpenSSH client installed and on PATH? (${message})`,
      )
    throw new RemoteError(`${what}: ${message}`)
  }
}

/** Runs one command on the terminal; any exit code resolves, a connection failure rejects. */
export async function sshExec(
  host: Host,
  terminal: TpxTerminal,
  command: string,
  options: { timeoutMs: number; stdin?: string; settings?: SshSettings },
): Promise<ProcessRunResult> {
  const result = await runProcess(
    host,
    sshArgv(terminal, command, options.settings),
    { timeoutMs: options.timeoutMs, ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) },
    `ssh to ${terminal.name}`,
  )
  if (result.exitCode === SSH_CONNECT_FAILURE && /^(ssh:|Permission denied|Host key|kex_|Connection)/m.test(result.stderr))
    throw new RemoteError(describeFailure(result, `ssh to ${terminal.name}`))
  return result
}

/**
 * Runs an sftp batch. Lines prefixed `-` may fail without ending the batch;
 * any other failing line ends it and rejects with sftp's own reason.
 */
export async function sftpBatch(
  host: Host,
  terminal: TpxTerminal,
  lines: string[],
  options: { timeoutMs: number; what: string; settings?: SshSettings },
): Promise<ProcessRunResult> {
  const result = await runProcess(
    host,
    sftpArgv(terminal, options.settings),
    { stdin: `${lines.join('\n')}\n`, timeoutMs: options.timeoutMs },
    `${options.what} on ${terminal.name}`,
  )
  if (result.exitCode !== 0) throw new RemoteError(describeFailure(result, `${options.what} on ${terminal.name}`))
  return result
}

export type RemoteEntry = {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modified: string
  mode: string
}

const LS_LINE = /^([-dlcbps])([-rwxsStTl]{9})\S*\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2}))\s(.*)$/

/** Parses sftp's `ls -la <path>` lines; names come back relative to `path`. */
export function parseListing(stdout: string, path: string): RemoteEntry[] {
  const prefix = path.endsWith('/') ? path : `${path}/`
  const entries: RemoteEntry[] = []
  for (const raw of stdout.split('\n')) {
    const match = LS_LINE.exec(raw.trimEnd())
    if (!match) continue
    const [, kind = '-', perms = '', size = '0', modified = '', fullName = ''] = match
    let name = fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName
    if (name.startsWith('/') && name.includes('/')) name = name.slice(name.lastIndexOf('/') + 1)
    if (name === '.' || name === '..' || name === '') continue
    entries.push({
      name,
      type: kind === 'd' ? 'directory' : kind === 'l' ? 'symlink' : kind === '-' ? 'file' : 'other',
      size: Number(size),
      modified: modified.replace(/\s+/g, ' '),
      mode: kind + perms,
    })
  }
  return entries.sort((a, b) =>
    a.type === 'directory' && b.type !== 'directory'
      ? -1
      : b.type === 'directory' && a.type !== 'directory'
        ? 1
        : a.name.localeCompare(b.name),
  )
}

/** The ancestors of a remote path, outermost first, for `-mkdir` lines (`a/b/c` → `a`, `a/b`). */
export function parentDirectories(path: string): string[] {
  const parts = path.split('/')
  parts.pop()
  const dirs: string[] = []
  let current = path.startsWith('/') ? '' : undefined
  for (const part of parts) {
    if (part === '') continue
    current = current === undefined ? part : `${current}/${part}`
    if (current === '~') continue
    dirs.push(current)
  }
  return dirs
}
