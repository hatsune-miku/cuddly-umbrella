// process / fetch 等全局由 @types/bun 提供，这里只放本项目自己的类型扩充。
export {}

declare module 'http' {
  interface IncomingMessage {
    /** 代理请求的开始时间，用于耗时统计 */
    startTime?: number
  }
}
