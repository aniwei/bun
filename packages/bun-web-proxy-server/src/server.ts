export interface ProxyServerOptions {
  tunnelURL?: string
}

export class ProxyServer {
  constructor(readonly tunnelURL: string) {}

  buildTunnelURL(target: string, protocol = 'tcp'): string {
    const url = new URL(this.tunnelURL)
    url.searchParams.set('target', target)
    url.searchParams.set('protocol', protocol)
    return url.toString()
  }
}

function createNotSupportedError(message: string): Error {
  const error = new Error(message)
  error.name = 'NotSupportedError'
  return error
}

export function createProxyServer(options: ProxyServerOptions): ProxyServer {
  if (!options.tunnelURL) {
    throw createNotSupportedError('Proxy tunnel URL is required in M4')
  }

  return new ProxyServer(options.tunnelURL)
}
