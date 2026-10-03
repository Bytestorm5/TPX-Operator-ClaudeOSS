/**
 * TPX Operator's folder on this machine, `~/.tpx-operator/`:
 *
 *   keys/      private keys made by /tpx keygen (mode 600)
 *   memory/    the agent's persistent memory files (markdown)
 *   outputs/   full text of tool results too long to return inline
 *   staging/   files in transit to and from SFTP, removed after each call
 */
import type { Host } from './host'

export const FOLDER = '.tpx-operator'

export async function operatorDirectory(host: Host, sub?: string): Promise<string> {
  const home = await host.home()
  if (!home) throw new Error('cannot find the home directory (HOME is not set)')
  const base = `${home.replace(/[\\/]+$/, '')}/${FOLDER}`
  return sub ? `${base}/${sub}` : base
}

/** A short random id: staging names, output ids, activity ids. */
export function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return `${prefix}_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`
}

/** A fresh path under staging/; its directory is created. */
export async function stagingPath(host: Host, label: string): Promise<string> {
  const dir = await operatorDirectory(host, 'staging')
  const path = `${dir}/${randomId(label)}`
  // fs.write creates the directories; an empty file reserves the name.
  await host.write(path, '')
  return path
}

/** Removes a local file; best effort (a leftover staging file is harmless). */
export async function removeLocal(host: Host, path: string): Promise<boolean> {
  try {
    const result = await host.run(['rm', '-f', '--', path], { timeoutMs: 10_000 })
    if (result.exitCode === 0) return true
  } catch {
    // no rm on this machine: fall through and empty the file instead
  }
  try {
    await host.write(path, '')
  } catch {
    // nothing more to do
  }
  return false
}

export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** A file is binary when its first 8 KiB hold a NUL byte or it does not decode as UTF-8. */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8192).includes(0)) return null
  const text = new TextDecoder().decode(bytes)
  // An invalid sequence decodes to U+FFFD; a text file that holds one on purpose is rare enough.
  return text.includes('\uFFFD') ? null : text
}
