import express, { Router } from 'express'

import { config } from '../config'
import { ASSET_HOST_MAP } from '../sites/asset-map'
import { getMisData, setMisData } from '../store/mis-data'

/**
 * 管理端读写配置的接口。
 *
 * 目前完全没有鉴权：任何人都能读写这份配置，而这个服务同时握着真实登录态的
 * Cookie 改写链路。接飞书会话后应当在这里加校验。
 */
export function createMisOperationRouter(): Router {
  const router = Router()

  router.get('/mis-operation', (_req, res) => {
    res.send(getMisData())
  })

  router.post('/mis-operation', express.json(), express.urlencoded({ extended: true }), (req, res) => {
    setMisData(req.body || {})
    res.send('OK')
  })

  router.use('/mis', (_req, res) => {
    res.redirect(config.misOrigin)
  })

  // 供页面侧 k-inject.js 拉取 CDN 镜像映射，替代它现在硬编码的那份副本
  router.get('/__bifrost/asset-map', (_req, res) => {
    res.json(ASSET_HOST_MAP)
  })

  return router
}
