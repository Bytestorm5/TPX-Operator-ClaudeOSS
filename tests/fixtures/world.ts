import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

export const HOME = '/home/ada'
export const KEY = `${HOME}/.ssh/id_web`
export const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n'

export const WEB = {
  name: 'web',
  host: '203.0.113.7',
  port: 2222,
  user: 'deploy',
  identityFile: KEY,
  description: 'the web server',
  restartCommand: 'sudo systemctl restart nginx',
  addedAt: 1,
}

export type Run = { argv: readonly string[]; stdin: string | undefined }
export type Answer = { exitCode?: number; stdout?: string; stderr?: string }

/**
 * The world beneath the mod: an in-memory filesystem, a scripted process
 * runner (ssh and sftp answered by `remote`), the store, the clock, HOME.
 */
export function world(
  on: On,
  options: {
    terminals?: unknown[]
    files?: Record<string, string>
    /** Answers one ssh command or one sftp batch. */
    remote?: (run: Run, files: Map<string, string>) => Answer
  } = {},
) {
  const files = new Map<string, string>(Object.entries({ [KEY]: PRIVATE_KEY, ...options.files }))
  const runs: Run[] = []
  const asked: string[] = []
  const registered: string[] = []
  let answer = 'Allow'
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, options.terminals ? { terminals: options.terminals } : {})
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const statuses: Array<string | undefined> = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__tpx-operator__${e.name}` } }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(p => p.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    const asBytes = e.as === 'bytes'
    return { value: asBytes ? { base64: btoa(text) } : text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.list', ($, e) => ({
    value: [...files.keys()]
      .filter(p => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/'))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: files.get(p)!.length, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', ($, e) => {
    const run = { argv: e.argv, stdin: e.init?.stdin }
    runs.push(run)
    if (e.argv[0] === 'rm') {
      files.delete(e.argv[e.argv.length - 1]!)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const a = options.remote?.(run, files) ?? {}
    return {
      value: {
        exitCode: a.exitCode ?? 0,
        stdout: a.stdout ?? '',
        stderr: a.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  // $.ui.ask is a call of the AskUserQuestion tool: answer it as the person would.
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  return {
    files,
    runs,
    asked,
    registered,
    statuses,
    clock,
    answerWith(text: string) {
      answer = text
    },
  }
}

export const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

/** The sftp batch lines of a run, or [] for another command. */
export function batchOf(run: Run): string[] {
  return run.argv[0] === 'sftp' ? (run.stdin ?? '').trim().split('\n') : []
}

/** `/tpx <args>` as the person types it. */
export function tpx(args: string) {
  return {
    command: 'tpx',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: true, columns: 160 },
  }
}

/** The full name a tool of the mod is called by. */
export const TOOL = <N extends string>(name: N) => `mcp__tpx-operator__${name}` as const
