import type {
  CommandCodeCredits,
  CommandCodeQuota,
  CommandCodeSubscription,
  CommandCodeWindowLimit,
} from "./quota-types.ts"

export function formatWindowLimits(
  limits: readonly CommandCodeWindowLimit[],
  now: () => number = Date.now,
): string[] {
  const labels: Record<CommandCodeWindowLimit["window"], string> = {
    fiveHour: "5-hour",
    weekly: "Weekly",
  }

  return limits.map((limit) => {
    const used = limit.used.toFixed(2)
    const cap = limit.cap.toFixed(2)
    const percent = limit.cap > 0 ? Math.round((limit.used / limit.cap) * 100) : 0
    const reset = limit.resetAt === null ? "" : ` (resets ${formatResetClock(limit.resetAt, now)})`
    return `${labels[limit.window]}: ${used} / ${cap} credits (${percent}% used)${reset}`
  })
}

function formatResetClock(resetAtSeconds: number, now: () => number): string {
  const date = new Date(resetAtSeconds * 1000)
  if (Number.isNaN(date.getTime())) return "unknown"
  const diffMs = date.getTime() - now()
  if (diffMs <= 0) return "soon"
  const minutes = Math.ceil(diffMs / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    return remainingMinutes > 0 ? `in ${hours}h ${remainingMinutes}m` : `in ${hours}h`
  }
  const days = Math.floor(hours / 24)
  return days === 1 ? "in 1 day" : `in ${days} days`
}

function creditsDetail(credits: CommandCodeCredits | null): string | undefined {
  if (!credits) return undefined
  const parts = [
    `monthly $${credits.monthlyCredits.toFixed(2)}`,
    `purchased $${credits.purchasedCredits.toFixed(2)}`,
  ]
  if (credits.freeCredits > 0) parts.push(`free $${credits.freeCredits.toFixed(2)}`)
  return `Sources: ${parts.join(" / ")}`
}

function parsePeriodEnd(value: string): Date | null {
  const trimmed = value.trim()
  const timestamp = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed)
  if (!Number.isFinite(timestamp) || timestamp < 0) return null
  const milliseconds = timestamp >= 1e12 ? timestamp : timestamp * 1000
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? null : date
}

function subscriptionLine(
  subscription: CommandCodeSubscription,
  now: () => number = Date.now,
): string {
  const plan = (subscription.planId ?? "Unknown").replace(/[_-]+/g, " ").trim()
  const status = subscription.status ? ` (${subscription.status})` : ""
  let renewal = ""
  if (subscription.currentPeriodEnd) {
    const end = parsePeriodEnd(subscription.currentPeriodEnd)
    if (end) {
      const diffMs = end.getTime() - now()
      const days = Math.ceil(diffMs / 86_400_000)
      const dateStr = end.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
      if (days > 0) {
        renewal = ` · renews ${dateStr} (${days}d)`
      } else if (days === 0) {
        renewal = ` · renews ${dateStr} (today)`
      } else {
        renewal = ` · renewed ${dateStr}`
      }
    }
  }
  return `Plan: ${plan}${status}${renewal}`
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

export function formatQuota(quota: CommandCodeQuota, now: () => number = Date.now): string {
  const lines: string[] = []
  const remaining = quota.credits?.remainingCredits ?? 0
  const spent = quota.summary?.totalCost ?? 0
  const pool = remaining + spent

  if (quota.credits || quota.summary) {
    lines.push("Credits")
    lines.push(`  Remaining: $${remaining.toFixed(2)} of $${pool.toFixed(2)}`)
    lines.push(`  Used: $${spent.toFixed(2)}`)
    lines.push(`  ${pool > 0 ? Math.round((spent / pool) * 100) : 0}% used`)
  }

  const detail = creditsDetail(quota.credits)
  if (detail) lines.push(detail)
  if (quota.subscription) lines.push(subscriptionLine(quota.subscription, now))

  if (quota.summary) {
    lines.push("")
    lines.push(quota.subscription?.currentPeriodStart ? "Usage (billing period)" : "Usage")
    lines.push(`  Cost: $${quota.summary.totalCost.toFixed(2)}`)
    lines.push(`  Requests: ${quota.summary.totalCount.toLocaleString("en-US")}`)
    if (quota.summary.totalTokens !== undefined) {
      lines.push(`  Tokens: ${formatTokens(quota.summary.totalTokens)}`)
    }
  }

  lines.push("")
  lines.push("Account")
  lines.push(`  ${quota.account.keyName ?? quota.account.login}`)

  const limits = quota.credits?.windowLimits ?? []
  if (limits.length > 0) {
    lines.push("")
    lines.push("Usage windows:")
    lines.push(...formatWindowLimits(limits, now).map((line) => `  ${line}`))
  }

  if ((quota.unavailable?.length ?? 0) > 0) {
    lines.push("")
    lines.push(`Unavailable: ${quota.unavailable?.join(", ")}`)
  }

  lines.push("")
  lines.push("Full detail: https://commandcode.ai/usage")
  return lines.join("\n")
}
