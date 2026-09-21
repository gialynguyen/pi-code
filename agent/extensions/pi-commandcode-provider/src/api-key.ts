import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function defaultAuthPaths(home: string): string[] {
  return [
    join(home, ".commandcode", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".omp", "agent", "auth.json"),
  ]
}

function apiKeyFromCredential(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined

  if (stringValue(value.type) === "oauth") return stringValue(value.access)
  if (stringValue(value.type) === "api") return stringValue(value.key)
  return stringValue(value.access) ?? stringValue(value.key)
}

export function getConfiguredApiKey(
  options: {
    env?: NodeJS.ProcessEnv
    authPaths?: readonly string[]
    homeDir?: () => string
  } = {},
): string | undefined {
  const env = options.env ?? process.env
  if (env.COMMAND_CODE_API_KEY) return env.COMMAND_CODE_API_KEY
  if (env.COMMANDCODE_API_KEY) return env.COMMANDCODE_API_KEY

  const home = options.homeDir?.() ?? homedir()
  const authPaths = options.authPaths ?? defaultAuthPaths(home)

  for (const authPath of authPaths) {
    try {
      if (!existsSync(authPath)) continue
      const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"))
      if (!isRecord(parsed)) continue

      const apiKey = stringValue(parsed.apiKey)
      if (apiKey) return apiKey

      const commandcode = stringValue(parsed.commandcode)
      if (commandcode) return commandcode

      const providerKey = apiKeyFromCredential(parsed.commandcode)
      if (providerKey) return providerKey

      const commandCode = stringValue(parsed["command-code"])
      if (commandCode) return commandCode

      const commandCodeKey = apiKeyFromCredential(parsed["command-code"])
      if (commandCodeKey) return commandCodeKey
    } catch {
      // Ignore malformed or unreadable auth files.
    }
  }

  return undefined
}
