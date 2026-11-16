import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  grantNginxCertificateAccess,
  parseWorkerUid,
  planCertificateAclCommands,
  type AclCommand,
} from './permissions'

const cleanupDirectories: string[] = []

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('Nginx certificate ACLs', () => {
  it('limits recursive and default ACLs to the requested lineage', () => {
    const certificateRoot = path.join(path.parse(process.cwd()).root, 'etc', 'letsencrypt')
    const liveRoot = path.join(certificateRoot, 'live')
    const archiveRoot = path.join(certificateRoot, 'archive')
    const liveHost = path.join(liveRoot, 'main.bifrost.vanillacake.cn')
    const archiveHost = path.join(archiveRoot, 'main.bifrost.vanillacake.cn')
    expect(
      planCertificateAclCommands({
        certificateRoot,
        hostname: 'Main.Bifrost.VanillaCake.cn.',
        workerUid: 33,
      })
    ).toEqual([
      {
        executable: 'setfacl',
        args: ['-m', 'u:33:--x', certificateRoot, liveRoot, archiveRoot],
      },
      {
        executable: 'setfacl',
        args: ['-R', '-m', 'u:33:rX', liveHost, archiveHost],
      },
      {
        executable: 'setfacl',
        args: ['-m', 'd:u:33:rX', liveHost, archiveHost],
      },
    ])
  })

  it('reads the persisted UID and executes ACL commands only after the lineage exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-certificates-'))
    cleanupDirectories.push(root)
    const hostname = 'main.bifrost.vanillacake.cn'
    await Promise.all([
      mkdir(path.join(root, 'live', hostname), { recursive: true }),
      mkdir(path.join(root, 'archive', hostname), { recursive: true }),
      writeFile(path.join(root, '.cuddly-nginx-worker-uid'), '33\n'),
    ])
    const commands: AclCommand[] = []

    await grantNginxCertificateAccess(hostname, {
      certificateRoot: root,
      execute: async (command) => {
        commands.push(command)
      },
    })

    expect(commands).toHaveLength(3)
    expect(commands.every((command) => command.args.some((arg) => arg.includes('33')))).toBe(true)
  })

  it('rejects missing or malformed worker metadata before invoking setfacl', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cuddly-certificates-'))
    cleanupDirectories.push(root)
    const execute = vi.fn<(command: AclCommand) => Promise<void>>()

    await expect(
      grantNginxCertificateAccess('main.bifrost.vanillacake.cn', {
        certificateRoot: root,
        execute,
      })
    ).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
    expect(() => parseWorkerUid('www-data')).toThrow('UID is invalid')
  })
})
