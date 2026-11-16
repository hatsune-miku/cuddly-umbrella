import { describe, expect, it } from 'vitest'

import { gitSshCommand } from './index'

describe('Git SSH transport', () => {
  it('routes SSH through the configured SOCKS5 proxy and uses the mounted identity', () => {
    const command = gitSshCommand({ ALL_PROXY: 'socks5h://mihomo:7890' }, true)
    expect(command).toContain('-i /srv/cuddly/secrets/git_id_ed25519')
    expect(command).toContain('ProxyCommand=nc -X 5 -x mihomo:7890 %h %p')
    expect(command).toContain('StrictHostKeyChecking=accept-new')
  })

  it('keeps a direct SSH fallback when no compatible proxy is configured', () => {
    const command = gitSshCommand({ ALL_PROXY: 'http://proxy.example.test:8080' }, false)
    expect(command).not.toContain('ProxyCommand')
    expect(command).not.toContain('IdentityFile')
    expect(command).toContain('BatchMode=yes')
  })
})
