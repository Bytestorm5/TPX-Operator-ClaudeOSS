/**
 * The tools the model calls: TPX Operator's toolset, run from this machine.
 *
 * Every remote tool names its terminal by the name the person gave it. `ssh`
 * runs commands; `sftp` (batch mode) reads, writes, edits, lists and deletes
 * files, so the file tools work on servers whose shell is restricted too.
 * Two tools Operator has no use for move files between this machine and a
 * terminal (upload_file, download_file). The memory tools never touch a
 * server.
 *
 * Destructive tools (delete_file, restart_server) ask the person first, in
 * Claude Code's own question dialog, unless that is turned off.
 */
import type { TpxTerminal } from '../types'
import type { Host } from './host'
import { decodeBase64, decodeText, operatorDirectory, randomId, removeLocal, stagingPath } from './local'
import { IMMEDIATE_MEMORY_FILE, deleteMemory, readMemory, writeMemory } from './memory'
import {
  type SshSettings,
  MAX_TIMEOUT_MS,
  parentDirectories,
  parseListing,
  sftpBatch,
  sftpQuote,
  sshExec,
} from './ssh'
import { findTerminal, targetOf } from './terminals'

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolInputError'
  }
}

/** Raised when the person declines a destructive action. */
export class DeclinedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeclinedError'
  }
}

export type ToolContext = {
  host: Host
  settings: SshSettings
  confirmDestructive: boolean
}

type Args = Record<string, unknown>

export type ToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Remote tools carry a `terminal` argument; the activity feed shows it. */
  isRemote: boolean
  destructive: boolean
  /** One line for the activity feed and the confirmation question. */
  summarize: (args: Args) => string
  run: (ctx: ToolContext, args: Args) => Promise<string>
}

// -- result-size discipline --------------------------------------------------------
// Long results are cut before they reach the conversation; the whole text is
// written to ~/.tpx-operator/outputs/ and the note names the file, which the
// model pages through with Claude Code's own Read tool.

/** Characters of a tool result returned inline before it is cut. */
export const TOOL_RESULT_MAX_CHARS = 30_000
const LIST_FILES_MAX_ENTRIES = 300
/** `$.fs.read`'s own ceiling: bigger files go through download_file. */
const READ_FILE_MAX_BYTES = 4 * 1024 * 1024
const READ_FILE_DEFAULT_LIMIT = 2000
const READ_FILE_MAX_LINE_CHARS = 2000
const DEFAULT_COMMAND_TIMEOUT_S = 120
const FILE_TIMEOUT_MS = 120_000
const TRANSFER_TIMEOUT_MS = MAX_TIMEOUT_MS

export async function capResult(host: Host, text: string): Promise<string> {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text
  const id = randomId('out')
  let where = ''
  try {
    const path = `${await operatorDirectory(host, 'outputs')}/${id}.txt`
    await host.write(path, text)
    where = ` The full output (${text.length} characters) is saved at ${path} — read it with the Read tool (offset/limit) to see the rest.`
  } catch {
    where = ' The full output could not be saved; re-run with narrower arguments to see the rest.'
  }
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[output truncated at ${TOOL_RESULT_MAX_CHARS} of ${text.length} characters.${where}]`
}

// -- argument checks ------------------------------------------------------------

function requireString(args: Args, field: string): string {
  const value = args[field]
  if (typeof value !== 'string' || value.trim() === '')
    throw new ToolInputError(`invalid arguments: "${field}" must be a non-empty string`)
  if (value.includes('\0')) throw new ToolInputError(`invalid arguments: "${field}" contains a NUL byte`)
  return value
}

function requireText(args: Args, field: string): string {
  const value = args[field]
  if (typeof value !== 'string') throw new ToolInputError(`invalid arguments: "${field}" must be a string`)
  return value
}

function optionalInt(args: Args, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new ToolInputError(`invalid arguments: "${field}" must be an integer from ${min} to ${max}`)
  return value
}

function optionalBoolean(args: Args, field: string): boolean | undefined {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new ToolInputError(`invalid arguments: "${field}" must be a boolean`)
  return value
}

function remotePath(args: Args, field = 'path'): string {
  const path = requireString(args, field)
  if (/[\r\n]/.test(path)) throw new ToolInputError(`invalid arguments: "${field}" contains a line break`)
  return path
}

async function terminalOf(ctx: ToolContext, args: Args): Promise<TpxTerminal> {
  return findTerminal(ctx.host, requireString(args, 'terminal'))
}

const TERMINAL_PROP = {
  terminal: {
    type: 'string',
    description: 'Name of the remote terminal, as list_terminals and the system prompt show it.',
  },
}

/** Asks the person before a destructive action, unless confirmation is off. */
async function confirm(ctx: ToolContext, question: string): Promise<void> {
  if (!ctx.confirmDestructive) return
  let answer: string
  try {
    answer = await ctx.host.ask(question, ['Allow', 'Decline'])
  } catch {
    throw new DeclinedError('declined: nobody confirmed the action (the question was dismissed or no one can be asked)')
  }
  if (answer !== 'Allow') throw new DeclinedError(`declined by the user${answer !== 'Decline' ? `: ${answer}` : ''}`)
}

// -- remote file helpers --------------------------------------------------------

async function downloadText(
  ctx: ToolContext,
  terminal: TpxTerminal,
  path: string,
): Promise<{ text: string | null; size: number }> {
  const stage = await stagingPath(ctx.host, 'read')
  try {
    await sftpBatch(ctx.host, terminal, [`get ${sftpQuote(path)} ${sftpQuote(stage)}`], {
      timeoutMs: FILE_TIMEOUT_MS,
      what: `reading ${path}`,
      settings: ctx.settings,
    })
    const { size } = await ctx.host.stat(stage)
    if (size > READ_FILE_MAX_BYTES)
      throw new ToolInputError(
        `${path} is ${size} bytes — over the ${READ_FILE_MAX_BYTES}-byte read limit. ` +
          'Slice it with run_command (head/tail/grep/sed -n) or fetch it with download_file.',
      )
    const bytes = decodeBase64(await ctx.host.readBase64(stage))
    return { text: decodeText(bytes), size: bytes.length }
  } finally {
    await removeLocal(ctx.host, stage)
  }
}

async function uploadText(ctx: ToolContext, terminal: TpxTerminal, path: string, content: string): Promise<void> {
  const stage = await stagingPath(ctx.host, 'write')
  try {
    await ctx.host.write(stage, content)
    const mkdirs = parentDirectories(path).map(dir => `-mkdir ${sftpQuote(dir)}`)
    await sftpBatch(ctx.host, terminal, [...mkdirs, `put ${sftpQuote(stage)} ${sftpQuote(path)}`], {
      timeoutMs: FILE_TIMEOUT_MS,
      what: `writing ${path}`,
      settings: ctx.settings,
    })
  } finally {
    await removeLocal(ctx.host, stage)
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

// -- the tools ------------------------------------------------------------------

const listTerminals: ToolDefinition = {
  name: 'list_terminals',
  description:
    'List the remote terminals (SSH servers) the user has added, with their targets, descriptions and whether a ' +
    'restart command is configured. Only the user adds or removes terminals (with /tpx); refer to them by name.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  isRemote: false,
  destructive: false,
  summarize: () => 'list terminals',
  async run(ctx) {
    const terminals = await ctx.host.loadTerminals()
    if (terminals.length === 0)
      return 'No terminals have been added yet. Ask the user to add one with: /tpx add <name> <user@host[:port]> <private-key-path>'
    return terminals
      .map(t =>
        [
          `- ${t.name}: ${targetOf(t)}`,
          t.description ? ` — ${t.description}` : '',
          t.restartCommand ? ` (restart: ${t.restartCommand})` : ' (no restart command)',
        ].join(''),
      )
      .join('\n')
  },
}

const runCommand: ToolDefinition = {
  name: 'run_command',
  description:
    'Run a shell command on a remote terminal over SSH and return its exit code and output. Non-interactive: no ' +
    'TTY, no prompts (use -y flags, avoid pagers and editors). Prefer safe, read-only commands first.',
  inputSchema: {
    type: 'object',
    properties: {
      ...TERMINAL_PROP,
      command: { type: 'string', description: 'The shell command to execute on the terminal.' },
      timeout_seconds: {
        type: 'integer',
        description: `How long the command may run (default ${DEFAULT_COMMAND_TIMEOUT_S}, max 600).`,
      },
    },
    required: ['terminal', 'command'],
  },
  isRemote: true,
  destructive: false,
  summarize: args => String(args.command ?? ''),
  async run(ctx, args) {
    const terminal = await terminalOf(ctx, args)
    const command = requireString(args, 'command')
    const timeoutS = optionalInt(args, 'timeout_seconds', 1, 600) ?? DEFAULT_COMMAND_TIMEOUT_S
    const result = await sshExec(ctx.host, terminal, command, { timeoutMs: timeoutS * 1000, settings: ctx.settings })
    const parts = [`exit code: ${result.exitCode}`]
    if (result.stdout !== '') parts.push(`stdout:\n${result.stdout.replace(/\n$/, '')}`)
    if (result.stderr !== '') parts.push(`stderr:\n${result.stderr.replace(/\n$/, '')}`)
    if (result.stdout === '' && result.stderr === '') parts.push('(no output)')
    if (result.isStdoutTruncated || result.isStderrTruncated) parts.push('[output over 4 MiB was dropped]')
    return capResult(ctx.host, parts.join('\n'))
  },
}

const listFiles: ToolDefinition = {
  name: 'list_files',
  description:
    'List a directory on a remote terminal over SFTP: entry names with type, size, permissions and modification ' +
    'time. Relative paths (or ".") resolve against the SSH user\'s home directory.',
  inputSchema: {
    type: 'object',
    properties: {
      ...TERMINAL_PROP,
      path: { type: 'string', description: 'Directory to list, e.g. "/var/log" or "." for home (default ".").' },
    },
    required: ['terminal'],
  },
  isRemote: true,
  destructive: false,
  summarize: args => `list ${String(args.path ?? '.')}`,
  async run(ctx, args) {
    const terminal = await terminalOf(ctx, args)
    const path = args.path === undefined ? '.' : remotePath(args)
    const result = await sftpBatch(ctx.host, terminal, [`ls -la ${sftpQuote(path)}`], {
      timeoutMs: FILE_TIMEOUT_MS,
      what: `listing ${path}`,
      settings: ctx.settings,
    })
    const entries = parseListing(result.stdout, path)
    const shown = entries.slice(0, LIST_FILES_MAX_ENTRIES)
    const lines = shown.map(entry => {
      const size = entry.type === 'file' ? String(entry.size) : ''
      return `${entry.mode} ${size.padStart(10)}  ${entry.modified.padEnd(12)}  ${entry.name}${entry.type === 'directory' ? '/' : ''}`
    })
    const header = `${path} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`
    const cap = entries.length > shown.length ? [`… ${entries.length - shown.length} more entries not shown`] : []
    return [header, ...lines, ...cap].join('\n')
  },
}

const readFile: ToolDefinition = {
  name: 'read_file',
  description:
    'Read a text file from a remote terminal over SFTP, returned with line numbers ("N| content"). Binary files are ' +
    `reported but not shown. Reads up to ${READ_FILE_DEFAULT_LIMIT} lines by default — pass "offset" (1-based first ` +
    'line) and "limit" (line count) to page through large files. Files over 4 MiB are refused: slice those with ' +
    'run_command (head/tail/grep) or fetch them with download_file.',
  inputSchema: {
    type: 'object',
    properties: {
      ...TERMINAL_PROP,
      path: { type: 'string', description: 'Path of the file to read.' },
      offset: { type: 'integer', description: '1-based line number to start reading from (default 1).' },
      limit: { type: 'integer', description: `Maximum lines to return (default ${READ_FILE_DEFAULT_LIMIT}).` },
    },
    required: ['terminal', 'path'],
  },
  isRemote: true,
  destructive: false,
  summarize: args => `read ${String(args.path ?? '')}`,
  async run(ctx, args) {
    const terminal = await terminalOf(ctx, args)
    const path = remotePath(args)
    const offset = optionalInt(args, 'offset', 1) ?? 1
    const limit = optionalInt(args, 'limit', 1) ?? READ_FILE_DEFAULT_LIMIT
    const file = await downloadText(ctx, terminal, path)
    if (file.text === null)
      return `${path} is a binary file (${file.size} bytes) — contents not shown. Use download_file to copy it to this machine.`
    if (file.text === '') return `${path} is empty`
    const lines = file.text.split('\n')
    if (file.text.endsWith('\n')) lines.pop()
    const total = lines.length
    if (offset > total) return `${path} has only ${total} line${total === 1 ? '' : 's'} — offset ${offset} is past the end`
    const window = lines.slice(offset - 1, offset - 1 + limit)
    const end = offset - 1 + window.length
    const width = String(end).length
    const body = window.map((line, i) => {
      const shown =
        line.length > READ_FILE_MAX_LINE_CHARS ? `${line.slice(0, READ_FILE_MAX_LINE_CHARS)}… [line truncated]` : line
      return `${String(offset + i).padStart(width)}| ${shown}`
    })
    const footer = end < total ? [`[${total - end} more lines — call read_file again with offset ${end + 1}]`] : []
    return capResult(ctx.host, [`${path} (lines ${offset}-${end} of ${total})`, ...body, ...footer].join('\n'))
  },
}

const editFile: ToolDefinition = {
  name: 'edit_file',
  description:
    'Edit a text file on a remote terminal by exact string replacement (read-modify-write over SFTP). "old_string" ' +
    'must match the file content exactly — whitespace and indentation included — and must be unique in the file ' +
    'unless "replace_all" is set. Prefer this over write_file for changing part of an existing file.',
  inputSchema: {
    type: 'object',
    properties: {
      ...TERMINAL_PROP,
      path: { type: 'string', description: 'Path of the file to edit.' },
      old_string: { type: 'string', description: 'The exact text to replace (unique unless replace_all).' },
      new_string: { type: 'string', description: 'The replacement text. May be empty to delete old_string.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
    },
    required: ['terminal', 'path', 'old_string', 'new_string'],
  },
  isRemote: true,
  destructive: false,
  summarize: args => `edit ${String(args.path ?? '')}`,
  async run(ctx, args) {
    const terminal = await terminalOf(ctx, args)
    const path = remotePath(args)
    const oldString = requireString(args, 'old_string')
    const newString = requireText(args, 'new_string')
    if (newString === oldString) throw new ToolInputError('invalid arguments: "new_string" must differ from "old_string"')
    const replaceAll = optionalBoolean(args, 'replace_all') ?? false
    const file = await downloadText(ctx, terminal, path)
    if (file.text === null) throw new ToolInputError(`${path} is a binary file — edit_file only edits text`)
    const count = file.text.split(oldString).length - 1
    if (count === 0) throw new ToolInputError(`"old_string" was not found in ${path}`)
    if (count > 1 && !replaceAll)
      throw new ToolInputError(
        `"old_string" occurs ${count} times in ${path} — add surrounding context to make it unique, or set replace_all`,
      )
    const updated = replaceAll ? file.text.split(oldString).join(newString) : file.text.replace(oldString, () => newString)
    await uploadText(ctx, terminal, path, updated)
    const replacements = replaceAll ? count : 1
    return `edited ${path}: ${replacements} replacement${replacements === 1 ? '' : 's'} (${byteLength(updated)} bytes now)`
  },
}

const writeFile: ToolDefinition = {
  name: 'write_file',
  description:
    'Create or overwrite one text file on a remote terminal over SFTP. Overwrites replace the whole file — read it ' +
    'first when editing, or use edit_file. Missing parent directories are created.',
  inputSchema: {
    type: 'object',
    properties: {
      ...TERMINAL_PROP,
      path: { type: 'string', description: 'Path of the file to write.' },
      content: { type: 'string', description: 'The full new content of the file.' },
    },
    required: ['terminal', 'path', 'content'],
  },
  isRemote: true,
  destructive: false,
  summarize: args => `write ${String(args.path ?? '')}`,
  async run(ctx, args) {
    const terminal = await terminalOf(ctx, args)
    const path = remotePath(args)
    const content = requireText(args, 'content')
    await uploadText(ctx, terminal, path, content)
    return `wrote ${byteLength(content)} bytes to ${path}`
  },
}

const deleteFile: ToolDefinition = {
  name: 'delete_file',
  description:
    'Delete one file on a remote terminal (SFTP rm — not a shell command). Destructive: the user is asked to confirm ' +
    'and may decline.',
  inputSchema: {
    type: 'object',
    properties: { ...TERMINAL_PROP, path: { type: 'string', description: 'Path of the file to delete.' } },
    required: ['terminal', 'path'],
  },
  isRemote: true,
  destructive: true,
  summarize: args => `delete ${String(args.path ?? '')}`,
  async run(ctx, args) {
    const terminal = await terminalOf(ctx, args)
    const path = remotePath(args)
    await confirm(ctx, `Delete ${path} on ${terminal.name} (${targetOf(terminal)})?`)
    await sftpBatch(ctx.host, terminal, [`rm ${sftpQuote(path)}`], {
      timeoutMs: FILE_TIMEOUT_MS,
      what: `deleting ${path}`,
      settings: ctx.settings,
    })
    return `deleted ${path}`
  },
}

const restartServer: ToolDefinition = {
  name: 'restart_server',
  description:
    'Restart the service a terminal runs, using the restart command the user configured for it (list_terminals ' +
    'shows it). Destructive: the user is asked to confirm and may decline.',
  inputSchema: { type: 'object', properties: { ...TERMINAL_PROP }, required: ['terminal'] },
  isRemote: true,
  destructive: true,
  summarize: () => 'restart server',
  async run(ctx, args) {
    const terminal = await terminalOf(ctx, args)
    if (!terminal.restartCommand)
      throw new ToolInputError(
        `terminal "${terminal.name}" has no restart command configured — the user sets one with /tpx set ${terminal.name} restart <command>`,
      )
    await confirm(ctx, `Restart ${terminal.name} with: ${terminal.restartCommand}?`)
    const result = await sshExec(ctx.host, terminal, terminal.restartCommand, {
      timeoutMs: 5 * 60 * 1000,
      settings: ctx.settings,
    })
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
    return capResult(
      ctx.host,
      `restart command exited ${result.exitCode}${output ? `\n${output}` : ''}`,
    )
  },
}

const uploadFile: ToolDefinition = {
  name: 'upload_file',
  description:
    "Copy a file (or, with recursive, a directory) from the user's local machine to a remote terminal over SFTP. " +
    'Local relative paths resolve against the session\'s working directory; remote relative paths against the SSH ' +
    "user's home. Binary-safe. An existing remote file is overwritten.",
  inputSchema: {
    type: 'object',
    properties: {
      ...TERMINAL_PROP,
      local_path: { type: 'string', description: 'Path of the file or directory on this machine.' },
      remote_path: { type: 'string', description: 'Destination path on the terminal.' },
      recursive: { type: 'boolean', description: 'Copy a whole directory.' },
    },
    required: ['terminal', 'local_path', 'remote_path'],
  },
  isRemote: true,
  destructive: false,
  summarize: args => `upload ${String(args.local_path ?? '')} → ${String(args.remote_path ?? '')}`,
  async run(ctx, args) {
    const terminal = await terminalOf(ctx, args)
    const local = remotePath(args, 'local_path')
    const remote = remotePath(args, 'remote_path')
    const recursive = optionalBoolean(args, 'recursive') ?? false
    if (!(await ctx.host.exists(local))) throw new ToolInputError(`local path ${local} does not exist`)
    const stat = await ctx.host.stat(local)
    if (stat.kind === 'dir' && !recursive)
      throw new ToolInputError(`${local} is a directory — set recursive to upload it`)
    const mkdirs = parentDirectories(remote).map(dir => `-mkdir ${sftpQuote(dir)}`)
    await sftpBatch(ctx.host, terminal, [...mkdirs, `put ${recursive ? '-R ' : ''}${sftpQuote(local)} ${sftpQuote(remote)}`], {
      timeoutMs: TRANSFER_TIMEOUT_MS,
      what: `uploading ${local}`,
      settings: ctx.settings,
    })
    return stat.kind === 'dir'
      ? `uploaded directory ${local} to ${terminal.name}:${remote}`
      : `uploaded ${local} (${stat.size} bytes) to ${terminal.name}:${remote}`
  },
}

const downloadFile: ToolDefinition = {
  name: 'download_file',
  description:
    "Copy a file (or, with recursive, a directory) from a remote terminal to the user's local machine over SFTP. " +
    'Local relative paths resolve against the session\'s working directory; missing local parent directories are ' +
    'created. Binary-safe. An existing local file is overwritten.',
  inputSchema: {
    type: 'object',
    properties: {
      ...TERMINAL_PROP,
      remote_path: { type: 'string', description: 'Path of the file or directory on the terminal.' },
      local_path: { type: 'string', description: 'Destination path on this machine.' },
      recursive: { type: 'boolean', description: 'Copy a whole directory.' },
    },
    required: ['terminal', 'remote_path', 'local_path'],
  },
  isRemote: true,
  destructive: false,
  summarize: args => `download ${String(args.remote_path ?? '')} → ${String(args.local_path ?? '')}`,
  async run(ctx, args) {
    const terminal = await terminalOf(ctx, args)
    const remote = remotePath(args, 'remote_path')
    const local = remotePath(args, 'local_path')
    const recursive = optionalBoolean(args, 'recursive') ?? false
    // Create the local parent directories: fs.write makes them, then the placeholder is replaced.
    const slash = Math.max(local.lastIndexOf('/'), local.lastIndexOf('\\'))
    if (slash > 0) {
      const parent = local.slice(0, slash)
      if (!(await ctx.host.exists(parent))) {
        const marker = `${parent}/.tpx-download-${randomId('d')}`
        await ctx.host.write(marker, '')
        await removeLocal(ctx.host, marker)
      }
    }
    await sftpBatch(ctx.host, terminal, [`get ${recursive ? '-R ' : ''}${sftpQuote(remote)} ${sftpQuote(local)}`], {
      timeoutMs: TRANSFER_TIMEOUT_MS,
      what: `downloading ${remote}`,
      settings: ctx.settings,
    })
    let size = ''
    try {
      const stat = await ctx.host.stat(local)
      size = stat.kind === 'dir' ? ' (directory)' : ` (${stat.size} bytes)`
    } catch {
      // reported without a size
    }
    return `downloaded ${terminal.name}:${remote} to ${local}${size}`
  },
}

const memoryReadTool: ToolDefinition = {
  name: 'memory_read',
  description:
    'Read one of your persistent memory files (markdown, kept on this machine — never on a server). The system ' +
    'prompt lists the files that exist.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Memory file name, e.g. "backup-runbook.md".' } },
    required: ['name'],
  },
  isRemote: false,
  destructive: false,
  summarize: args => `read memory ${String(args.name ?? '')}`,
  async run(ctx, args) {
    const name = requireString(args, 'name')
    return (await readMemory(ctx.host, name)) ?? `no memory file named "${name}" exists`
  },
}

const memoryWriteTool: ToolDefinition = {
  name: 'memory_write',
  description:
    'Create or overwrite one of your persistent memory files. Use memory for durable facts about the user\'s ' +
    'servers and for repeatable processes (runbooks) worth keeping across sessions. ' +
    `"${IMMEDIATE_MEMORY_FILE}" is special: its full contents are injected into every future session's prompt — ` +
    'be conservative with it; keep it short and only for what is genuinely needed every session. Overwrites replace ' +
    'the whole file, so read it first when updating.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Memory file name, e.g. "backup-runbook.md". ".md" is appended if missing.' },
      content: { type: 'string', description: 'The full markdown content of the file.' },
    },
    required: ['name', 'content'],
  },
  isRemote: false,
  destructive: false,
  summarize: args => `write memory ${String(args.name ?? '')}`,
  async run(ctx, args) {
    const saved = await writeMemory(ctx.host, requireString(args, 'name'), requireText(args, 'content'))
    return `saved memory file "${saved}"`
  },
}

const memoryDeleteTool: ToolDefinition = {
  name: 'memory_delete',
  description: 'Delete one of your persistent memory files.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Memory file name to delete.' } },
    required: ['name'],
  },
  isRemote: false,
  destructive: false,
  summarize: args => `delete memory ${String(args.name ?? '')}`,
  async run(ctx, args) {
    const name = requireString(args, 'name')
    return (await deleteMemory(ctx.host, name)) ? `deleted memory file "${name}"` : `no memory file named "${name}" exists`
  },
}

export const TOOLS: readonly ToolDefinition[] = [
  listTerminals,
  runCommand,
  listFiles,
  readFile,
  editFile,
  writeFile,
  deleteFile,
  restartServer,
  uploadFile,
  downloadFile,
  memoryReadTool,
  memoryWriteTool,
  memoryDeleteTool,
]
