/**
 * Persistent agent memory: markdown files in `~/.tpx-operator/memory/`, kept
 * across sessions so durable facts about the person's servers and repeatable
 * runbooks survive. Never written to any remote server.
 *
 * `IMMEDIATE.md` is the special case: its contents ride along in every
 * session's system prompt, so the model is told to keep it lean.
 */
import type { Host } from './host'
import { operatorDirectory, removeLocal } from './local'

export const IMMEDIATE_MEMORY_FILE = 'IMMEDIATE.md'

const MAX_FILE_BYTES = 100 * 1024
const MAX_FILES = 500
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export class MemoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryError'
  }
}

/** Bare names get the .md suffix; anything path-like is refused. */
export function normalizeName(name: string): string {
  const trimmed = name.trim()
  const withExt = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`
  if (!FILE_NAME_RE.test(withExt) || withExt.includes('..'))
    throw new MemoryError(
      `invalid memory file name ${JSON.stringify(name)}: letters, digits, dots, dashes and underscores only (e.g. "backup-runbook.md")`,
    )
  return withExt
}

async function memoryDir(host: Host): Promise<string> {
  return operatorDirectory(host, 'memory')
}

export async function listMemory(host: Host): Promise<Array<{ name: string; bytes: number }>> {
  const dir = await memoryDir(host)
  if (!(await host.exists(dir))) return []
  const entries = await host.list(dir)
  return entries
    .filter(e => e.kind === 'file' && e.name.endsWith('.md'))
    .map(e => ({ name: e.name, bytes: e.size }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function readMemory(host: Host, name: string): Promise<string | null> {
  const path = `${await memoryDir(host)}/${normalizeName(name)}`
  if (!(await host.exists(path))) return null
  return await host.readText(path)
}

export async function writeMemory(host: Host, name: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content).length
  if (bytes > MAX_FILE_BYTES)
    throw new MemoryError(`memory file too large (max ${MAX_FILE_BYTES / 1024}KB) — split or trim it`)
  const fileName = normalizeName(name)
  const existing = await listMemory(host)
  if (existing.length >= MAX_FILES && !existing.some(f => f.name === fileName))
    throw new MemoryError(`memory holds ${MAX_FILES} files already — delete or consolidate first`)
  await host.write(`${await memoryDir(host)}/${fileName}`, content)
  return fileName
}

export async function deleteMemory(host: Host, name: string): Promise<boolean> {
  const path = `${await memoryDir(host)}/${normalizeName(name)}`
  if (!(await host.exists(path))) return false
  await removeLocal(host, path)
  return true
}

/**
 * The memory briefing for the system prompt: what exists, how to use it, and
 * the verbatim contents of IMMEDIATE.md.
 */
export async function memorySection(host: Host): Promise<string> {
  let files: Array<{ name: string }>
  let immediate: string | null
  try {
    files = await listMemory(host)
    immediate = await readMemory(host, IMMEDIATE_MEMORY_FILE)
  } catch {
    return 'Persistent memory is temporarily unavailable this session.'
  }
  const listed = files.filter(f => f.name !== IMMEDIATE_MEMORY_FILE).map(f => f.name)
  const lines = [
    'Persistent memory: you keep markdown memory files that survive across sessions ' +
      '(memory_read / memory_write / memory_delete, stored on this machine in ~/.tpx-operator/memory). ' +
      'Store durable infrastructure facts and repeatable processes (runbooks) you discover or that the user teaches you.',
    listed.length > 0 ? `Your memory files: ${listed.join(', ')}.` : 'You have no memory files yet.',
    `${IMMEDIATE_MEMORY_FILE} is special: its contents are injected below into EVERY session. Be conservative ` +
      'with it — keep it brief and only for what every session truly needs; use ordinary memory files for the rest.',
  ]
  if (immediate !== null && immediate.trim() !== '')
    lines.push(`--- ${IMMEDIATE_MEMORY_FILE} ---`, immediate.trim(), `--- end of ${IMMEDIATE_MEMORY_FILE} ---`)
  return lines.join('\n')
}
