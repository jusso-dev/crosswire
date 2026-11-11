import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { parseEnv, resetEnvForTests, startupWarnings } from '../src/server/env'
import { sendMail, smtpTransportOptions } from '../src/server/mail'

/**
 * A minimal SMTP server on 127.0.0.1 that never offers STARTTLS, standing in for a relay that has
 * no TLS or a connection where the STARTTLS offer was stripped (#210). Records whether a message
 * body was received.
 */
async function plainSmtpServer() {
  const received: string[] = []
  const server: Server = createServer((socket) => {
    let inData = false
    let buf = ''
    socket.write('220 test ESMTP\r\n')
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      for (let i = buf.indexOf('\r\n'); i !== -1; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            socket.write('250 queued\r\n')
          } else received.push(line)
          continue
        }
        const cmd = line.slice(0, 4).toUpperCase()
        if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250 test\r\n')
        else if (line.toUpperCase() === 'STARTTLS') socket.write('502 not supported\r\n')
        else if (cmd === 'DATA') {
          inData = true
          socket.write('354 go ahead\r\n')
        } else if (cmd === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('250 ok\r\n')
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as AddressInfo).port, received, close: () => new Promise<void>((r) => server.close(() => r())) }
}

const SAVED = { ...process.env }
afterEach(() => {
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_ALLOW_PLAINTEXT']) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
  resetEnvForTests()
})

describe('SMTP never falls back to plain text without an opt-in (#210)', () => {
  it('requires STARTTLS on every port but 465, unless SMTP_ALLOW_PLAINTEXT is set', () => {
    expect(smtpTransportOptions(parseEnv({ SMTP_HOST: 'mx', SMTP_PORT: '587' }))).toMatchObject({ secure: false, requireTLS: true })
    expect(smtpTransportOptions(parseEnv({ SMTP_HOST: 'mx', SMTP_PORT: '25' }))).toMatchObject({ secure: false, requireTLS: true })
    expect(smtpTransportOptions(parseEnv({ SMTP_HOST: 'mx', SMTP_PORT: '465' }))).toMatchObject({ secure: true, requireTLS: false })
    expect(smtpTransportOptions(parseEnv({ SMTP_HOST: 'mx', SMTP_PORT: '587', SMTP_ALLOW_PLAINTEXT: 'true' }))).toMatchObject({ secure: false, requireTLS: false })
    expect(parseEnv({}).SMTP_ALLOW_PLAINTEXT).toBe(false)
  })

  it('sets short timeouts so a stalled server cannot hold the worker (#197)', () => {
    const o = smtpTransportOptions(parseEnv({ SMTP_HOST: 'mx' }))
    for (const k of ['connectionTimeout', 'greetingTimeout', 'socketTimeout'] as const) {
      expect(o[k]).toBeGreaterThan(0)
      expect(o[k]).toBeLessThanOrEqual(60_000)
    }
  })

  it('a server without STARTTLS fails the send and receives no message', async () => {
    const smtp = await plainSmtpServer()
    try {
      process.env.SMTP_HOST = '127.0.0.1'
      process.env.SMTP_PORT = String(smtp.port)
      delete process.env.SMTP_ALLOW_PLAINTEXT
      resetEnvForTests()
      await expect(sendMail(['owner@example.test'], 'Digest', 'secret body')).rejects.toThrow()
      expect(smtp.received.join('\n')).not.toContain('secret body')
    } finally {
      await smtp.close()
    }
  })

  it('with SMTP_ALLOW_PLAINTEXT=true the same server receives the message', async () => {
    const smtp = await plainSmtpServer()
    try {
      process.env.SMTP_HOST = '127.0.0.1'
      process.env.SMTP_PORT = String(smtp.port)
      process.env.SMTP_ALLOW_PLAINTEXT = 'true'
      resetEnvForTests()
      await expect(sendMail(['owner@example.test'], 'Digest', 'lab body')).resolves.toBe(true)
      expect(smtp.received.join('\n')).toContain('lab body')
    } finally {
      await smtp.close()
    }
  })

  it('warns at start-up in production when plain text is allowed', () => {
    const prod = { NODE_ENV: 'production', APP_URL: 'https://cw.example.com', DATABASE_URL: 'postgres://u:p@db/cw?sslmode=verify-full', BETTER_AUTH_SECRET: 'x'.repeat(40), APP_ENCRYPTION_KEY: 'a'.repeat(64), SMTP_HOST: 'relay' }
    expect(startupWarnings(parseEnv(prod))).toEqual([])
    expect(startupWarnings(parseEnv({ ...prod, SMTP_ALLOW_PLAINTEXT: 'true' }))).toEqual([expect.stringMatching(/SMTP_ALLOW_PLAINTEXT/)])
  })
})
