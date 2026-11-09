/**
 * Plain-English wording for errors the analyst sees. The server keeps its precise reasons for logs,
 * run rows and tests. This only changes what the screen says. Unknown messages pass through.
 */
const RULES: Array<[RegExp, string | ((m: RegExpMatchArray) => string)]> = [
  [/Daily input token budget is exhausted/i, "Today's token budget is used up. It resets at midnight UTC. An owner can raise the daily limit in the deployment settings (BUDGET_DAILY_INPUT_TOKENS)."],
  [/Daily spend budget is exhausted/i, "Today's spend limit is used up. It resets at midnight UTC. An owner can raise it in the deployment settings (BUDGET_MAX_SPEND_MICROS)."],
  [/no token count/i, 'A model call today did not report how many tokens it used, so Crosswire cannot check the daily budget. New agent replies are paused until midnight UTC. An owner can check usage on the Agents page.'],
  [/unpriced calls/i, 'A spend limit is set, but some calls today have no price, so Crosswire cannot check it. New agent replies are paused. An owner needs to set a token price (BUDGET_USD_PER_MILLION_TOKENS).'],
  [/Spend cap is set but BUDGET_USD_PER_MILLION_TOKENS is not/i, 'A spend limit is set without a token price, so Crosswire refuses every model call. An owner needs to set BUDGET_USD_PER_MILLION_TOKENS.'],
  [/Context utilization ([\d.]+)/i, (m) => `This conversation is too long for the model. It would fill ${Math.round(Number(m[1]) * 100)}% of the context window, and the limit is 80%. Start a new conversation, or ask a shorter question.`],
  [/exceeds BUDGET_MAX_INPUT_TOKENS/i, 'This message and the conversation before it are too long for one model call. Start a new conversation, or paste less text.'],
  [/shared inflight limit/i, 'Too many agent replies are running for your organisation right now. Wait for one to finish, then try again.'],
  [/Run slot could not be claimed|Capacity check failed closed/i, 'Crosswire could not reserve a slot for this reply. Try again in a moment.'],
  [/Agent timed out after (\d+)s/i, (m) => `The agent took longer than ${m[1]} seconds and was stopped. Try a narrower question.`],
  [/Output stopped at the configured budget/i, 'The reply reached the length limit and was cut short. Ask for the rest, or narrow the question.'],
  [/Run recovery failed closed/i, 'Crosswire could not check earlier runs before starting, so it did not start this one. Try again. If it keeps happening, ask an owner to check the database.'],
  [/Failed to fetch|NetworkError|network error|Load failed/i, 'Crosswire could not reach the server. Check your connection, then try again.'],
  [/You requested this proposal, so you cannot approve it/i, 'You asked for this action, so another approver must decide it. This keeps two people on every change.'],
  [/not bound to the current content hash|no longer matches the stored hash/i, 'This action changed after it was proposed, so the approval no longer applies. Ask for a new action.'],
  [/You cannot promote your own memory/i, 'You wrote this note, so a different approver must promote it.'],
  [/Injection text cannot be promoted/i, 'This note reads like an instruction to the agent, so it cannot be promoted. Replace it with a plain fact.'],
]

export function plainMessage(raw: unknown): string {
  const message = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : String(raw ?? '')
  for (const [re, out] of RULES) {
    const m = message.match(re)
    if (m) return typeof out === 'string' ? out : out(m)
  }
  return message || 'Something unexpected happened. Try again.'
}

/** True when the message is a budget or capacity refusal (a limit, not a fault). */
export function isBudgetRefusal(raw: unknown) {
  const message = raw instanceof Error ? raw.message : String(raw ?? '')
  return /budget|spend|token count|unpriced|Context utilization|BUDGET_|inflight limit/i.test(message)
}
