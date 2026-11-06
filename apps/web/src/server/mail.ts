import nodemailer from 'nodemailer'
import { env } from './env'
import { logger } from './lib/logger'

export function smtpConfigured() {
  return Boolean(env().SMTP_HOST)
}

/** Send mail via SMTP when configured. Returns false (and logs) when SMTP is not set up. */
export async function sendMail(to: string[], subject: string, text: string): Promise<boolean> {
  if (!smtpConfigured() || to.length === 0) {
    logger.info('mail skipped: SMTP not configured or no recipients', { recipients: to.length })
    return false
  }
  const e = env()
  const transport = nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_PORT === 465,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD } : undefined,
  })
  await transport.sendMail({ from: e.SMTP_FROM, to, subject, text })
  return true
}
