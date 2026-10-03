/**
 * `/tpx`: how the person manages terminals from the prompt.
 *
 *   /tpx                                         open the pane
 *   /tpx add <name> <user@host[:port]> <key> [description…]
 *   /tpx keygen <name>                           make a key; prints the public half
 *   /tpx remove <name>
 *   /tpx list
 *   /tpx test [name]                             check reachability (all when no name)
 *   /tpx set <name> restart|description <text…>  (empty text clears)
 *   /tpx ssh <name>                              the command for an interactive session
 *   /tpx help
 */
import type { TpxTerminal } from '../types'
import { checkTerminal, forgetHealth } from './activity'
import type { Host } from './host'
import { operatorDirectory } from './local'
import { type SshSettings, interactiveCommand } from './ssh'
import {
  TerminalError,
  addTerminal,
  expandHome,
  findTerminal,
  isAbsolutePath,
  parseTarget,
  removeTerminal,
  targetOf,
  updateTerminal,
  validateName,
} from './terminals'

export const HELP = [
  'TPX Operator — remote terminals over SSH',
  '',
  '  /tpx                                         open the Operator pane',
  '  /tpx add <name> <user@host[:port]> <key> [description]',
  '                                               add a terminal (key: path to a private key)',
  '  /tpx keygen <name>                           create a key pair; add its public key to the server',
  '  /tpx remove <name>                           forget a terminal (nothing on the server changes)',
  '  /tpx list                                    list terminals',
  '  /tpx test [name]                             check that terminals are reachable',
  '  /tpx set <name> restart <command>            the command restart_server runs',
  '  /tpx set <name> description <text>           what the server is, for Claude',
  '  /tpx ssh <name>                              the ssh command for an interactive session',
].join('\n')

/** Splits on whitespace, honouring "double" and 'single' quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (const m of input.matchAll(re)) tokens.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3] ?? ''))
  return tokens
}

export type AddRequest = { name: string; target: string; key: string; description?: string }

/** Validates and stores a terminal; the pane's form and /tpx add both come here. */
export async function addFromRequest(host: Host, request: AddRequest): Promise<{ terminal: TpxTerminal; replaced: boolean }> {
  const name = validateName(request.name)
  const target = parseTarget(request.target)
  const home = await host.home()
  const identityFile = expandHome(request.key, home)
  if (identityFile === '') throw new TerminalError('a private key path is required')
  if (!isAbsolutePath(identityFile))
    throw new TerminalError(`the key path must be absolute or start with ~/ (got ${JSON.stringify(request.key)})`)
  if (!(await host.exists(identityFile))) throw new TerminalError(`no key file at ${identityFile}`)
  const head = (await host.readText(identityFile)).slice(0, 200)
  if (/^ssh-(rsa|ed25519|dss)|^ecdsa-sha2-/.test(head))
    throw new TerminalError(`${identityFile} is a public key — give the private key (usually the same path without .pub)`)
  if (!/PRIVATE KEY/.test(head)) throw new TerminalError(`${identityFile} does not look like a private key`)
  const description = request.description?.trim()
  const existing = (await host.loadTerminals()).find(t => t.name === name)
  const terminal: TpxTerminal = {
    name,
    ...target,
    identityFile,
    ...(description ? { description } : existing?.description ? { description: existing.description } : {}),
    ...(existing?.restartCommand ? { restartCommand: existing.restartCommand } : {}),
    addedAt: existing?.addedAt ?? (await host.now()),
  }
  const { replaced } = await addTerminal(host, terminal)
  return { terminal, replaced }
}

/** Makes an ed25519 key pair under ~/.tpx-operator/keys/ and returns the paths and public key. */
export async function generateKey(host: Host, rawName: string): Promise<{ privatePath: string; publicKey: string }> {
  const name = validateName(rawName)
  const dir = await operatorDirectory(host, 'keys')
  const privatePath = `${dir}/${name}`
  if (await host.exists(privatePath)) {
    if (await host.exists(`${privatePath}.pub`))
      return { privatePath, publicKey: (await host.readText(`${privatePath}.pub`)).trim() }
    throw new TerminalError(`${privatePath} already exists`)
  }
  await host.write(`${dir}/.keep`, '')
  const result = await host.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', `tpx-operator:${name}`, '-f', privatePath], {
    timeoutMs: 30_000,
  })
  if (result.exitCode !== 0) throw new TerminalError(`ssh-keygen failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  await host.run(['chmod', '600', privatePath], { timeoutMs: 10_000 }).catch(() => undefined)
  return { privatePath, publicKey: (await host.readText(`${privatePath}.pub`)).trim() }
}

function describe(t: TpxTerminal): string {
  return [
    `${t.name}  ${targetOf(t)}`,
    `    key: ${t.identityFile}`,
    ...(t.description ? [`    ${t.description}`] : []),
    `    restart: ${t.restartCommand ?? '(not set)'}`,
  ].join('\n')
}

export async function runTpxCommand(
  host: Host,
  args: string,
  settings: SshSettings,
): Promise<{ text: string; openPane?: boolean }> {
  const [sub = '', ...rest] = tokenize(args)
  try {
    switch (sub.toLowerCase()) {
      case '':
      case 'open':
      case 'pane':
        return { text: 'TPX Operator pane opened.', openPane: true }
      case 'help':
        return { text: HELP }
      case 'list':
      case 'ls': {
        const terminals = await host.loadTerminals()
        return {
          text: terminals.length
            ? terminals.map(describe).join('\n')
            : 'No terminals yet. Add one with /tpx add <name> <user@host[:port]> <key>, or open the pane with /tpx.',
        }
      }
      case 'add': {
        const [name, target, key, ...description] = rest
        if (!name || !target || !key) return { text: `usage: /tpx add <name> <user@host[:port]> <key> [description]` }
        const { terminal, replaced } = await addFromRequest(host, { name, target, key, description: description.join(' ') })
        const health = await checkTerminal(host, terminal, settings)
        await host.setNotice(`${replaced ? 'Updated' : 'Added'} ${terminal.name}.`)
        return {
          text:
            `${replaced ? 'Updated' : 'Added'} terminal ${terminal.name} (${targetOf(terminal)}). ` +
            (health.isReachable
              ? `Reachable in ${health.latencyMs} ms.`
              : `Not reachable yet: ${health.error}. Check the target and that the key is authorized on the server.`),
        }
      }
      case 'keygen': {
        const [name] = rest
        if (!name) return { text: 'usage: /tpx keygen <name>' }
        const { privatePath, publicKey } = await generateKey(host, name)
        return {
          text: [
            `Key pair for ${name}: ${privatePath}`,
            'Add this public key to ~/.ssh/authorized_keys on the server:',
            '',
            publicKey,
            '',
            `Then: /tpx add ${name} <user@host[:port]> ${privatePath}`,
          ].join('\n'),
        }
      }
      case 'remove':
      case 'rm': {
        const [name] = rest
        if (!name) return { text: 'usage: /tpx remove <name>' }
        const removed = await removeTerminal(host, name)
        if (removed) await forgetHealth(host, name)
        return { text: removed ? `Removed terminal ${name}. Its key file was left in place.` : `No terminal named ${name}.` }
      }
      case 'test':
      case 'check': {
        const [name] = rest
        const terminals = name ? [await findTerminal(host, name)] : await host.loadTerminals()
        if (terminals.length === 0) return { text: 'No terminals to test.' }
        const lines = await Promise.all(
          terminals.map(async t => {
            const health = await checkTerminal(host, t, settings)
            return health.isReachable ? `● ${t.name}: reachable (${health.latencyMs} ms)` : `○ ${t.name}: ${health.error}`
          }),
        )
        return { text: lines.join('\n') }
      }
      case 'set': {
        const [name, field = '', ...value] = rest
        const text = value.join(' ').trim()
        if (!name || !['restart', 'description'].includes(field))
          return { text: 'usage: /tpx set <name> restart|description <text> (empty text clears)' }
        const updated = await updateTerminal(host, name, t => {
          const { restartCommand, description, ...base } = t
          const next: TpxTerminal = { ...base }
          const keepRestart = field === 'restart' ? text : restartCommand
          const keepDescription = field === 'description' ? text : description
          if (keepRestart) next.restartCommand = keepRestart
          if (keepDescription) next.description = keepDescription
          return next
        })
        return {
          text:
            field === 'restart'
              ? `${updated.name}: restart command ${updated.restartCommand ? `set to: ${updated.restartCommand}` : 'cleared'}`
              : `${updated.name}: description ${updated.description ? 'set' : 'cleared'}`,
        }
      }
      case 'ssh': {
        const [name] = rest
        if (!name) return { text: 'usage: /tpx ssh <name>' }
        const terminal = await findTerminal(host, name)
        return { text: `Run this in a terminal for an interactive session on ${terminal.name}:\n\n  ${interactiveCommand(terminal)}` }
      }
      default:
        return { text: `Unknown subcommand "${sub}".\n\n${HELP}` }
    }
  } catch (error) {
    return { text: `tpx: ${error instanceof Error ? error.message : String(error)}` }
  }
}
