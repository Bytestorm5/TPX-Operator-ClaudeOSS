import { describe, expect, test } from 'claude-code/testing'

import { tokenize } from '../hooks/commands'
import { interactiveCommand, parentDirectories, parseListing, sftpQuote } from '../hooks/ssh'
import { expandHome, parseTarget, targetOf } from '../hooks/terminals'
import { WEB } from './fixtures/world'

describe('ssh', () => {
  test('targets parse with and without a port, IPv6 too', async () => {
    expect(parseTarget('deploy@example.com')).toEqual({ user: 'deploy', host: 'example.com', port: 22 })
    expect(parseTarget('root@10.0.0.4:2200')).toEqual({ user: 'root', host: '10.0.0.4', port: 2200 })
    expect(parseTarget('ops@[2001:db8::1]:22')).toEqual({ user: 'ops', host: '2001:db8::1', port: 22 })
    expect(targetOf({ user: 'ops', host: '2001:db8::1', port: 2222 })).toBe('ops@[2001:db8::1]:2222')
    expect(() => parseTarget('deploy@-oProxyCommand=x')).toThrow('invalid host')
    expect(() => parseTarget('example.com')).toThrow('invalid target')
  })

  test('sftp paths are quoted with quotes, backslashes and globs escaped', async () => {
    expect(sftpQuote('/var/log/a b.log')).toBe('"/var/log/a b.log"')
    expect(sftpQuote('we"ird\\*?[x].txt')).toBe('"we\\"ird\\\\\\*\\?\\[x\\].txt"')
    expect(() => sftpQuote('a\nb')).toThrow('control character')
  })

  test("sftp's ls -la lines parse into entries, directories first", async () => {
    const stdout = [
      'drwxr-xr-x    ? deploy   deploy       4096 Oct  3 06:57 /srv/.',
      'drwxr-xr-x    ? root     root         4096 Oct  3 06:57 /srv/..',
      '-rw-r--r--    ? deploy   deploy        220 Mar 31  2024 /srv/a b.txt',
      'lrwxrwxrwx    ? deploy   deploy         13 Oct  3 06:57 /srv/current',
      'drwxr-xr-x    ? 1000     1000         4096 Oct  3 06:57 /srv/releases',
    ].join('\n')
    expect(parseListing(stdout, '/srv').map(e => [e.type, e.name, e.size])).toEqual([
      ['directory', 'releases', 4096],
      ['file', 'a b.txt', 220],
      ['symlink', 'current', 13],
    ])
  })

  test('parent directories of a remote path, outermost first', async () => {
    expect(parentDirectories('/srv/app/conf/a.txt')).toEqual(['/srv', '/srv/app', '/srv/app/conf'])
    expect(parentDirectories('releases/app.tgz')).toEqual(['releases'])
    expect(parentDirectories('a.txt')).toEqual([])
  })

  test('the interactive ssh command and the home expansion', async () => {
    expect(interactiveCommand(WEB)).toBe('ssh -i /home/ada/.ssh/id_web -p 2222 deploy@203.0.113.7')
    expect(expandHome('~/.ssh/id', '/home/ada')).toBe('/home/ada/.ssh/id')
    expect(expandHome('/abs/key', '/home/ada')).toBe('/abs/key')
  })

  test('/tpx arguments split on spaces and honour quotes', async () => {
    expect(tokenize(`add web deploy@h "~/My Keys/id" 'the web server'`)).toEqual([
      'add',
      'web',
      'deploy@h',
      '~/My Keys/id',
      'the web server',
    ])
  })
})
