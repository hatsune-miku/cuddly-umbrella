import { Router } from 'express'

import { config } from '../config'

/** 飞书 /authen/v2/oauth/token 的响应，只声明用得到的字段 */
interface FeishuTokenResponse {
  code?: number
  error?: string
  token_type?: string
  access_token?: string
}

/**
 * 飞书 SSO 回调。
 *
 * 目前只走完 authorization_code → user_info，把用户信息原样返回，
 * 没有建立会话，也没有任何接口据此鉴权。要做公司身份和权限时从这里接上。
 *
 * 成功返回形如：
 * { data: { code: 0, data: { name, open_id, union_id, tenant_key, avatar_url, ... } },
 *   structuredState, authCode, accessToken }
 */
export function createFeishuSsoRouter(): Router {
  const router = Router()

  router.get('/feishu-sso-callback', async (req, res) => {
    const authCode = req.query.code
    const state = req.query.state
    if (!authCode || !state) {
      return res.status(400).send('Bad Request')
    }

    const structuredState = JSON.parse(state as string)

    const tokenResponse = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: config.feishu.appId,
        client_secret: config.feishu.appSecret,
        code: authCode,
        redirect_uri: config.feishu.redirectUri,
      }),
    }).then((r) => r.json() as Promise<FeishuTokenResponse>)

    if (tokenResponse.code !== 0) {
      return res.status(400).send({
        kind: 'oauth/token',
        code: tokenResponse.code,
        error: tokenResponse.error,
      })
    }

    const data = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: {
        Authorization: `${tokenResponse.token_type || 'Bearer'} ${tokenResponse.access_token}`,
      },
    }).then((r) => r.json())

    return res.send({
      data,
      structuredState,
      authCode,
      accessToken: tokenResponse.access_token,
    })
  })

  return router
}
