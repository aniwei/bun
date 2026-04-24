export type PortResolver = {
  resolvePort(port: number): number | null
}

export type DispatchToKernel = (pid: number, request: Request) => Promise<Response>

const BUN_LOCAL_SUFFIX = '.bun.local'

function parsePortSegment(pathname: string): number | null {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length < 2 || parts[0] !== '__bun__') {
    return null
  }

  const port = Number(parts[1])
  if (!Number.isInteger(port) || port <= 0) {
    return null
  }

  return port
}

export function resolveVirtualPid(url: URL, resolver?: PortResolver): number | null {
  if (url.hostname.endsWith(BUN_LOCAL_SUFFIX)) {
    const firstLabel = url.hostname.slice(0, -BUN_LOCAL_SUFFIX.length)
    const pid = Number(firstLabel)
    if (Number.isInteger(pid) && pid > 0) {
      return pid
    }
  }

  const port = parsePortSegment(url.pathname)
  if (port === null) {
    return null
  }

  if (!resolver) {
    return null
  }

  return resolver.resolvePort(port)
}

export function isVirtualBunRequest(url: URL): boolean {
  return url.hostname.endsWith(BUN_LOCAL_SUFFIX) || parsePortSegment(url.pathname) !== null
}

export async function dispatchVirtualRequest(
  request: Request,
  resolver: PortResolver,
  dispatchToKernel: DispatchToKernel,
): Promise<Response> {
  const pid = resolveVirtualPid(new URL(request.url), resolver)
  if (pid === null) {
    return new Response('Virtual route not found', { status: 404 })
  }

  return dispatchToKernel(pid, request)
}

export function createFetchRouter(
  resolver: PortResolver,
  dispatchToKernel: DispatchToKernel,
): (request: Request) => Promise<Response | null> {
  return async request => {
    const url = new URL(request.url)
    if (!isVirtualBunRequest(url)) {
      return null
    }

    return dispatchVirtualRequest(request, resolver, dispatchToKernel)
  }
}
