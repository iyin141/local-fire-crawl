export interface PlaywrightProxy {
  server: string
  username?: string
  password?: string
}

const decodeCredential = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export const toPlaywrightProxy = (proxyUrl: string): PlaywrightProxy => {
  const url = new URL(proxyUrl)
  const username = url.username ? decodeCredential(url.username) : undefined
  const password = url.password ? decodeCredential(url.password) : undefined
  return {
    server: `${url.protocol}//${url.host}`,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  }
}
