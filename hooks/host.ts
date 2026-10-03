/**
 * What the rest of the mod needs from the engine, as plain functions.
 *
 * The engine reads a hooks module's `$` calls off its source, so `$` never
 * crosses an import: register.tsx builds this from `$` (every call spelled
 * `$.noun.method(...)` there), and every other file takes a Host.
 */
import type { FsEntry, FsStat, ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { TpxActivity, TpxHealth, TpxTerminal } from '../types'

export type Host = {
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  readText: (path: string) => Promise<string>
  readBase64: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  stat: (path: string) => Promise<FsStat>
  list: (path: string) => Promise<FsEntry[]>
  /** The home directory: HOME, else USERPROFILE. */
  home: () => Promise<string | undefined>
  now: () => Promise<number>

  /** The terminal registry, kept across sessions. */
  loadTerminals: () => Promise<TpxTerminal[]>
  /** Stores the registry and redraws the pane. */
  saveTerminals: (terminals: TpxTerminal[]) => Promise<void>
  updateHealth: (change: (health: Record<string, TpxHealth>) => Record<string, TpxHealth>) => Promise<void>
  updateActivity: (change: (activity: TpxActivity[]) => TpxActivity[]) => Promise<void>
  setNotice: (text: string) => Promise<void>

  /** Asks the person in Claude Code's question dialog; rejects when dismissed or nobody can be asked. */
  ask: (question: string, options: readonly string[]) => Promise<string>
  toast: (text: string) => void
  status: (text: string | undefined) => void
  copy: (text: string, surface?: string) => Promise<boolean>
}
