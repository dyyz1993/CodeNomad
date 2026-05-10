import { produce } from "solid-js/store"
import type { SetStoreFunction } from "solid-js/store"
import type { InstanceMessageState, QuestionEntry } from "./types"

export interface QuestionOps {
  upsertQuestion: (entry: QuestionEntry) => void
  removeQuestion: (requestId: string) => void
  getQuestionState: (messageId?: string, partId?: string) => { entry: QuestionEntry; active: boolean } | null
}

export function createQuestionOps(
  state: InstanceMessageState,
  setState: SetStoreFunction<InstanceMessageState>,
): QuestionOps {
  function upsertQuestion(entry: QuestionEntry) {
    const messageKey = entry.messageId ?? "__global__"
    const partKey = entry.partId ?? entry.request?.id ?? "__global__"

    setState(
      "questions",
      produce((draft) => {
        draft.byMessage[messageKey] = draft.byMessage[messageKey] ?? {}
        draft.byMessage[messageKey][partKey] = entry
        const existingIndex = draft.queue.findIndex((item) => item.request.id === entry.request.id)
        if (existingIndex === -1) {
          draft.queue.push(entry)
        } else {
          draft.queue[existingIndex] = entry
        }
        if (!draft.active || draft.active.request.id === entry.request.id) {
          draft.active = entry
        }
      }),
    )
  }

  function removeQuestion(requestId: string) {
    setState(
      "questions",
      produce((draft) => {
        draft.queue = draft.queue.filter((item) => item.request.id !== requestId)
        if (draft.active?.request.id === requestId) {
          draft.active = draft.queue[0] ?? null
        }
        Object.keys(draft.byMessage).forEach((messageKey) => {
          const partEntries = draft.byMessage[messageKey]
          Object.keys(partEntries).forEach((partKey) => {
            if (partEntries[partKey].request.id === requestId) {
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

  function getQuestionState(messageId?: string, partId?: string) {
    const messageKey = messageId ?? "__global__"
    const partKey = partId ?? "__global__"
    const entry = state.questions.byMessage[messageKey]?.[partKey]
    if (!entry) return null
    const active = state.questions.active?.request.id === entry.request.id
    return { entry, active }
  }

  return { upsertQuestion, removeQuestion, getQuestionState }
}
