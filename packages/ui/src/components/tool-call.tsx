import { createSignal, Show, createEffect, createMemo } from "solid-js"
import { ArrowRightSquare, Copy } from "lucide-solid"
import { messageStoreBus } from "../stores/message-v2/bus"
import { useTheme } from "../lib/theme"
import { useConfig } from "../stores/preferences"
import { activeInterruption } from "../stores/instances"
import { copyToClipboard } from "../lib/clipboard"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { useI18n } from "../lib/i18n"
import { resolveToolRenderer } from "./tool-call/renderers"
import { extractDiagnostics, diagnosticFileName } from "./tool-call/diagnostics"
import { renderDiagnosticsSection } from "./tool-call/diagnostics-section"
import type {
  ToolCallPart,
  ToolRendererContext,
} from "./tool-call/types"
import {
  buildToolSpeechText,
  getToolIcon,
  getToolName,
  isToolStateCompleted,
  isToolStateRunning,
  getDefaultToolAction,
  readToolStatePayload,
} from "./tool-call/utils"
import { resolveTitleForTool } from "./tool-call/tool-title"
import { useSpeech } from "../lib/hooks/use-speech"
import SpeechActionButton from "./speech-action-button"
import { ToolCallDetails, ToolStatusIndicator } from "./tool-call/ToolCallDetails"


interface ToolCallProps {
  toolCall: ToolCallPart
  toolCallId?: string
  messageId?: string
  messageVersion?: number
  partVersion?: number
  instanceId: string
  sessionId: string
  onContentRendered?: () => void
  /**
   * When true, tool call starts collapsed regardless of user preferences.
   * Users can still expand/collapse manually.
   */
  forceCollapsed?: boolean
 }



export default function ToolCall(props: ToolCallProps) {
  const { preferences, setDiffViewMode } = useConfig()
  const { isDark } = useTheme()
  const { t } = useI18n()
  const toolCallMemo = createMemo(() => props.toolCall)
  const toolName = createMemo(() => toolCallMemo()?.tool || "")
  const toolCallIdentifier = createMemo(() => {
    const partId = toolCallMemo()?.id
    if (!partId) {
      throw new Error("Tool call requires a part id")
    }
    return partId
  })
  const toolState = createMemo(() => toolCallMemo()?.state)

  const store = createMemo(() => messageStoreBus.getOrCreate(props.instanceId))
  const activeRequest = createMemo(() => activeInterruption().get(props.instanceId) ?? null)

  const permissionState = createMemo(() => store().getPermissionState(props.messageId, toolCallIdentifier()))
  const pendingPermission = createMemo(() => {
    const state = permissionState()
    if (state) {
      return { permission: state.entry.permission, active: state.active }
    }
    return toolCallMemo()?.pendingPermission
  })

  const questionState = createMemo(() => store().getQuestionState(props.messageId, toolCallIdentifier()))
  const pendingQuestion = createMemo(() => {
    const state = questionState()
    if (state) {
      return { request: state.entry.request as QuestionRequest, active: state.active }
    }
    return undefined
  })

  const toolOutputDefaultExpanded = createMemo(() => (preferences().toolOutputExpansion || "expanded") === "expanded")
  const diagnosticsDefaultExpanded = createMemo(() => (preferences().diagnosticsExpansion || "expanded") === "expanded")

  const defaultExpandedForTool = createMemo(() => {
    if (props.forceCollapsed) {
      return false
    }
    const prefExpanded = toolOutputDefaultExpanded()
    const toolName = toolCallMemo()?.tool || ""
    if (toolName === "read") {
      const state = toolState()
      if (state?.status === "error") {
        return true
      }
      return false
    }
    return prefExpanded
  })

  const [userExpanded, setUserExpanded] = createSignal<boolean | null>(null)
  const toolInputsVisibility = createMemo(() => preferences().toolInputsVisibility || "collapsed")
  const [toolInputVisibilityOverride, setToolInputVisibilityOverride] = createSignal<"hidden" | "expanded" | null>(null)
  const effectiveToolInputsVisibility = createMemo(() => toolInputVisibilityOverride() ?? toolInputsVisibility())
  const isToolInputVisible = createMemo(() => effectiveToolInputsVisibility() !== "hidden")
  const inputDefaultExpanded = createMemo(() => effectiveToolInputsVisibility() === "expanded")
  const [inputSectionOverride, setInputSectionOverride] = createSignal<boolean | null>(null)
  const [outputSectionOverride, setOutputSectionOverride] = createSignal<boolean | null>(null)
  const inputSectionExpanded = () => {
    const override = inputSectionOverride()
    if (override !== null) return override
    return inputDefaultExpanded()
  }
  const outputSectionExpanded = () => {
    const override = outputSectionOverride()
    if (override !== null) return override
    return true
  }

  const isPermissionActive = createMemo(() => {
    const pending = pendingPermission()
    if (!pending?.permission) return false
    const active = activeRequest()
    return active?.kind === "permission" && active.id === pending.permission.id
  })

  const isQuestionActive = createMemo(() => {
    const pending = pendingQuestion()
    if (!pending?.request) return false
    const active = activeRequest()
    return active?.kind === "question" && active.id === pending.request.id
  })

  const expanded = () => {
    if (isPermissionActive() || isQuestionActive()) return true
    const override = userExpanded()
    if (override !== null) return override
    return defaultExpandedForTool()
  }

  const toolInput = createMemo(() => {
    const state = toolState()
    return readToolStatePayload(state).input
  })

  const hasToolInput = createMemo(() => {
    const input = toolInput()
    return input && Object.keys(input).length > 0
  })

  const [toolCallRootEl, setToolCallRootEl] = createSignal<HTMLDivElement | undefined>()
  const [scrollTopSnapshot, setScrollTopSnapshot] = createSignal(0)
  const [diagnosticsOverride, setDiagnosticsOverride] = createSignal<boolean | undefined>(undefined)

  const diagnosticsExpanded = () => {
    if (isPermissionActive() || isQuestionActive()) return true
    const override = diagnosticsOverride()
    if (override !== undefined) return override
    return diagnosticsDefaultExpanded()
  }
  const diagnosticsEntries = createMemo(() => {
    const state = toolState()
    if (!state) return []
    return extractDiagnostics(state)
  })

  const toggleInputSection = () => {
    setInputSectionOverride((prev) => {
      const current = prev === null ? inputSectionExpanded() : prev
      return !current
    })
  }

  const toggleOutputSection = () => {
    setOutputSectionOverride((prev) => {
      const current = prev === null ? outputSectionExpanded() : prev
      return !current
    })
  }
  const statusClass = () => {
    const status = toolState()?.status || "pending"
    return `tool-call-status-${status}`
  }

  const combinedStatusClass = () => {
    const base = statusClass()
    return pendingPermission() || pendingQuestion() ? `${base} tool-call-awaiting-permission` : base
  }

  function toggle() {
    const permission = pendingPermission()
    if (permission?.active) {
      return
    }
    setUserExpanded((prev) => {
      const current = prev === null ? defaultExpandedForTool() : prev
      return !current
    })
  }

  createEffect(() => {
    // When global preference changes, reset per-tool-call overrides so palette changes apply.
    toolInputsVisibility()
    setToolInputVisibilityOverride(null)
    setInputSectionOverride(null)
    setOutputSectionOverride(null)
  })

  const handleToggleInputVisibility = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!expanded()) {
      toggle()
    }

    const currentlyVisible = isToolInputVisible()
    setToolInputVisibilityOverride(currentlyVisible ? "hidden" : "expanded")
  }

  const renderer = createMemo(() => resolveToolRenderer(toolName()))

  const renderMarkdownStub: ToolRendererContext["renderMarkdown"] = () => null
  const renderAnsiStub: ToolRendererContext["renderAnsi"] = () => null
  const renderDiffStub: ToolRendererContext["renderDiff"] = () => null
  const renderToolCallStub: NonNullable<ToolRendererContext["renderToolCall"]> = () => null
  const headerRendererContext: ToolRendererContext = {
    toolCall: toolCallMemo,
    toolState,
    toolName,
    instanceId: props.instanceId,
    sessionId: props.sessionId,
    t,
    messageVersion: () => props.messageVersion,
    partVersion: () => props.partVersion,
    renderMarkdown: renderMarkdownStub,
    renderAnsi: renderAnsiStub,
    renderDiff: renderDiffStub,
    renderToolCall: renderToolCallStub,
    scrollHelpers: undefined,
  }

  const getRendererAction = () => renderer().getAction?.(headerRendererContext) ?? getDefaultToolAction(toolName())


  const renderToolTitle = () => {
    const state = toolState()
    const currentTool = toolName()

    if (currentTool !== "task") {
      return resolveTitleForTool({ toolName: currentTool, state })
    }

    if (!state) return getRendererAction()
    if (state.status === "pending") return getRendererAction()

    const customTitle = renderer().getTitle?.(headerRendererContext)
    if (customTitle) return customTitle

    if (isToolStateRunning(state) && state.title) {
      return state.title
    }

    if (isToolStateCompleted(state) && state.title) {
      return state.title
    }

    return getToolName(currentTool)
  }

  const headerText = createMemo(() => {
    // Keep this as a memo so copy always matches what's rendered.
    return renderToolTitle()
  })

  const speechText = createMemo(() =>
    buildToolSpeechText({
      title: headerText(),
      state: toolState(),
      t,
    }),
  )

  const speech = useSpeech({
    id: () => `${props.instanceId}:${props.sessionId}:${props.messageId ?? "message"}:${toolCallIdentifier()}`,
    text: speechText,
  })

  const canSpeakToolCall = () => speechText().trim().length > 0 && speech.canUseSpeech()

  const handleCopyHeader = async (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const text = headerText()
    if (!text) return
    await copyToClipboard(text)
  }

  const status = () => toolState()?.status || ""

  return (
    <div

      ref={(element) => {
        setToolCallRootEl(element || undefined)
      }}
      class={`tool-call ${combinedStatusClass()}`}
      data-part-type="tool"
      data-tool-name={toolName()}
      data-instance-id={props.instanceId}
      data-session-id={props.sessionId}
      data-message-id={props.messageId}
      data-part-id={toolCallIdentifier()}
    >
      <div class="tool-call-header">
        <button
          type="button"
          class="tool-call-header-toggle"
          onClick={toggle}
          aria-expanded={expanded()}
        >
          <span class="tool-call-summary" data-tool-icon={getToolIcon(toolName())}>
            {headerText()}
          </span>
        </button>

        <Show when={hasToolInput()}>
          <button
            type="button"
            class="tool-call-header-input"
            onClick={handleToggleInputVisibility}
            aria-pressed={isToolInputVisible()}
            aria-label={
              isToolInputVisible()
                ? t("toolCall.header.hideInputAriaLabel")
                : t("toolCall.header.showInputAriaLabel")
            }
            title={isToolInputVisible() ? t("toolCall.header.hideInputTitle") : t("toolCall.header.showInputTitle")}
          >
            <ArrowRightSquare class="w-3.5 h-3.5" />
          </button>
        </Show>

        <button
          type="button"
          class="tool-call-header-copy"
          onClick={handleCopyHeader}
          aria-label={t("toolCall.header.copyAriaLabel")}
          title={t("toolCall.header.copyTitle")}
        >
          <Copy class="w-3.5 h-3.5" />
        </button>

        <Show when={canSpeakToolCall()}>
          <SpeechActionButton
            class="tool-call-header-copy"
            onClick={() => void speech.toggle()}
            title={speech.buttonTitle()}
            isLoading={speech.isLoading()}
            isPlaying={speech.isPlaying()}
          />
        </Show>

        <ToolStatusIndicator status={status} />
      </div>

      <Show when={expanded()}>
        <ToolCallDetails
          toolCallMemo={toolCallMemo}
          toolState={toolState}
          toolName={toolName}
          toolCallIdentifier={toolCallIdentifier}
          instanceId={props.instanceId}
          sessionId={props.sessionId}
          messageId={props.messageId}
          messageVersion={props.messageVersion}
          partVersion={props.partVersion}
          onContentRendered={props.onContentRendered}
          preferences={preferences}
          setDiffViewMode={setDiffViewMode}
          isDark={isDark}
          t={t}
          store={store}
          pendingPermission={pendingPermission}
          pendingQuestion={pendingQuestion}
          isPermissionActive={isPermissionActive}
          isQuestionActive={isQuestionActive}
          hasToolInput={hasToolInput}
          isToolInputVisible={isToolInputVisible}
          toolInput={toolInput}
          inputSectionExpanded={inputSectionExpanded}
          outputSectionExpanded={outputSectionExpanded}
          toggleInputSection={toggleInputSection}
          toggleOutputSection={toggleOutputSection}
          toolCallRootEl={toolCallRootEl}
          scrollTopSnapshot={scrollTopSnapshot}
          setScrollTopSnapshot={setScrollTopSnapshot}
        />
      </Show>
 
      <Show when={diagnosticsEntries().length}>

        {renderDiagnosticsSection(
          t,
          diagnosticsEntries(),
          diagnosticsExpanded(),
          () => setDiagnosticsOverride((prev) => {
            const current = prev === undefined ? diagnosticsDefaultExpanded() : prev
            return !current
          }),
          diagnosticFileName(diagnosticsEntries()),
        )}
      </Show>
    </div>
  )
}
