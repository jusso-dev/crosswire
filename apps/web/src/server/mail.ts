import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { env, type Env } from './env'
import { logger } from './lib/logger'

export function smtpConfigured() {
  return Boolean(env().SMTP_HOST)
}

/**
 * SMTP transport settings (#197, #210).
 * - Port 465 uses implicit TLS. Any other port must upgrade with STARTTLS (`requireTLS`), so a
 *   server that does not offer it, or a stripped offer, fails the send instead of going plain text.
 *   `SMTP_ALLOW_PLAINTEXT=true` is the only way to allow plain text (a lab relay).
 * - Short timeouts, so a stalled server cannot hold the worker for nodemailer's defaults
 *   (2 minutes to connect, 30 seconds for the greeting, 10 minutes of socket idle).
 */
export function smtpTransportOptions(e: Pick<Env, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASSWORD' | 'SMTP_ALLOW_PLAINTEXT'>): SMTPTransport.Options {
  const secure = e.SMTP_PORT === 465
  return {
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure,
    requireTLS: !secure && !e.SMTP_ALLOW_PLAINTEXT,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD } : undefined,
  }
}

/** Send mail via SMTP when configured. Returns false (and logs) when SMTP is not set up. */
export async function sendMail(to: string[], subject: string, text: string): Promise<boolean> {
  if (!smtpConfigured() || to.length === 0) {
    logger.info('mail skipped: SMTP not configured or no recipients', { recipients: to.length })
    return false
  }
  const e = env()
  const transport = nodemailer.createTransport(smtpTransportOptions(e))
  try {
    await transport.sendMail({ from: e.SMTP_FROM, to, subject, text })
  } finally {
    transport.close()
  }
  return true
}
