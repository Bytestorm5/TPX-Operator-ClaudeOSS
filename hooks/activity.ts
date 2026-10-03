/**
 * The activity feed and reachability checks the pane draws, held in
 * `$.state` for the session (a hot reload keeps them) through the Host.
 */
import type { TpxActivity, TpxHealth, TpxTerminal } from '../types'
import type { Host } from './host'
import { randomId } from './local'
import { type SshSettings, errorLine, sshExec } from './ssh'

const MAX_ACTIVITY = 50

export async function startActivity(
  host: Host,
  entry: Pick<TpxActivity, 'terminal' | 'action' | 'detail'>,
): Promise<{ finish: (status: TpxActivity['status']) => Promise<void> }> {
  const startedAt = await host.now()
  const id = randomId('act')
  const activity: TpxActivity = { id, at: startedAt, status: 'running', ...entry, detail: entry.detail.slice(0, 200) }
  await host.updateActivity(list => [...list, activity].slice(-MAX_ACTIVITY))
  return {
    async finish(status) {
      const durationMs = (await host.now()) - startedAt
      await host.updateActivity(list => list.map(a => (a.id === id ? { ...a, status, durationMs } : a)))
    },
  }
}

/** Connects and runs `true`: reachable, how fast, or why not. */
export async function checkTerminal(host: Host, terminal: TpxTerminal, settings: SshSettings): Promise<TpxHealth> {
  const startedAt = await host.now()
  let health: TpxHealth
  try {
    const result = await sshExec(host, terminal, 'true', {
      timeoutMs: (settings.connectTimeoutSeconds + 10) * 1000,
      settings,
    })
    const checkedAt = await host.now()
    health =
      result.exitCode === 0
        ? { isReachable: true, checkedAt, latencyMs: checkedAt - startedAt }
        : { isReachable: false, checkedAt, error: errorLine(result.stderr) || `exit ${result.exitCode}` }
  } catch (error) {
    health = {
      isReachable: false,
      checkedAt: await host.now(),
      error: (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 200) ?? 'failed',
    }
  }
  await host.updateHealth(map => ({ ...map, [terminal.name]: health }))
  return health
}

export async function forgetHealth(host: Host, name: string): Promise<void> {
  await host.updateHealth(map => {
    const { [name]: _, ...rest } = map
    return rest
  })
}
