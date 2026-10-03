import { describe, expect, test } from 'claude-code/testing'

import { KEY, SESSION, TOOL, WEB, tpx, world } from './fixtures/world'

const PANE = {
  plugin: 'tpx-operator',
  component: 'Pane',
  requestId: 'tpx-operator',
} as const

const propsAt = (bodyColumns: number) => ({
  title: 'TPX Operator',
  isFocused: true,
  bodyColumns,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
})

describe('pane', () => {
  test('/tpx opens the pane', async ($, on) => {
    const opened: string[] = []
    world(on)
    on('ui.open', ($, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    await $.session.start(SESSION)

    const { text } = await $.command.run(tpx(''))

    expect(text).toBe('TPX Operator pane opened.')
    expect(opened).toEqual(['tpx-operator'])
  })

  test('the pane shows the badge and the terminals on every surface that draws one', async ($, on) => {
    world(on, { terminals: [WEB] })
    await $.session.start(SESSION)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface, props: propsAt(60) })
      if (surface === 'terminal') expect(await ui.find({ type: 'Raster', key: 'badge' }), `${surface} raster`).toBeDefined()
      else expect(await ui.find({ type: 'Svg' }), `${surface} svg`).toBeDefined()
      if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /Trusplex Operator/ }), `${surface} name`).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'web' }), `${surface} terminal name`).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /deploy@203\.0\.113\.7:2222/ }), `${surface} target`).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /restart: sudo systemctl restart nginx/ }), `${surface} restart`).toBeDefined()
      await ui.unmount()
    }
  })

  test('a narrow pane draws the one-line badge', async ($, on) => {
    world(on)
    await $.session.start(SESSION)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: propsAt(30) })

    expect(await ui.find({ type: 'Raster' }), 'no raster').toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Trusplex Operator/ }), 'the name').toBeDefined()
  })

  test('the form adds a terminal, and Test checks it', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface, props: propsAt(70) })
      await ui.input({ key: 'add:name', text: `web-${surface}`, kind: 'change' })
      await ui.input({ key: 'add:target', text: 'deploy@203.0.113.7:2222', kind: 'change' })
      await ui.input({ key: 'add:key', text: KEY, kind: 'change' })
      await ui.press({ key: 'add' })

      expect(await ui.find({ type: 'Text', text: `web-${surface}` })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /reachable in \d+ ms/ })).toBeDefined()

      const before = w.runs.length
      await ui.press({ key: `test:web-${surface}` })
      expect(w.runs.length).toBe(before + 1)
      await ui.unmount()
    }
  })

  test('a bad form entry shows why, and Remove forgets a terminal', async ($, on) => {
    world(on, { terminals: [WEB] })
    await $.session.start(SESSION)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: propsAt(70) })
    await ui.input({ key: 'add:name', text: 'db', kind: 'change' })
    await ui.input({ key: 'add:target', text: 'not a target', kind: 'change' })
    await ui.press({ key: 'add' })
    expect(await ui.find({ type: 'Text', text: /✕ invalid target/ })).toBeDefined()

    await ui.press({ key: 'rm:web' })
    expect(await ui.find({ type: 'Text', text: /No terminals yet/ })).toBeDefined()
  })

  test('remote tool calls land in the activity feed', async ($, on) => {
    world(on, { terminals: [WEB], remote: () => ({ stdout: 'ok' }) })
    await $.session.start(SESSION)

    await $.tool.call({ tool: TOOL('run_command'), terminal: 'web', command: 'df -h' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: propsAt(70) })

    expect(await ui.find({ type: 'Text', text: /✓ web run_command {2}df -h/ })).toBeDefined()
  })
})
