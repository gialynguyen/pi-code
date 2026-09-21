export interface CommandCodeWindowLimit {
  window: "fiveHour" | "weekly"
  used: number
  cap: number
  resetAt: number | null
}

export interface CommandCodeCredits {
  monthlyCredits: number
  purchasedCredits: number
  freeCredits: number
  remainingCredits: number
  windowLimits: CommandCodeWindowLimit[]
}

export interface CommandCodeSubscription {
  planId: string | null
  status: string | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
}

export interface CommandCodeUsageSummary {
  totalCost: number
  totalCount: number
  totalTokens?: number
}

export type CommandCodeQuotaSection = "credits" | "subscription" | "usage"

export interface CommandCodeQuota {
  account: {
    login: string
    orgId: string | null
    keyName?: string
  }
  credits: CommandCodeCredits | null
  subscription: CommandCodeSubscription | null
  summary: CommandCodeUsageSummary | null
  unavailable?: readonly CommandCodeQuotaSection[]
}

export type CommandCodeQuotaErrorKind = "config" | "http" | "network" | "timeout"

export type CommandCodeQuotaResult =
  | { ok: true; quota: CommandCodeQuota }
  | { ok: false; error: { message: string; kind: CommandCodeQuotaErrorKind } }
