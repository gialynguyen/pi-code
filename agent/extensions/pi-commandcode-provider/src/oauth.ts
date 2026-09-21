/**
 * Command Code OAuth provider for pi's /login flow.
 *
 * Implements two API key retrieval flows:
 * 1. Browser-assisted login opens Command Code Studio and waits for the
 *    website to POST the API key back to a local callback server.
 * 2. Direct API key login prompts the user to paste a Studio API key.
 *
 * If browser transfer fails, the user can still paste the API key manually.
 * The API key is stored in pi's auth.json as OAuth credentials.
 *
 * Since Command Code API keys don't expire, we store them as
 * OAuth credentials with a far-future expiry.
 */

import { randomBytes } from "node:crypto"
import { startAuthServer } from "./auth-server.ts"

const STUDIO_BASE_URL = "https://commandcode.ai"
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000 // API keys don't expire
const DEFAULT_AUTH_TIMEOUT_MS = 120_000
const DEFAULT_API_BASE = "https://api.commandcode.ai"

export interface OAuthLoginCallbacks {
  onAuth(params: { url: string }): void
  onPrompt(params: { message: string }): Promise<string>
}

export interface OAuthCredentials {
  refresh: string
  access: string
  expires: number
}

class AuthTimeoutError extends Error {
  constructor() {
    super("Browser authentication timed out")
    this.name = "AuthTimeoutError"
  }
}

function generateStateToken(): string {
  return randomBytes(32).toString("base64url")
}

function getAuthTimeoutMs(): number {
  const raw = process.env.COMMANDCODE_AUTH_TIMEOUT_MS
  if (!raw) return DEFAULT_AUTH_TIMEOUT_MS

  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUTH_TIMEOUT_MS
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AuthTimeoutError()), timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function credentialsFromApiKey(apiKey: string): OAuthCredentials {
  return {
    refresh: apiKey,
    access: apiKey,
    expires: Date.now() + TEN_YEARS_MS,
  }
}

/**
 * Remove common terminal paste wrappers/control chars and surrounding whitespace.
 */
export function sanitizeApiKey(input: string): string {
  const esc = String.fromCharCode(27)
  return Array.from(
    input
      .replaceAll(`${esc}[200~`, "")
      .replaceAll(`${esc}[201~`, "")
      .replaceAll("[200~", "")
      .replaceAll("[201~", ""),
  )
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 31 && code !== 127
    })
    .join("")
    .trim()
}

export async function validateApiKey(
  apiKey: string,
  options: { fetchImpl?: typeof fetch; apiBase?: string } = {},
): Promise<void> {
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(
      `${options.apiBase ?? DEFAULT_API_BASE}/alpha/whoami`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    )
  } catch (error) {
    throw new Error(
      `Could not validate the Command Code API key: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (response.status === 401) throw new Error("Invalid Command Code API key")
  if (!response.ok) {
    throw new Error(`Could not validate the Command Code API key (${response.status})`)
  }
}

async function promptForApiKey(callbacks: OAuthLoginCallbacks, message: string) {
  const apiKey = sanitizeApiKey(await callbacks.onPrompt({ message }))
  if (!apiKey) throw new Error("No Command Code API key provided")
  await validateApiKey(apiKey)
  return credentialsFromApiKey(apiKey)
}

type LoginChoice = { type: "browser" } | { type: "prompt" } | { type: "apiKey"; apiKey: string }

async function chooseLoginFlow(callbacks: OAuthLoginCallbacks): Promise<LoginChoice> {
  const input = sanitizeApiKey(
    await callbacks.onPrompt({
      message:
        "Command Code login: press Enter for browser login, type 'key' to paste an API key, or paste the API key directly:",
    }),
  )
  const normalized = input.toLowerCase()

  if (!input || normalized === "1" || normalized === "b" || normalized === "browser") {
    return { type: "browser" }
  }

  if (
    normalized === "2" ||
    normalized === "k" ||
    normalized === "key" ||
    normalized === "api" ||
    normalized === "paste"
  ) {
    return { type: "prompt" }
  }

  return { type: "apiKey", apiKey: input }
}

async function browserLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const stateToken = generateStateToken()
  let authServer
  try {
    authServer = await startAuthServer({ expectedState: stateToken })
  } catch {
    return promptForApiKey(
      callbacks,
      "Could not start browser auth. Paste your Command Code API key:",
    )
  }

  const callbackUrl = `http://localhost:${authServer.port}/callback`
  const authUrl = `${STUDIO_BASE_URL}/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(stateToken)}`

  // Tell pi to open the browser.
  callbacks.onAuth({ url: authUrl })

  // Wait for the Command Code Studio to POST the API key back. If the browser
  // cannot reach localhost (Command Code shows "Copy your API key"), fall back
  // to pi's prompt so the user can paste the key from the browser.
  let callback: { apiKey: string; state: string }
  try {
    callback = await withTimeout(authServer.waitForCallback, getAuthTimeoutMs())
  } catch (error) {
    authServer.server.close()
    if (error instanceof AuthTimeoutError) {
      return promptForApiKey(
        callbacks,
        "Automatic transfer failed or timed out. Paste your Command Code API key:",
      )
    }
    throw error
  }

  return credentialsFromApiKey(callback.apiKey)
}

/**
 * Starts the login flow for Command Code.
 *
 * Returns OAuth credentials where access == refresh == the user's API key.
 * The keys don't expire, so we set a far-future expiry.
 */
export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const choice = await chooseLoginFlow(callbacks)

  if (choice.type === "apiKey") {
    await validateApiKey(choice.apiKey)
    return credentialsFromApiKey(choice.apiKey)
  }
  if (choice.type === "prompt") {
    return promptForApiKey(callbacks, "Paste your Command Code API key:")
  }

  return browserLogin(callbacks)
}

/**
 * Command Code API keys don't expire, so "refresh" is a no-op.
 * Returns the same credentials with an updated far-future expiry.
 */
export async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return credentialsFromApiKey(credentials.refresh)
}

/**
 * Returns the access token (API key) from OAuth credentials.
 */
export function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access
}
