import { env } from '../env'
import { politeFetch, type PoliteFetchOptions } from './http'
import type { SourceCard } from './compare'

/**
 * Cloudflare Radar connector (Later, #64). Optional and feature-flagged (RADAR_ENABLED=true plus
 * CLOUDFLARE_API_TOKEN with Radar read access). Radar is a TI *feed*, never a host. It has no CVE
 * data, so it enriches IP and domain indicators on the compare view:
 *   GET /client/v4/radar/entities/ip?ip=…          (ASN, network owner, location)
 *   GET /client/v4/radar/ranking/domain/{domain}   (popularity rank/bucket, categories)
 * Responses are cached with the same polite TTL cache as other TI sources.
 */
const BASE = 'https://api.cloudflare.com/client/v4/radar'
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

export function radarEnabled() {
  const e = env()
  return e.RADAR_ENABLED && Boolean(e.CLOUDFLARE_API_TOKEN)
}

export function classifyIndicator(key: string): 'ip' | 'domain' | null {
  const k = key.trim().toLowerCase()
  if (IPV4.test(k)) return 'ip'
  if (DOMAIN.test(k)) return 'domain'
  return null
}

const ATTRIBUTION = 'Source: Cloudflare Radar (radar.cloudflare.com). Check Radar terms before redistributing.'

export async function radarCard(key: string, opts: PoliteFetchOptions = {}): Promise<SourceCard | null> {
  if (!radarEnabled()) return null
  const kind = classifyIndicator(key)
  if (!kind) return null
  const k = key.trim().toLowerCase()
  const url = kind === 'ip' ? `${BASE}/entities/ip?ip=${encodeURIComponent(k)}&format=json` : `${BASE}/ranking/domain/${encodeURIComponent(k)}?format=json`
  try {
    const res = await politeFetch(url, { ...opts, headers: { Authorization: `Bearer ${env().CLOUDFLARE_API_TOKEN}` } })
    const json = JSON.parse(res.body) as { success?: boolean; result?: Record<string, unknown> }
    if (!json.success || !json.result) return { source: 'cloudflare-radar', present: false, attribution: ATTRIBUTION }
    if (kind === 'ip') {
      const ip = json.result.ip as { asn?: string; asnName?: string; asnOrgName?: string; locationName?: string } | undefined
      return {
        source: 'cloudflare-radar',
        present: Boolean(ip),
        title: ip ? `AS${ip.asn} ${ip.asnOrgName ?? ip.asnName ?? ''}`.trim() : null,
        vendor: ip?.asnName ?? null,
        summary: ip?.locationName ? `Located in ${ip.locationName}.` : null,
        url: `https://radar.cloudflare.com/ip/${k}`,
        attribution: ATTRIBUTION,
      }
    }
    const d = json.result.details_0 as { rank?: number; bucket?: string; categories?: Array<{ name: string }> } | undefined
    return {
      source: 'cloudflare-radar',
      present: Boolean(d),
      title: d ? (d.rank ? `Rank #${d.rank}` : d.bucket ? `Top ${d.bucket}` : 'Unranked') : null,
      summary: d?.categories?.length ? `Categories: ${d.categories.map((c) => c.name).join(', ')}` : null,
      url: `https://radar.cloudflare.com/domains/domain/${k}`,
      attribution: ATTRIBUTION,
    }
  } catch {
    // Radar failures never break the compare view.
    return { source: 'cloudflare-radar', present: false, summary: 'Radar lookup failed.', attribution: ATTRIBUTION }
  }
}
