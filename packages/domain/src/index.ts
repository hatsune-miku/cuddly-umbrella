import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

export * from './secure-settings'
export * from './secret-file'

const execFileAsync = promisify(execFile)
const gitSshIdentityPath = '/srv/cuddly/secrets/git_id_ed25519'
const gitSshKnownHostsPath = '/srv/cuddly/secrets/git_known_hosts'

function socks5ProxyAddress(env: NodeJS.ProcessEnv): string | null {
  const value = env.ALL_PROXY || env.all_proxy
  if (!value) return null
  try {
    const proxy = new URL(value)
    if (!['socks5:', 'socks5h:'].includes(proxy.protocol)) return null
    if (proxy.username || proxy.password || !/^[a-z0-9.-]+$/i.test(proxy.hostname)) return null
    const port = proxy.port || '1080'
    if (!/^\d{1,5}$/.test(port) || Number(port) > 65_535) return null
    return `${proxy.hostname}:${port}`
  } catch {
    return null
  }
}

export function gitSshCommand(
  env: NodeJS.ProcessEnv = process.env,
  identityAvailable = existsSync(gitSshIdentityPath)
): string {
  const options = [
    'ssh',
    '-o BatchMode=yes',
    '-o ConnectTimeout=7',
    '-o ConnectionAttempts=1',
    '-o StrictHostKeyChecking=accept-new',
    `-o UserKnownHostsFile=${gitSshKnownHostsPath}`,
  ]
  if (identityAvailable) {
    options.push(`-i ${gitSshIdentityPath}`, '-o IdentitiesOnly=yes')
  }
  const proxy = socks5ProxyAddress(env)
  if (proxy) options.push(`-o 'ProxyCommand=nc -X 5 -x ${proxy} %h %p'`)
  return options.join(' ')
}

export async function listRemoteBranches(
  repositoryUrl: string,
  authorizationHeader?: string
): Promise<string[]> {
  const authEnv = authorizationHeader
    ? {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: authorizationHeader,
      }
    : {}
  const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', repositoryUrl], {
    timeout: 12_000,
    windowsHide: true,
    env: {
      ...process.env,
      ...authEnv,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: gitSshCommand(),
    },
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((ref): ref is string => Boolean(ref?.startsWith('refs/heads/')))
    .map((ref) => ref.slice('refs/heads/'.length))
    .sort((a, b) => a.localeCompare(b))
}
