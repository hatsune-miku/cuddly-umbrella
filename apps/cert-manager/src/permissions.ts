import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { isValidCertificateHostname, normalizeCertificateHostname } from './commands'

const DEFAULT_CERTIFICATE_ROOT = '/etc/letsencrypt'
const WORKER_UID_FILE = '.cuddly-nginx-worker-uid'

export interface AclCommand {
  executable: 'setfacl'
  args: string[]
}

export interface CertificateAccessOptions {
  certificateRoot?: string
  workerUidFile?: string
  execute?: (command: AclCommand) => Promise<void>
}

function executeAcl(command: AclCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          signal
            ? `setfacl was terminated by ${signal}`
            : `setfacl exited with code ${code ?? 'unknown'}`
        )
      )
    })
  })
}

export function parseWorkerUid(value: string): number {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) throw new Error('Nginx worker UID is invalid')
  const uid = Number(normalized)
  if (!Number.isSafeInteger(uid) || uid < 0 || uid > 4_294_967_294) {
    throw new Error('Nginx worker UID is outside the supported range')
  }
  return uid
}

export function planCertificateAclCommands(input: {
  certificateRoot: string
  hostname: string
  workerUid: number
}): AclCommand[] {
  const hostname = normalizeCertificateHostname(input.hostname)
  if (!isValidCertificateHostname(hostname)) {
    throw new Error(`Certificate hostname is invalid: ${input.hostname}`)
  }
  const aclUser = `u:${input.workerUid}`
  const liveRoot = path.join(input.certificateRoot, 'live')
  const archiveRoot = path.join(input.certificateRoot, 'archive')
  const liveHost = path.join(liveRoot, hostname)
  const archiveHost = path.join(archiveRoot, hostname)

  return [
    {
      executable: 'setfacl',
      args: ['-m', `${aclUser}:--x`, input.certificateRoot, liveRoot, archiveRoot],
    },
    {
      executable: 'setfacl',
      args: ['-R', '-m', `${aclUser}:rX`, liveHost, archiveHost],
    },
    {
      executable: 'setfacl',
      args: ['-m', `d:${aclUser}:rX`, liveHost, archiveHost],
    },
  ]
}

export async function grantNginxCertificateAccess(
  rawHostname: string,
  options: CertificateAccessOptions = {}
): Promise<void> {
  const hostname = normalizeCertificateHostname(rawHostname)
  if (!isValidCertificateHostname(hostname)) {
    throw new Error(`Certificate hostname is invalid: ${rawHostname}`)
  }
  const certificateRoot = options.certificateRoot || DEFAULT_CERTIFICATE_ROOT
  const workerUidFile = options.workerUidFile || path.join(certificateRoot, WORKER_UID_FILE)
  const workerUid = parseWorkerUid(await readFile(workerUidFile, 'utf8'))
  const liveHost = path.join(certificateRoot, 'live', hostname)
  const archiveHost = path.join(certificateRoot, 'archive', hostname)
  const [liveInfo, archiveInfo] = await Promise.all([stat(liveHost), stat(archiveHost)])
  if (!liveInfo.isDirectory() || !archiveInfo.isDirectory()) {
    throw new Error(`Certbot lineage directories are invalid for ${hostname}`)
  }

  const execute = options.execute || executeAcl
  for (const command of planCertificateAclCommands({
    certificateRoot,
    hostname,
    workerUid,
  })) {
    await execute(command)
  }
}
