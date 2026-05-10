import type { LocalUrlMatch } from "./types"

const LOCAL_URL_REGEX =
  /https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?::(\d+))?(\/[^\s<>"')\]]*)?/gi

export function detectLocalUrls(text: string): LocalUrlMatch[] {
  const matches: LocalUrlMatch[] = []
  let match: RegExpExecArray | null

  while ((match = LOCAL_URL_REGEX.exec(text)) !== null) {
    matches.push({
      fullUrl: match[0],
      host: match[1],
      port: parseInt(match[3] || "80", 10),
      path: match[4] || "/",
    })
  }

  return matches
}

export function replaceLocalUrls(
  text: string,
  replacements: Map<string, string>,
): string {
  let result = text
  for (const [localUrl, publicUrl] of replacements) {
    result = result.split(localUrl).join(publicUrl)
  }
  return result
}
