import { produce } from "solid-js/store"
import type { SetStoreFunction } from "solid-js/store"
import type { ClientPart } from "../../types/message"
import type { InstanceMessageState, PermissionEntry } from "./types"

export interface PermissionOps {
  rebindPermissionForPart: (messageId: string, partId: string, part: ClientPart) => void
  upsertPermission: (entry: PermissionEntry) => void
  removePermission: (permissionId: string) => void
  getPermissionState: (messageId?: string, partId?: string) => { entry: PermissionEntry; active: boolean } | null
}

export function createPermissionOps(
  state: InstanceMessageState,
  setState: SetStoreFunction<InstanceMessageState>,
): PermissionOps {
  function rebindPermissionForPart(messageId: string, partId: string, part: ClientPart) {
    if (!messageId || !partId || part.type !== "tool") {
      return
    }

    const toolCallId =
      (part as any).callID ??
      (part as any).callId ??
      (part as any).toolCallID ??
      (part as any).toolCallId ??
      undefined
    if (!toolCallId) {
      return
    }

    setState(
      "permissions",
      "byMessage",
      messageId,
      produce((draft) => {
        if (!draft) return
        const existing = draft[partId]
        for (const [key, entry] of Object.entries(draft)) {
          if (!entry || entry.partId) continue
          const permissionCallId =
            (entry.permission as any).tool?.callID ??
            (entry.permission as any).tool?.callId ??
            (entry.permission as any).callID ??
            (entry.permission as any).callId ??
            (entry.permission as any).toolCallID ??
            (entry.permission as any).toolCallId ??
            (entry.permission as any).metadata?.callID ??
            (entry.permission as any).metadata?.callId ??
            undefined
          if (permissionCallId !== toolCallId) continue
          if (!existing || existing.permission.id === entry.permission.id) {
            entry.partId = partId
            draft[partId] = entry
            delete draft[key]
          }
          break
        }
      }),
    )
  }

  function upsertPermission(entry: PermissionEntry) {
    const messageKey = entry.messageId ?? "__global__"
    const partKey = entry.partId ?? entry.permission?.id ?? "__global__"

    setState(
      "permissions",
      produce((draft) => {
        draft.byMessage[messageKey] = draft.byMessage[messageKey] ?? {}
        draft.byMessage[messageKey][partKey] = entry
        const existingIndex = draft.queue.findIndex((item) => item.permission.id === entry.permission.id)
        if (existingIndex === -1) {
          draft.queue.push(entry)
        } else {
          draft.queue[existingIndex] = entry
        }
        if (!draft.active || draft.active.permission.id === entry.permission.id) {
          draft.active = entry
        }
      }),
    )
  }

  function removePermission(permissionId: string) {
    setState(
      "permissions",
      produce((draft) => {
        draft.queue = draft.queue.filter((item) => item.permission.id !== permissionId)
        if (draft.active?.permission.id === permissionId) {
          draft.active = draft.queue[0] ?? null
        }
        Object.keys(draft.byMessage).forEach((messageKey) => {
          const partEntries = draft.byMessage[messageKey]
          Object.keys(partEntries).forEach((partKey) => {
            if (partEntries[partKey].permission.id === permissionId) {
              delete partEntries[partKey]
            }
          })
          if (Object.keys(partEntries).length === 0) {
            delete draft.byMessage[messageKey]
          }
        })
      }),
    )
  }

  function getPermissionState(messageId?: string, partId?: string) {
    const messageKey = messageId ?? "__global__"
    const partKey = partId ?? "__global__"
    const entry = state.permissions.byMessage[messageKey]?.[partKey]
    if (!entry) return null
    const active = state.permissions.active?.permission.id === entry.permission.id
    return { entry, active }
  }

  return { rebindPermissionForPart, upsertPermission, removePermission, getPermissionState }
}
