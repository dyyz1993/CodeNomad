import { createSignal, Show, createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import { Hourglass, Loader2, Check, XCircle } from "lucide-solid"
import { stringify as stringifyYaml } from "yaml"
import { messageStoreBus } from "../../stores/message-v2/bus"
import { useGlobalCache } from "../../lib/hooks/use-global-cache"
import { useConfig } from "../../stores/preferences"
import { sendPermissionResponse, sendQuestionReject, sendQuestionReply } from "../../stores/instances"
import { useI18n } from "../../lib/i18n"
import { resolveToolRenderer } from "./renderers"
import { QuestionToolBlock } from "./question-block"
import { PermissionToolBlock } from "./permission-block"
import { createAnsiContentRenderer } from "./ansi-render"
import { createDiffContentRenderer } from "./diff-render"
import { createMarkdownContentRenderer } from "./markdown-render"
import type { ToolCallPart, ToolRendererContext, ToolScrollHelpers } from "./types"
import { ensureMarkdownContent } from "./utils"
import { getLogger } from "../../lib/logger"
import { createFollowScroll } from "../../lib/follow-scroll"
import type { PermissionRequestLike } from "../../types/permission"
import { getPermissionSessionId } from "../../types/permission"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import ToolCall from "../tool-call"

const log = getLogger("session")

type ToolState = import("@opencode-ai/sdk/v2").ToolState

const TOOL_CALL_CACHE_SCOPE = "tool-call"
const TOOL_SCROLL_SENTINEL_MARGIN_PX = 48

function makeRenderCacheKey(
  toolCallId?: string | null,
  messageId?: string,
  partId?: string | null,
  variant = "default",
) {
  const messageComponent = messageId ?? "unknown-message"
  const toolCallComponent = partId ?? toolCallId ?? "unknown-tool-call"
  return `${messageComponent}:${toolCallComponent}:${variant}`
}

export function ToolStatusIndicator(props: { status: Accessor<string> }) {
  const isVisible = (value: string) => props.status() === value

  return (
    <span class="tool-call-header-status" aria-hidden="true" data-status={props.status() || "pending"}>
      <span style={{ display: isVisible("pending") ? "inline-flex" : "none" }}>
        <Hourglass class="w-4 h-4" />
      </span>
      <span style={{ display: isVisible("running") ? "inline-flex" : "none" }}>
        <Loader2 class="w-4 h-4 animate-spin" />
      </span>
      <span style={{ display: isVisible("completed") ? "inline-flex" : "none" }}>
        <Check class="w-4 h-4" />
      </span>
      <span style={{ display: isVisible("error") ? "inline-flex" : "none" }}>
        <XCircle class="w-4 h-4" />
      </span>
    </span>
  )
}

export function ToolCallDetails(props: {
  toolCallMemo: () => ToolCallPart
  toolState: () => ToolState | undefined
  toolName: () => string
  toolCallIdentifier: () => string
  instanceId: string
  sessionId: string
  messageId?: string
  messageVersion?: number
  partVersion?: number
  onContentRendered?: () => void
  preferences: ReturnType<typeof useConfig>["preferences"]
  setDiffViewMode: ReturnType<typeof useConfig>["setDiffViewMode"]
  isDark: () => boolean
  t: ReturnType<typeof useI18n>["t"]
  store: () => ReturnType<typeof messageStoreBus.getOrCreate>
  pendingPermission: () => { permission: PermissionRequestLike; active: boolean } | undefined
  pendingQuestion: () => { request: QuestionRequest; active: boolean } | undefined
  isPermissionActive: () => boolean
  isQuestionActive: () => boolean
  hasToolInput: () => boolean
  isToolInputVisible: () => boolean
  toolInput: () => Record<string, any> | undefined
  inputSectionExpanded: () => boolean
  outputSectionExpanded: () => boolean
  toggleInputSection: () => void
  toggleOutputSection: () => void
  toolCallRootEl: () => HTMLDivElement | undefined
  scrollTopSnapshot: () => number
  setScrollTopSnapshot: (next: number) => void
}) {
  const messageVersionAccessor = createMemo(() => props.messageVersion)
  const partVersionAccessor = createMemo(() => props.partVersion)

  const cacheContext = createMemo(() => ({
    toolCallId: props.toolCallIdentifier(),
    messageId: props.messageId,
    partId: props.toolCallMemo()?.id ?? null,
  }))

  const cacheVersion = createMemo(() => {
    if (typeof props.partVersion === "number") {
      return String(props.partVersion)
    }
    if (typeof props.messageVersion === "number") {
      return String(props.messageVersion)
    }
    return "noversion"
  })

  const createVariantCache = (variant: string | (() => string), version?: () => string) =>
    useGlobalCache({
      instanceId: () => props.instanceId,
      sessionId: () => props.sessionId,
      scope: TOOL_CALL_CACHE_SCOPE,
      cacheId: () => {
        const context = cacheContext()
        const resolvedVariant = typeof variant === "function" ? variant() : variant
        return makeRenderCacheKey(context.toolCallId || undefined, context.messageId, context.partId, resolvedVariant)
      },
      version: () => (version ? version() : cacheVersion()),
    })

  const diffCache = createVariantCache("diff")
  const permissionDiffCache = createVariantCache("permission-diff")
  const ansiRunningCache = createVariantCache("ansi-running", () => "running")
  const ansiFinalCache = createVariantCache("ansi-final")

  const permissionDetails = createMemo(() => props.pendingPermission()?.permission)
  const questionDetails = createMemo(() => props.pendingQuestion()?.request)

  const activePermissionKey = createMemo(() => {
    const permission = permissionDetails()
    return permission && props.isPermissionActive() ? permission.id : ""
  })

  const activeQuestionKey = createMemo(() => {
    const request = questionDetails()
    return request && props.isQuestionActive() ? request.id : ""
  })

  const [permissionSubmitting, setPermissionSubmitting] = createSignal(false)
  const [permissionError, setPermissionError] = createSignal<string | null>(null)

  const followScroll = createFollowScroll({
    getScrollTopSnapshot: props.scrollTopSnapshot,
    setScrollTopSnapshot: props.setScrollTopSnapshot,
    sentinelMarginPx: TOOL_SCROLL_SENTINEL_MARGIN_PX,
    sentinelClassName: "tool-call-scroll-sentinel",
  })

  const scrollHelpers: ToolScrollHelpers = {
    registerContainer: (element, options) => {
      followScroll.registerContainer(element, options)
    },
    handleScroll: followScroll.handleScroll,
    renderSentinel: followScroll.renderSentinel,
    restoreAfterRender: followScroll.restoreAfterRender,
  }

  const handleScrollRendered = () => {
    scrollHelpers.restoreAfterRender()
  }

  createEffect(() => {
    const permission = permissionDetails()
    if (!permission) {
      setPermissionSubmitting(false)
      setPermissionError(null)
    } else {
      setPermissionError(null)
    }
  })

  createEffect(() => {
    const activeKey = activePermissionKey() || activeQuestionKey()
    if (!activeKey) return
    requestAnimationFrame(() => {
      props.toolCallRootEl()?.scrollIntoView({ block: "center", behavior: "smooth" })
    })
  })

  async function handlePermissionResponse(permission: PermissionRequestLike, response: "once" | "always" | "reject") {
    if (!permission) return
    setPermissionSubmitting(true)
    setPermissionError(null)
    try {
      const sessionId = getPermissionSessionId(permission) || props.sessionId
      await sendPermissionResponse(props.instanceId, sessionId, permission.id, response)
    } catch (error) {
      log.error("Failed to send permission response", error)
      setPermissionError(error instanceof Error ? error.message : props.t("toolCall.permission.errors.unableToUpdate"))
    } finally {
      setPermissionSubmitting(false)
    }
  }

  createEffect(() => {
    const activeKey = activePermissionKey()
    if (!activeKey) return
    const handler = (event: KeyboardEvent) => {
      const permission = permissionDetails()
      if (!permission || !props.isPermissionActive()) return
      if (event.key === "Enter") {
        event.preventDefault()
        void handlePermissionResponse(permission, "once")
      } else if (event.key === "a" || event.key === "A") {
        event.preventDefault()
        void handlePermissionResponse(permission, "always")
      } else if (event.key === "d" || event.key === "D") {
        event.preventDefault()
        void handlePermissionResponse(permission, "reject")
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  const [questionSubmitting, setQuestionSubmitting] = createSignal(false)
  const [questionError, setQuestionError] = createSignal<string | null>(null)
  const [questionDraftAnswers, setQuestionDraftAnswers] = createSignal<Record<string, string[][]>>({})

  function isTextInputFocused() {
    const active = document.activeElement
    return (
      active?.tagName === "TEXTAREA" ||
      active?.tagName === "INPUT" ||
      (active?.hasAttribute("contenteditable") ?? false)
    )
  }

  async function handleQuestionSubmit() {
    const request = questionDetails()
    if (!request || !props.isQuestionActive()) {
      return
    }
    const answers = (questionDraftAnswers()[request.id] ?? []).map((x) => (Array.isArray(x) ? x : []))
    const normalized = request.questions.map((_, index) => {
      const row = answers[index] ?? []
      return row.map((value) => value.trim()).filter((value) => value.length > 0)
    })
    if (normalized.some((item) => (item?.length ?? 0) === 0)) {
      setQuestionError(props.t("toolCall.question.validation.answerAll"))
      return
    }

    setQuestionSubmitting(true)
    setQuestionError(null)
    try {
      const sessionId = (request as any).sessionID ?? (request as any).sessionId ?? props.sessionId
      await sendQuestionReply(props.instanceId, sessionId, request.id, normalized)
    } catch (error) {
      log.error("Failed to send question reply", error)
      setQuestionError(error instanceof Error ? error.message : props.t("toolCall.question.errors.unableToReply"))
    } finally {
      setQuestionSubmitting(false)
    }
  }

  async function handleQuestionDismiss() {
    const request = questionDetails()
    if (!request || !props.isQuestionActive()) {
      return
    }
    setQuestionSubmitting(true)
    setQuestionError(null)
    try {
      const sessionId = (request as any).sessionID ?? (request as any).sessionId ?? props.sessionId
      await sendQuestionReject(props.instanceId, sessionId, request.id)
    } catch (error) {
      log.error("Failed to reject question", error)
      setQuestionError(error instanceof Error ? error.message : props.t("toolCall.question.errors.unableToDismiss"))
    } finally {
      setQuestionSubmitting(false)
    }
  }

  createEffect(() => {
    const activeKey = activeQuestionKey()
    if (!activeKey) return
    const handler = (event: KeyboardEvent) => {
      if (isTextInputFocused()) return
      if (event.key === "Enter") {
        event.preventDefault()
        void handleQuestionSubmit()
      } else if (event.key === "Escape") {
        event.preventDefault()
        void handleQuestionDismiss()
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  createEffect(() => {
    const request = questionDetails()
    if (!request) {
      setQuestionSubmitting(false)
      setQuestionError(null)
      return
    }
    setQuestionError(null)
    const requestId = request.id
    setQuestionDraftAnswers((prev) => {
      if (prev[requestId]) return prev
      const initial = request.questions.map(() => [])
      return { ...prev, [requestId]: initial }
    })
  })

  const status = () => props.toolState()?.status || ""

  const toolInputMarkdown = createMemo(() => {
    const input = props.toolInput()
    if (!input || Object.keys(input).length === 0) return null

    try {
      const yamlText = stringifyYaml(input)
      return ensureMarkdownContent(yamlText, "yaml", true)
    } catch (error) {
      log.error("Failed to convert tool call input to YAML", error)
      try {
        const jsonText = JSON.stringify(input, null, 2)
        return ensureMarkdownContent(jsonText, "json", true)
      } catch (nestedError) {
        log.error("Failed to stringify tool call input", nestedError)
        return null
      }
    }
  })

  const renderer = createMemo(() => resolveToolRenderer(props.toolName()))

  const { renderAnsiContent } = createAnsiContentRenderer({
    ansiRunningCache,
    ansiFinalCache,
    scrollHelpers,
    partVersion: partVersionAccessor,
  })

  const { renderDiffContent } = createDiffContentRenderer({
    toolState: props.toolState,
    preferences: props.preferences,
    setDiffViewMode: props.setDiffViewMode,
    isDark: props.isDark,
    t: props.t,
    diffCache,
    permissionDiffCache,
    scrollHelpers,
    handleScrollRendered,
    onContentRendered: props.onContentRendered,
  })

  const { renderMarkdownContent } = createMarkdownContentRenderer({
    toolState: props.toolState,
    partId: props.toolCallIdentifier,
    partVersion: partVersionAccessor,
    instanceId: props.instanceId,
    sessionId: props.sessionId,
    isDark: props.isDark,
    scrollHelpers,
    handleScrollRendered,
    onContentRendered: props.onContentRendered,
  })

  const rendererContext: ToolRendererContext = {
    toolCall: props.toolCallMemo,
    toolState: props.toolState,
    toolName: props.toolName,
    instanceId: props.instanceId,
    sessionId: props.sessionId,
    t: props.t,
    messageVersion: messageVersionAccessor,
    partVersion: partVersionAccessor,
    renderMarkdown: renderMarkdownContent,
    renderAnsi: renderAnsiContent,
    renderDiff: renderDiffContent,
    renderToolCall: (options) => {
      if (!options?.toolCall) return null
      return (
        <ToolCall
          toolCall={options.toolCall}
          toolCallId={options.toolCall.id}
          messageId={options.messageId}
          messageVersion={options.messageVersion}
          partVersion={options.partVersion}
          instanceId={props.instanceId}
          sessionId={options.sessionId}
          onContentRendered={props.onContentRendered}
          forceCollapsed={options.forceCollapsed}
        />
      )
    },
    scrollHelpers,
    onContentRendered: props.onContentRendered,
  }

  let previousPartVersion: number | undefined
  createEffect(() => {
    const version = partVersionAccessor()
    if (version === undefined) {
      return
    }
    if (previousPartVersion !== undefined && version === previousPartVersion) {
      return
    }
    previousPartVersion = version
    scrollHelpers.restoreAfterRender()
  })

  createEffect(() => {
    if (followScroll.autoScroll()) {
      scrollHelpers.restoreAfterRender()
    }
  })

  const renderToolBody = () => {
    return renderer().renderBody(rendererContext)
  }

  const renderError = () => {
    const state = props.toolState()
    if (state?.status === "error" && state.error) {
      return (
        <div class="tool-call-error-content">
          <strong>{props.t("toolCall.error.label")}</strong> {state.error}
        </div>
      )
    }
    return null
  }

  const renderPermissionBlock = () => (
    <PermissionToolBlock
      permission={permissionDetails}
      active={props.isPermissionActive}
      submitting={permissionSubmitting}
      error={permissionError}
      renderDiff={renderDiffContent}
      fallbackSessionId={() => props.sessionId}
      onRespond={(permission, sessionId, response) => void handlePermissionResponse(permission, response)}
    />
  )

  const renderQuestionBlock = () => (
    <QuestionToolBlock
      toolName={props.toolName}
      toolState={props.toolState}
      toolCallId={props.toolCallIdentifier}
      request={questionDetails}
      active={props.isQuestionActive}
      submitting={questionSubmitting}
      error={questionError}
      draftAnswers={questionDraftAnswers}
      setDraftAnswers={setQuestionDraftAnswers}
      onSubmit={() => void handleQuestionSubmit()}
      onDismiss={() => void handleQuestionDismiss()}
    />
  )

  return (
    <div class="tool-call-details">
      <Show
        when={props.isToolInputVisible() && props.hasToolInput()}
        fallback={
          <>
            {renderToolBody()}
            {renderError()}

            <Show when={status() === "pending" && !props.pendingPermission()}>
              <div class="tool-call-pending-message">
                <span class="spinner-small"></span>
                <span>{props.t("toolCall.pending.waitingToRun")}</span>
              </div>
            </Show>
          </>
        }
      >
        <div class="tool-call-io-sections">
          <div class="tool-call-io-section">
            <button type="button" class="tool-call-io-toggle" aria-expanded={props.inputSectionExpanded()} onClick={props.toggleInputSection}>
              <span class="tool-call-io-title">{props.t("toolCall.io.input")}</span>
            </button>

            <Show when={props.inputSectionExpanded()}>
              <div class="tool-call-io-body">
                {(() => {
                  const content = toolInputMarkdown()
                  if (!content) return null
                  return renderMarkdownContent({ content, cacheKey: "input" })
                })()}
              </div>
            </Show>
          </div>

          <div class="tool-call-io-section">
            <button type="button" class="tool-call-io-toggle" aria-expanded={props.outputSectionExpanded()} onClick={props.toggleOutputSection}>
              <span class="tool-call-io-title">{props.t("toolCall.io.output")}</span>
            </button>

            <Show when={props.outputSectionExpanded()}>
              <div class="tool-call-io-body">
                {renderToolBody()}
                {renderError()}

                <Show when={status() === "pending" && !props.pendingPermission()}>
                  <div class="tool-call-pending-message">
                    <span class="spinner-small"></span>
                    <span>{props.t("toolCall.pending.waitingToRun")}</span>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </Show>

      {renderPermissionBlock()}
      {renderQuestionBlock()}
    </div>
  )
}
