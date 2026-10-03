import { describe, expect, test } from 'claude-code/testing'

import { HOME, KEY, SESSION, TOOL, WEB, batchOf, tpx, world } from './fixtures/world'


describe('register', () => {
  test('the start registers /tpx and the Operator toolset', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)

    expect(w.registered).toEqual([
      'list_terminals',
      'run_command',
      'list_files',
      'read_file',
      'edit_file',
      'write_file',
      'delete_file',
      'restart_server',
      'upload_file',
      'download_file',
      'memory_read',
      'memory_write',
      'memory_delete',
    ])
    const { text } = await $.command.run(tpx('help'))
    expect(text).toContain('/tpx add <name> <user@host[:port]> <key>')
  })

  test('/tpx add stores a terminal and checks it over ssh', async ($, on) => {
    const w = world(on)
    await $.session.start(SESSION)

    const { text } = await $.command.run(tpx('add web deploy@203.0.113.7:2222 ~/.ssh/id_web the web server'))

    expect(text).toContain('Added terminal web (deploy@203.0.113.7:2222)')
    expect(w.runs[0]?.argv).toEqual([
      'ssh',
      '-i',
      KEY,
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=4',
      '-o',
      'LogLevel=ERROR',
      '-p',
      '2222',
      '-T',
      'deploy@203.0.113.7',
      '--',
      'true',
    ])
    const listed = await $.tool.call({ tool: TOOL('list_terminals') })
    expect(listed.result).toContain('- web: deploy@203.0.113.7:2222 — the web server')
  })

  test('/tpx add refuses a public key and a missing file', async ($, on) => {
    world(on, { files: { [`${KEY}.pub`]: 'ssh-ed25519 AAAAC3Nza tpx' } })
    await $.session.start(SESSION)
    const add = (args: string) => $.command.run(tpx(args))

    expect((await add(`add web deploy@h ${KEY}.pub`)).text).toContain('is a public key')
    expect((await add('add web deploy@h ~/.ssh/nothing')).text).toContain(`no key file at ${HOME}/.ssh/nothing`)
    expect((await add('add "bad name" deploy@h ~/.ssh/id_web')).text).toContain('invalid terminal name')
    expect((await add('add web nobody ~/.ssh/id_web')).text).toContain('invalid target')
  })

  test('run_command runs over ssh and reports the exit code and output', async ($, on) => {
    const w = world(on, {
      terminals: [WEB],
      remote: run => (run.argv.at(-1) === 'uptime' ? { stdout: ' 10:00 up 3 days\n' } : { exitCode: 1 }),
    })
    await $.session.start(SESSION)

    const ran = await $.tool.call({ tool: TOOL('run_command'), terminal: 'web', command: 'uptime' })

    expect(ran.result).toBe('exit code: 0\nstdout:\n 10:00 up 3 days')
    expect(w.runs.at(-1)?.argv.slice(-3)).toEqual(['deploy@203.0.113.7', '--', 'uptime'])
  })

  test('a tool naming an unknown terminal says which ones exist', async ($, on) => {
    world(on, { terminals: [WEB] })
    await $.session.start(SESSION)

    const ran = await $.tool.call({ tool: TOOL('run_command'), terminal: 'db', command: 'ls' })

    expect(ran.isError).toBe(true)
    expect(String(ran.text ?? ran.result)).toContain('known terminals: web')
  })

  test('read_file fetches over sftp and numbers the lines', async ($, on) => {
    const w = world(on, {
      terminals: [WEB],
      remote: (run, files) => {
        const get = batchOf(run).find(l => l.startsWith('get '))
        const local = get && /^get "(?:[^"\\]|\\.)*" "(.*)"$/.exec(get)?.[1]
        if (local) files.set(local, 'server {\n  listen 80;\n}\n')
        return {}
      },
    })
    await $.session.start(SESSION)

    const read = await $.tool.call({ tool: TOOL('read_file'), terminal: 'web', path: '/etc/nginx/site.conf' })

    expect(read.result).toBe('/etc/nginx/site.conf (lines 1-3 of 3)\n1| server {\n2|   listen 80;\n3| }')
    expect(batchOf(w.runs.find(r => r.argv[0] === 'sftp')!)[0]).toMatch(/^get "\/etc\/nginx\/site.conf" "\/home\/ada\/.tpx-operator\/staging\/read_[0-9a-f]+"$/)
    expect([...w.files.keys()].some(p => p.includes('/staging/read_')), 'the staging file is removed').toBe(false)
  })

  test('edit_file replaces a unique string and puts the file back', async ($, on) => {
    let uploaded = ''
    world(on, {
      terminals: [WEB],
      remote: (run, files) => {
        const lines = batchOf(run)
        const get = lines.find(l => l.startsWith('get '))
        const put = lines.find(l => l.startsWith('put '))
        if (get) files.set(/ "([^"]*)"$/.exec(get)![1]!, 'a=1\nb=2\n')
        if (put) uploaded = files.get(/^put "(.*?)" /.exec(put)![1]!) ?? ''
        return {}
      },
    })
    await $.session.start(SESSION)

    const edited = await $.tool.call({
      tool: TOOL('edit_file'),
      terminal: 'web',
      path: 'app.env',
      old_string: 'b=2',
      new_string: 'b=3',
    })

    expect(edited.result).toBe('edited app.env: 1 replacement (8 bytes now)')
    expect(uploaded).toBe('a=1\nb=3\n')
  })

  test('write_file creates the parent directories first', async ($, on) => {
    const w = world(on, { terminals: [WEB] })
    await $.session.start(SESSION)

    await $.tool.call({ tool: TOOL('write_file'), terminal: 'web', path: '/srv/app/conf/a.txt', content: 'hi' })

    const lines = batchOf(w.runs.find(r => r.argv[0] === 'sftp')!)
    expect(lines.slice(0, 3)).toEqual(['-mkdir "/srv"', '-mkdir "/srv/app"', '-mkdir "/srv/app/conf"'])
    expect(lines[3]).toMatch(/^put ".*\/staging\/write_[0-9a-f]+" "\/srv\/app\/conf\/a.txt"$/)
  })

  test('delete_file asks first, and a decline runs nothing', async ($, on) => {
    const w = world(on, { terminals: [WEB] })
    await $.session.start(SESSION)

    w.answerWith('Decline')
    const declined = await $.tool.call({ tool: TOOL('delete_file'), terminal: 'web', path: '/tmp/x' })
    expect(w.asked).toEqual(['Delete /tmp/x on web (deploy@203.0.113.7:2222)?'])
    expect(String(declined.deny ?? declined.text)).toContain('declined by the user')
    expect(w.runs.filter(r => r.argv[0] === 'sftp')).toEqual([])

    w.answerWith('Allow')
    const deleted = await $.tool.call({ tool: TOOL('delete_file'), terminal: 'web', path: '/tmp/x' })
    expect(deleted.result).toBe('deleted /tmp/x')
    expect(batchOf(w.runs.find(r => r.argv[0] === 'sftp')!)).toEqual(['rm "/tmp/x"'])
  })

  test('upload_file and download_file move files with sftp put and get', async ($, on) => {
    const w = world(on, { terminals: [WEB], files: { '/work/dist/app.tar.gz': 'bytes' } })
    await $.session.start(SESSION)

    const up = await $.tool.call({
      tool: TOOL('upload_file'),
      terminal: 'web',
      local_path: '/work/dist/app.tar.gz',
      remote_path: 'releases/app.tar.gz',
    })
    const down = await $.tool.call({
      tool: TOOL('download_file'),
      terminal: 'web',
      remote_path: '/var/log/nginx/error.log',
      local_path: '/work/logs/error.log',
    })

    expect(up.result).toBe('uploaded /work/dist/app.tar.gz (5 bytes) to web:releases/app.tar.gz')
    expect(String(down.result)).toContain('downloaded web:/var/log/nginx/error.log to /work/logs/error.log')
    const batches = w.runs.filter(r => r.argv[0] === 'sftp').map(batchOf)
    expect(batches[0]).toEqual(['-mkdir "releases"', 'put "/work/dist/app.tar.gz" "releases/app.tar.gz"'])
    expect(batches[1]).toEqual(['get "/var/log/nginx/error.log" "/work/logs/error.log"'])
  })

  test('memory persists in ~/.tpx-operator/memory and IMMEDIATE.md rides in the prompt', async ($, on) => {
    const w = world(on, { terminals: [WEB] })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'intro', scope: 'shared' }] }))
    await $.session.start(SESSION)

    await $.tool.call({ tool: TOOL('memory_write'), name: 'IMMEDIATE', content: 'web runs nginx behind haproxy' })
    expect(w.files.get(`${HOME}/.tpx-operator/memory/IMMEDIATE.md`)).toBe('web runs nginx behind haproxy')

    const { sections } = await $.prompt.compose({
      model: 'claude-opus-5-5',
      promptModel: 'claude-opus-5-5',
      surfaces: ['terminal'],
      tools: [],
      outputStyle: null,
      traits: [],
    })
    const ours = sections.find(s => s.id === 'tpx-operator:operator')
    expect(ours?.scope).toBe('session')
    expect(ours?.text).toContain('- web: deploy@203.0.113.7:2222 — the web server')
    expect(ours?.text).toContain('web runs nginx behind haproxy')
  })

  test('restart_server refuses a terminal with no restart command', async ($, on) => {
    world(on, { terminals: [{ ...WEB, restartCommand: undefined }] })
    await $.session.start(SESSION)

    const ran = await $.tool.call({ tool: TOOL('restart_server'), terminal: 'web' })

    expect(String(ran.text ?? ran.result)).toContain('has no restart command configured')
  })
})
