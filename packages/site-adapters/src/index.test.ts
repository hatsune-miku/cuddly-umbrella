import type { ArtifactManifest } from '@cuddly/contracts'
import { describe, expect, it } from 'vitest'

import { isBackendProxyRequest, resolveArtifactFile } from './index'

function manifest(input: { target: string; publicBase: string }): ArtifactManifest {
  return {
    schemaVersion: 1,
    artifactId: '00000000-0000-4000-8000-000000000001',
    target: input.target,
    branch: 'master',
    builtAt: '2026-08-24T00:00:00.000Z',
    serve: {
      siteAdapter: 'generic-static-v1',
      entrypoints: ['index.htm'],
      publicBase: input.publicBase,
    },
    files: [
      {
        path: 'index.htm',
        size: 1,
        contentType: 'text/html; charset=utf-8',
        digest: 'sha256:index',
        cacheClass: 'html',
      },
      {
        path: 'assets/app.js',
        size: 1,
        contentType: 'text/javascript; charset=utf-8',
        digest: 'sha256:asset',
        cacheClass: 'immutable',
      },
    ],
  }
}

describe('resolveArtifactFile', () => {
  it('maps /app assets for a custom webapp project using an /app/ public base', () => {
    expect(
      resolveArtifactFile(
        '/app/assets/app.js',
        manifest({
          target: 'customer-web',
          publicBase: '/__cuddly/artifacts/00000000-0000-4000-8000-000000000001/app/',
        })
      )
    ).toBe('assets/app.js')
  })

  it('does not add an /app alias to an ordinary generic static site', () => {
    expect(
      resolveArtifactFile(
        '/app/assets/app.js',
        manifest({
          target: 'biz',
          publicBase: '/__cuddly/artifacts/00000000-0000-4000-8000-000000000001/',
        })
      )
    ).toBeNull()
  })
})

describe('isBackendProxyRequest', () => {
  const request = (method: string, requestPath: string) =>
    ({ method, path: requestPath }) as Parameters<typeof isBackendProxyRequest>[0]

  it.each(['/api', '/api/v3/version/hot-module', '/v3/version/hot-module', '/mis', '/mis/health'])(
    'routes GET %s to the environment backend',
    (requestPath) => {
      expect(isBackendProxyRequest(request('GET', requestPath))).toBe(true)
      expect(isBackendProxyRequest(request('HEAD', requestPath))).toBe(true)
    }
  )

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('routes %s requests to the backend', (method) => {
    expect(isBackendProxyRequest(request(method, '/channels/1'))).toBe(true)
  })

  it('keeps read-only non API paths on the frontend route', () => {
    expect(isBackendProxyRequest(request('GET', '/channels/1'))).toBe(false)
    expect(isBackendProxyRequest(request('HEAD', '/assets/app.js'))).toBe(false)
  })
})
