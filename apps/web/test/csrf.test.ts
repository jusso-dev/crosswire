import { describe, expect, it } from 'vitest'
import { csrfMiddleware, startInstance } from '../src/start'

/**
 * CSRF on server functions (#199). Calls the configured request middleware the way TanStack Start
 * does for a /_serverFn request, and checks that it is actually registered on the start instance.
 */
type ServerOpts = { request: Request; handlerType: 'serverFn' | 'router'; next: () => Promise<unknown> }
const run = (csrfMiddleware as unknown as { options: { server: (o: ServerOpts) => Promise<unknown> } }).options.server

const URL_FN = 'http://localhost:3000/_serverFn/abc123'
const PASSED = { passed: true }

async function call(headers: Record<string, string>, handlerType: 'serverFn' | 'router' = 'serverFn') {
  const request = new Request(URL_FN, { method: 'POST', headers: { 'content-type': 'text/plain', ...headers }, body: 'x' })
  const r = await run({ request, handlerType, next: async () => PASSED })
  return r === PASSED ? 'passed' : r instanceof Response ? r.status : r
}

describe('server function CSRF (#199)', () => {
  it('is registered on the start instance', async () => {
    const opts = await startInstance.getOptions()
    expect(opts.requestMiddleware).toContain(csrfMiddleware)
  })

  it('refuses a cross-site POST', async () => {
    expect(await call({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })).toBe(403)
    expect(await call({ 'sec-fetch-site': 'same-site', origin: 'https://other-app.azurecontainerapps.io' })).toBe(403)
  })

  it('refuses a foreign Origin, a foreign Referer, and a request with neither', async () => {
    expect(await call({ origin: 'https://evil.example' })).toBe(403)
    expect(await call({ referer: 'https://evil.example/page' })).toBe(403)
    expect(await call({})).toBe(403)
  })

  it('lets same-origin calls through', async () => {
    expect(await call({ 'sec-fetch-site': 'same-origin' })).toBe('passed')
    expect(await call({ origin: 'http://localhost:3000' })).toBe('passed')
    expect(await call({ referer: 'http://localhost:3000/app/settings' })).toBe('passed')
  })

  it('does not check page (router) requests', async () => {
    expect(await call({ 'sec-fetch-site': 'cross-site' }, 'router')).toBe('passed')
  })
})
