export function getDisplayPath(path: string): string {
  if (!path) return path

  if (path.startsWith("/Users/")) {
    return path.replace(/^\/Users\/[^/]+/, "~")
  }

  if (path.startsWith("/home/")) {
    return path.replace(/^\/home\/[^/]+/, "~")
  }

  if (/^[A-Za-z]:\\Users\\/.test(path)) {
    return path.replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~")
  }
  if (/^[A-Za-z]:\/Users\//.test(path)) {
    return path.replace(/^[A-Za-z]:\/Users\/[^/]+/, "~")
  }

  return path
}

export function looksLikeWindowsPath(value: string): boolean {
  if (!value) return false
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
}

export function splitFolderPath(rawPath: string): { baseName: string; dirName: string } {
  if (!rawPath) return { baseName: "", dirName: "" }

  const isWindows = looksLikeWindowsPath(rawPath)
  const trimmed = rawPath.replace(/[\\/]+$/, "")

  if (!trimmed) {
    return { baseName: rawPath, dirName: "" }
  }

  if (isWindows && /^[A-Za-z]:$/.test(trimmed)) {
    return { baseName: `${trimmed}\\`, dirName: "" }
  }

  const lastSlash = trimmed.lastIndexOf("/")
  const lastBackslash = isWindows ? trimmed.lastIndexOf("\\") : -1
  const lastSep = Math.max(lastSlash, lastBackslash)

  if (lastSep < 0) {
    return { baseName: trimmed, dirName: "" }
  }

  const baseName = trimmed.slice(lastSep + 1) || trimmed
  const dirName = trimmed.slice(0, lastSep)
  return { baseName, dirName }
}
