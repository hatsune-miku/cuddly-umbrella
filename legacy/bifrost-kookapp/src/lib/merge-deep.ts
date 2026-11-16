function isPlainObject(item: any): boolean {
  return !!item && typeof item === 'object' && !Array.isArray(item)
}

/** 就地深合并。数组按整体替换处理，不做逐项合并 */
export function mergeDeep<T>(target: T, ...sources: any[]): T {
  if (!sources.length) {
    return target
  }
  const source = sources.shift()

  if (isPlainObject(target) && isPlainObject(source)) {
    for (const key in source) {
      if (isPlainObject(source[key])) {
        if (!target[key]) {
          Object.assign(target, { [key]: {} })
        }
        mergeDeep(target[key], source[key])
      } else {
        Object.assign(target, { [key]: source[key] })
      }
    }
  }

  return mergeDeep(target, ...sources)
}
