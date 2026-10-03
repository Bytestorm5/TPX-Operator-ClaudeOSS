/**
 * TPX Operator's contract: the values it keeps in `$.state` for its pane,
 * and the shapes they are made of.
 */

/** A remote terminal the person added: an SSH target and the key that opens it. */
export type TpxTerminal = {
  /** The name the person and the model refer to it by (`prod-web`). */
  name: string
  host: string
  port: number
  user: string
  /** Absolute path of the private key on this machine. */
  identityFile: string
  /** What the server is, shown to the model. */
  description?: string
  /** The command restart_server runs; absent, restart_server refuses. */
  restartCommand?: string
  addedAt: number
}

/** The last reachability check of one terminal. */
export type TpxHealth = {
  isReachable: boolean
  checkedAt: number
  latencyMs?: number
  /** Why the check failed, cut to one line. */
  error?: string
}

/** One line of the activity feed: a tool call or a command against a terminal. */
export type TpxActivity = {
  id: string
  at: number
  terminal: string
  action: string
  detail: string
  status: 'running' | 'ok' | 'error' | 'denied'
  durationMs?: number
}

declare module 'claude-code' {
  interface PluginState {
    'tpx-operator': {
      terminals: TpxTerminal[]
      health: Record<string, TpxHealth>
      activity: TpxActivity[]
      /** The add form's last error or success line. */
      notice: string
    }
  }
}
