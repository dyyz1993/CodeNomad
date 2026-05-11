import type { SessionSearchMatch } from "../../lib/session-search"

export interface SearchStateAccessors {
  searchMatches: () => SessionSearchMatch[]
  activeSearchIndex: () => number
  searchQuery: () => string
  isSearchPending: () => boolean
  searchedQuery: () => string
}

export function computeActiveSearchMatch(state: SearchStateAccessors): SessionSearchMatch | null {
  const matches = state.searchMatches()
  if (matches.length === 0) return null
  const index = Math.min(Math.max(state.activeSearchIndex(), 0), matches.length - 1)
  return matches[index] ?? null
}

export function computeSearchResultMessageIds(state: SearchStateAccessors): Set<string> {
  return new Set(state.searchMatches().map((match) => match.messageId))
}

export const SEARCH_MIN_CHARS = 3

export function computeTrimmedSearchQuery(searchQuery: () => string): string {
  return searchQuery().trim()
}

export function computeIsSearchSettled(
  trimmedSearchQuery: () => string,
  isSearchPending: () => boolean,
  searchedQuery: () => string,
): boolean {
  const query = trimmedSearchQuery()
  return query.length >= SEARCH_MIN_CHARS && !isSearchPending() && searchedQuery().trim() === query
}
