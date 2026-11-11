import { fmtUsd, utcMidnightLocal } from '../../components/format'
import { Notice } from '../../components/ui'
import type { fetchAgentDesk } from '../../fns/agents'
import { budgetPercent } from './helpers'

type Desk = Awaited<ReturnType<typeof fetchAgentDesk>>

/**
 * Today's usage against the daily limits (#161). Money is in US dollars. The reset is shown in the
 * display zone and in UTC. The percentage is rounded down, and "used up" comes only from the
 * server's refusal state, never from a rounded number. Setting names are for owners.
 */
export function BudgetMeter({ budget, isOwner }: { budget: Desk['budget']; isOwner: boolean }) {
  const context = budget.context
  const percent = context ? Math.floor(context.utilization * 100) : null
  const used = budgetPercent(budget.inputTokens, budget.dailyInputCap)
  const refusing = budget.refusing
  const tone = refusing === 'tokens' ? 'danger' : used >= 80 ? 'warn' : 'ok'
  const reset = `${utcMidnightLocal()} (midnight UTC)`
  const raise = (setting: string) => (isOwner ? `You can raise it in the deployment settings (${setting}).` : 'Ask an owner if you need it raised.')
  return (
    <section aria-labelledby="budget-title" className="cw-usage">
      <h2 id="budget-title" className="cw-sr-only">
        Usage today
      </h2>
      {refusing === 'unmeasured' && (
        <Notice tone="warn" title={`Agent replies are paused until ${reset}`}>
          A model call today did not report how many tokens it used, so Crosswire cannot check the daily budget and refuses new calls. This is a safety rule. {isOwner ? 'If it keeps happening, check that the model endpoint returns token usage.' : 'If it keeps happening, tell an owner.'}
        </Notice>
      )}
      {refusing === 'tokens' && (
        <Notice tone="error" title="Today's token budget is used up">
          New agent replies are refused until {reset}. {raise('BUDGET_DAILY_INPUT_TOKENS')}
        </Notice>
      )}
      {refusing === 'spend' && (
        <Notice tone="error" title="Today's spend limit is used up">
          New agent replies are refused until {reset}. {raise('BUDGET_MAX_SPEND_MICROS')}
        </Notice>
      )}
      {refusing === 'unpriced' && (
        <Notice tone="warn" title="Agent replies are paused">
          A spend limit is set, but some calls today have no price, so Crosswire cannot check it. {isOwner ? 'Set a token price (BUDGET_USD_PER_MILLION_TOKENS).' : 'Ask an owner to set a token price.'}
        </Notice>
      )}
      {refusing === null && used >= 80 && (
        <Notice tone="warn" title={`${used}% of today's token budget is used`}>
          Agent replies stop when it is used up. It resets at {reset}. {raise('BUDGET_DAILY_INPUT_TOKENS')}
        </Notice>
      )}
      <dl className="cw-ctxbar" aria-label="Usage today">
        <div>
          <dt>Input tokens today</dt>
          <dd className="num">
            {budget.inputTokens.toLocaleString('en-AU')} of {budget.dailyInputCap.toLocaleString('en-AU')}
            <span className="cw-meter" data-tone={tone} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label="Share of the daily token budget used">
              <span style={{ width: `${used}%` }} />
            </span>
            <span className="cw-muted">{used}%</span>
          </dd>
        </div>
        <div>
          <dt>Output tokens</dt>
          <dd className="num">{budget.outputTokens.toLocaleString('en-AU')}</dd>
        </div>
        <div>
          <dt>Last measured call</dt>
          <dd>
            {context && percent !== null ? (
              <>
                {percent}% of the context window. Calls stop at 80%.
                {context.warning ? ' This call was at or over that line.' : ''}
              </>
            ) : (
              'No measured call yet.'
            )}
          </dd>
        </div>
        <div>
          <dt>Spend today</dt>
          <dd>
            {!budget.rateSet
              ? 'Unpriced (no token price is set).'
              : budget.unpriced > 0
                ? 'Some calls have no price, so a spend cap cannot be checked.'
                : budget.spendCapMicros !== null
                  ? `${fmtUsd(budget.costMicros)} of ${fmtUsd(budget.spendCapMicros)}`
                  : fmtUsd(budget.costMicros)}
          </dd>
        </div>
      </dl>
    </section>
  )
}
