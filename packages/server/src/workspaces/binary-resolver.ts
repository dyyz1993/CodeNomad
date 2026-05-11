import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "path"
import type { Logger } from "../logger"

const execFileAsync = promisify(execFile)

export async function resolveBinaryPath(identifier: string, logger: Logger): Promise<string> {
  if (!identifier) {
    return identifier
  }

  const looksLikePath = identifier.includes("/") || identifier.includes("\\") || identifier.startsWith(".")
  if (path.isAbsolute(identifier) || looksLikePath) {
    return identifier
  }

  const locator = process.platform === "win32" ? "where" : "which"

  try {
    let stdout: string
    let stderr: string
    try {
      const result = await execFileAsync(locator, [identifier], { encoding: "utf8" })
      stdout = result.stdout
      stderr = result.stderr
    } catch (err: any) {
      stdout = err?.stdout ?? ""
      stderr = err?.stderr ?? ""
      if (!stdout && err?.code === "ENOENT") {
        logger.warn({ identifier, err }, "Failed to resolve binary path via locator command")
        return identifier
      }
    }

    if (stdout) {
      const candidates = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !/^INFO:/i.test(line))

      if (candidates.length > 0) {
        const resolved = pickBinaryCandidate(candidates)
        logger.debug({ identifier, resolved, candidates }, "Resolved binary path from system PATH")
        return resolved
      }
    }

    if (stderr) {
      logger.warn({ identifier, stderr }, "Locator command reported errors")
    }
  } catch (error) {
    logger.warn({ identifier, err: error }, "Failed to resolve binary path from system PATH")
  }

  return identifier
}

export function pickBinaryCandidate(candidates: string[]): string {
  if (process.platform !== "win32") {
    return candidates[0] ?? ""
  }

  const extensionPreference = [".exe", ".cmd", ".bat", ".ps1"]

  for (const ext of extensionPreference) {
    const match = candidates.find((candidate) => candidate.toLowerCase().endsWith(ext))
    if (match) {
      return match
    }
  }

  return candidates[0] ?? ""
}
