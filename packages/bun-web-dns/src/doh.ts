export type DNSRecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT'

export interface DNSAnswer {
  name: string
  type: number
  TTL: number
  data: string
}

export interface DoHResponse {
  Status: number
  Answer?: DNSAnswer[]
}

export interface ResolveDoHOptions {
  endpoint?: string
  fetchFn?: (input: string | URL, init?: RequestInit) => Promise<Response>
}

const DEFAULT_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'

export async function resolveDoH(
  hostname: string,
  type: DNSRecordType = 'A',
  options: ResolveDoHOptions = {},
): Promise<DoHResponse> {
  const endpoint = options.endpoint ?? DEFAULT_DOH_ENDPOINT
  const fetchFn = options.fetchFn ?? fetch

  const url = new URL(endpoint)
  url.searchParams.set('name', hostname)
  url.searchParams.set('type', type)

  const response = await fetchFn(url, {
    headers: {
      accept: 'application/dns-json',
    },
  })

  if (!response.ok) {
    throw new Error(`DoH request failed with status ${response.status}`)
  }

  return (await response.json()) as DoHResponse
}

export async function lookup(
  hostname: string,
  options: ResolveDoHOptions = {},
): Promise<string> {
  const result = await resolveDoH(hostname, 'A', options)
  const answer = result.Answer?.find(item => typeof item.data === 'string')
  if (!answer) {
    throw new Error(`No A record found for ${hostname}`)
  }
  return answer.data
}
