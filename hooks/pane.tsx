/**
 * The Operator pane: the person's terminals with their reachability, a form
 * to add one, and the activity feed of what Claude ran where. Headed by the
 * "Powered by Trusplex Operator" badge, the one piece of branding.
 */
import type { Elements, RenderChildren } from 'claude-code'

import type { TpxActivity, TpxHealth, TpxTerminal } from '../types'
import { checkTerminal, forgetHealth } from './activity'
import { BADGE_CELLS, BADGE_COLUMNS, BADGE_NAME, BADGE_ROWS } from './badge-cells'
import { BADGE_SVG, BADGE_SVG_HEIGHT, BADGE_SVG_WIDTH } from './badge-svg'
import { addFromRequest, generateKey } from './commands'
import type { Host } from './host'
import { type SshSettings, interactiveCommand } from './ssh'
import { removeTerminal, targetOf } from './terminals'

export const PANE_ID = 'tpx-operator'
export const PANE_TITLE = 'TPX Operator'

/** Brand colours (Trusplex tokens), dark-ground values. */
const COLOR = {
  accent: '#1C83EA',
  violet: '#746DF8',
  blue: '#0039D8',
  ebony: '#0B0B1B',
  smoke: '#D3D6E0',
  error: '#E5484D',
}

/** The add form's text, as typed: the module's own, so typing never waits on a redraw. */
const draft = { name: '', target: '', key: '', description: '' }
type DraftField = keyof typeof draft

const ACTIVITY_SHOWN = 12

export type PaneView = {
  terminals: TpxTerminal[]
  health: Record<string, TpxHealth>
  activity: TpxActivity[]
  notice: string
  columns: number
  surface: string
}

function timeOf(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

function durationOf(ms: number | undefined): string {
  if (ms === undefined) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

const STATUS_GLYPH: Record<TpxActivity['status'], string> = { running: '…', ok: '✓', error: '✕', denied: '⊘' }

async function submitAdd(host: Host, settings: SshSettings): Promise<void> {
  try {
    const { terminal, replaced } = await addFromRequest(host, { ...draft })
    draft.name = ''
    draft.target = ''
    draft.key = ''
    draft.description = ''
    await host.setNotice(`${replaced ? 'Updated' : 'Added'} ${terminal.name} — checking…`)
    const health = await checkTerminal(host, terminal, settings)
    await host.setNotice(
      health.isReachable
        ? `${replaced ? 'Updated' : 'Added'} ${terminal.name}: reachable in ${health.latencyMs} ms.`
        : `${replaced ? 'Updated' : 'Added'} ${terminal.name}, but it is not reachable: ${health.error}`,
    )
  } catch (error) {
    await host.setNotice(`✕ ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function submitKeygen(host: Host): Promise<void> {
  if (!draft.name.trim()) {
    await host.setNotice('✕ Type a name first: the key is made for that terminal.')
    return
  }
  try {
    const { privatePath, publicKey } = await generateKey(host, draft.name)
    draft.key = privatePath
    await host.setNotice(`Key made. Add this line to ~/.ssh/authorized_keys on the server, then press Add:\n${publicKey}`)
  } catch (error) {
    await host.setNotice(`✕ ${error instanceof Error ? error.message : String(error)}`)
  }
}

function healthLine(health: TpxHealth | undefined): { glyph: string; color?: string; text: string } {
  if (!health) return { glyph: '·', text: 'not checked' }
  if (health.isReachable) return { glyph: '●', color: COLOR.accent, text: `${health.latencyMs ?? 0} ms` }
  return { glyph: '✕', color: COLOR.error, text: health.error ?? 'unreachable' }
}

export function renderPane(
  elements: Elements[keyof Elements],
  host: Host,
  view: PaneView,
  settings: SshSettings,
) {
  const { Box, Text, Button } = elements
  // Tables carry a stand-in for an element the surface lacks, so pick by surface, not by name.
  const { surface } = view
  const Input = surface !== 'mobile' && 'Input' in elements ? elements.Input : undefined
  const Raster = surface === 'terminal' && 'Raster' in elements ? elements.Raster : undefined
  const Svg = surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
  const { terminals, health, activity, notice } = view
  const columns = Math.max(20, view.columns)

  // -- the badge ----------------------------------------------------------------
  let badge
  if (Raster && columns >= BADGE_COLUMNS) {
    badge = (
      <Box position="relative" width={BADGE_COLUMNS} height={BADGE_ROWS}>
        <Raster key="badge" columns={BADGE_COLUMNS} rows={BADGE_ROWS} cells={BADGE_CELLS} />
        <Box position="absolute" top={BADGE_NAME.row} left={BADGE_NAME.column}>
          <Text bold color="#FFFFFF" backgroundColor={BADGE_NAME.background}>
            {BADGE_NAME.text}
          </Text>
        </Box>
      </Box>
    )
  } else if (Svg) {
    badge = <Svg source={BADGE_SVG} alt="Powered by Trusplex Operator" width={BADGE_SVG_WIDTH} height={BADGE_SVG_HEIGHT} />
  } else {
    badge = (
      <Box>
        <Text color={COLOR.violet}>▐</Text>
        <Text color={COLOR.smoke} backgroundColor={COLOR.ebony}>
          {' Powered by '}
        </Text>
        <Text bold color="#FFFFFF" backgroundColor={COLOR.ebony}>
          {'Trusplex Operator '}
        </Text>
        <Text color={COLOR.blue}>▌</Text>
      </Box>
    )
  }

  // -- terminals -----------------------------------------------------------------
  const rows = terminals.map((t: TpxTerminal) => {
    const shown = healthLine(health[t.name])
    return (
      <Box key={`t:${t.name}`} flexDirection="column" marginBottom={1}>
        <Box>
          <Text color={shown.color} dimColor={!shown.color}>
            {shown.glyph}{' '}
          </Text>
          <Text bold>{t.name}</Text>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {targetOf(t)}
          </Text>
        </Box>
        {t.description ? (
          <Text dimColor wrap="truncate-end">
            {'  '}
            {t.description}
          </Text>
        ) : null}
        <Text color={shown.color === COLOR.error ? COLOR.error : undefined} dimColor={shown.color !== COLOR.error} wrap="truncate-end">
          {'  '}
          {shown.text}
          {t.restartCommand ? ` · restart: ${t.restartCommand}` : ''}
        </Text>
        <Box gap={1} marginLeft={2}>
          <Button key={`test:${t.name}`} dimColor onPress={() => void checkTerminal(host, t, settings)}>
            Test
          </Button>
          <Button
            key={`ssh:${t.name}`}
            dimColor
            onPress={press => {
              void host.copy(interactiveCommand(t), press.surface).then(isCopied =>
                host.toast(isCopied ? `Copied: ${interactiveCommand(t)}` : interactiveCommand(t)),
              )
            }}
          >
            Copy ssh
          </Button>
          <Button
            key={`rm:${t.name}`}
            dimColor
            onPress={() =>
              void removeTerminal(host, t.name).then(async removed => {
                if (!removed) return
                await forgetHealth(host, t.name)
                host.toast(`Removed ${t.name}. Its key file was left in place.`)
              })
            }
          >
            Remove
          </Button>
        </Box>
      </Box>
    )
  })

  // -- the add form -------------------------------------------------------------
  const field = (key: DraftField, label: string, placeholder: string) =>
    Input ? (
      <Input
        key={`add:${key}`}
        label={label}
        placeholder={placeholder}
        value={draft[key]}
        submitLabel="add"
        onInput={value => {
          draft[key] = value
        }}
        onSubmit={value => {
          draft[key] = value
          void submitAdd(host, settings)
        }}
      />
    ) : null

  const form = Input ? (
    <Box flexDirection="column">
      <Text bold>Add a terminal</Text>
      {field('name', 'Name        ', 'prod-web')}
      {field('target', 'Target      ', 'deploy@203.0.113.7:22')}
      {field('key', 'Private key ', '~/.ssh/id_ed25519')}
      {field('description', 'Description ', 'optional: what this server is')}
      <Box gap={1} marginTop={1}>
        <Button key="add" variant="primary" onPress={() => void submitAdd(host, settings)}>
          Add
        </Button>
        <Button key="keygen" onPress={() => void submitKeygen(host)}>
          Generate key
        </Button>
      </Box>
    </Box>
  ) : (
    <Text dimColor>Add terminals with /tpx add &lt;name&gt; &lt;user@host[:port]&gt; &lt;key&gt;</Text>
  )

  // -- activity -----------------------------------------------------------------
  const recent = activity.slice(-ACTIVITY_SHOWN).reverse()
  const feed = recent.map((a: TpxActivity) => (
    <Text
      wrap="truncate-end"
      color={a.status === 'error' || a.status === 'denied' ? COLOR.error : undefined}
      dimColor={a.status === 'ok'}
    >
      {timeOf(a.at)} {STATUS_GLYPH[a.status]} {a.terminal ? `${a.terminal} ` : ''}
      {a.action}
      {a.detail ? `  ${a.detail}` : ''}
      {a.durationMs !== undefined ? `  ${durationOf(a.durationMs)}` : ''}
    </Text>
  ))

  const rule = (title: string, extra?: RenderChildren) => (
    <Box marginTop={1} justifyContent="space-between">
      <Text bold color={COLOR.accent}>
        {title}
      </Text>
      {extra ?? null}
    </Box>
  )

  return (
    <Box flexDirection="column" width={columns}>
      {badge}
      {rule(
        `Terminals (${terminals.length})`,
        terminals.length > 0 ? (
          <Button
            key="test-all"
            dimColor
            onPress={() => void Promise.all(terminals.map((t: TpxTerminal) => checkTerminal(host, t, settings)))}
          >
            Test all
          </Button>
        ) : null,
      )}
      {terminals.length === 0 ? (
        <Text dimColor>No terminals yet. Add one below, or with /tpx add.</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {rows}
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {form}
        {notice ? (
          <Text color={notice.startsWith('✕') ? COLOR.error : undefined} dimColor={!notice.startsWith('✕')}>
            {notice}
          </Text>
        ) : null}
      </Box>
      {rule('Activity')}
      {feed.length === 0 ? <Text dimColor>Nothing yet: Claude's remote work shows here.</Text> : feed}
    </Box>
  )
}
