import { resetToolStream } from "../app-tool-stream.ts";
import { extractText } from "../chat/message-extract.ts";
import { formatConnectError } from "../connect-error.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { generateUUID } from "../uuid.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;

function isSilentReplyStream(text: string): boolean {
  return SILENT_REPLY_PATTERN.test(text);
}
/** Client-side defense-in-depth: detect assistant messages whose text is purely NO_REPLY. */
function isAssistantSilentReply(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  if (role !== "assistant") {
    return false;
  }
  // entry.text takes precedence — matches gateway extractAssistantTextForSilentCheck
  if (typeof entry.text === "string") {
    return isSilentReplyStream(entry.text);
  }
  const text = extractText(message);
  return typeof text === "string" && isSilentReplyStream(text);
}

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

/**
 * 近似 token 计数：中文约 1.5 字符/token，英文约 4 字符/token。
 * 误差通常在 10-15% 以内，适合日志统计用途。
 */
function approximateTokenCount(text: string): number {
  if (!text) return 0;
  let chineseCount = 0;
  let otherCount = 0;
  for (const ch of text) {
    // 基本汉字 + CJK 扩展
    if (ch >= "\u4e00" && ch <= "\u9fff") {
      chineseCount++;
    } else {
      otherCount++;
    }
  }
  // 中文字符按 ~0.67 token/字计，英文等按 ~0.25 token/字计
  return Math.ceil(chineseCount * 0.67 + otherCount * 0.25);
}

/**
 * 从消息内容块（content array 或 text 字段）中提取纯文本。
 */
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      const b = block as Record<string, unknown>;
      if (b?.type === "text" && typeof b.text === "string") return b.text;
      if (b?.type === "thinking" && typeof b.thinking === "string") return b.thinking;
      if (b?.type === "toolResult" && Array.isArray(b.content)) {
        return extractTextFromContent(b.content);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 从 history 中汇总所有 assistant 消息里已有的 usage（若 gateway 有填充则直接用）。
 * 若全部都是 0，则退回到客户端近似计算。
 */
function computeTokenUsage(
  historyMessages: Array<Record<string, unknown>>,
  finalMessage: Record<string, unknown> | undefined,
): { inputTokens: number; outputTokens: number; source: "gateway" | "approximate" } {
  // 优先尝试从 history 中汇聚 gateway 已填充的 usage
  let totalInput = 0;
  let totalOutput = 0;
  let hasGatewayData = false;

  const allMsgs = finalMessage ? [...historyMessages, finalMessage] : historyMessages;

  for (const m of allMsgs) {
    const usage = m.usage as Record<string, number> | undefined;
    if (usage && (usage.input > 0 || usage.output > 0)) {
      hasGatewayData = true;
      totalInput += usage.input ?? 0;
      totalOutput += usage.output ?? 0;
    }
  }

  if (hasGatewayData) {
    return { inputTokens: totalInput, outputTokens: totalOutput, source: "gateway" };
  }

  // 退回到客户端近似计算
  // 输入 token = 所有历史消息的文本（不含本次 assistant 回复）
  let inputText = "";
  for (const m of historyMessages) {
    inputText += extractTextFromContent(m.content) + "\n";
  }

  // 输出 token = 本次 finalMessage 的文本
  let outputText = "";
  if (finalMessage) {
    outputText = extractTextFromContent(finalMessage.content);
  }

  return {
    inputTokens: approximateTokenCount(inputText),
    outputTokens: approximateTokenCount(outputText),
    source: "approximate",
  };
}

/**
 * 从 history 中提取所有被调用的 Skills/工具名称列表。
 */
function extractSkillsUsed(historyMessages: Array<Record<string, unknown>>): string[] {
  const skills = new Set<string>();
  for (const m of historyMessages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as Array<Record<string, unknown>>) {
      // toolCall 块中的 name 字段就是 skill/tool 名
      if (block?.type === "toolCall" && typeof block.name === "string") {
        skills.add(block.name);
      }
    }
  }
  return [...skills];
}

function submitTurnLogs(payload: ChatEventPayload, state: ChatState, duration: number) {
  try {
    // 找最后一条 user 消息作为本轮输入内容，同时记下其 timestamp 用于备用耗时计算
    let userInputText = "";
    let lastUserTimestamp = 0;
    const allMessages = state.chatMessages as Array<Record<string, unknown>>;
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const m = allMessages[i];
      if (m?.role === "user") {
        userInputText = extractTextFromContent(m.content);
        if (typeof m.timestamp === "number") {
          lastUserTimestamp = m.timestamp;
        }
        break;
      }
    }

    // 提取模型信息（来自 payload.message）
    const finalMsg = payload.message as Record<string, unknown> | undefined;

    // 若 chatStreamStartedAt 已丢失（duration === 0），则用消息 timestamp 推算实际耗时：
    // endTs 优先取 finalMsg.timestamp（模型完成时间），否则用 Date.now()
    let resolvedDuration = duration;
    if (resolvedDuration === 0 && lastUserTimestamp > 0) {
      const endTs =
        typeof finalMsg?.timestamp === "number" ? finalMsg.timestamp : Date.now();
      const computed = endTs - lastUserTimestamp;
      if (computed > 0) {
        resolvedDuration = computed;
      }
    }

    // 计算 token 使用量
    const { inputTokens, outputTokens, source: tokenSource } = computeTokenUsage(
      allMessages,
      finalMsg,
    );

    // 提取本次对话用到的 Skills
    const skillsUsed = extractSkillsUsed(allMessages);

    const data = {
      timestamp: Date.now(),
      durationMs: resolvedDuration,
      runId: payload.runId,
      sessionKey: state.sessionKey,
      endState: payload.state,
      errorMessage: payload.errorMessage,
      userInput: userInputText,
      model: finalMsg?.model ?? null,
      provider: finalMsg?.provider ?? null,
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        source: tokenSource,
      },
      skillsUsed,
      message: payload.message,
      history: state.chatMessages,
    };

    fetch("/api/save-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).catch((err) => {
      console.warn("Failed to save chat log to dev server API:", err);
    });
  } catch (err) {
    console.warn("Failed to assemble chat log payload:", err);
  }
}


function maybeResetToolStream(state: ChatState) {
  const toolHost = state as ChatState & Partial<Parameters<typeof resetToolStream>[0]>;
  if (
    toolHost.toolStreamById instanceof Map &&
    Array.isArray(toolHost.toolStreamOrder) &&
    Array.isArray(toolHost.chatToolMessages) &&
    Array.isArray(toolHost.chatStreamSegments)
  ) {
    resetToolStream(toolHost as Parameters<typeof resetToolStream>[0]);
  }
}

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = await state.client.request<{ messages?: Array<unknown>; thinkingLevel?: string }>(
      "chat.history",
      {
        sessionKey: state.sessionKey,
        limit: 200,
      },
    );
    const messages = Array.isArray(res.messages) ? res.messages : [];
    state.chatMessages = messages.filter((message) => !isAssistantSilentReply(message));
    state.chatThinkingLevel = res.thinkingLevel ?? null;
    // Clear all streaming state — history includes tool results and text
    // inline, so keeping streaming artifacts would cause duplicates.
    maybeResetToolStream(state);
    state.chatStream = null;
    state.chatStreamStartedAt = null;
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.chatLoading = false;
  }
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

type AssistantMessageNormalizationOptions = {
  roleRequirement: "required" | "optional";
  roleCaseSensitive?: boolean;
  requireContentArray?: boolean;
  allowTextField?: boolean;
};

function normalizeAssistantMessage(
  message: unknown,
  options: AssistantMessageNormalizationOptions,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const roleValue = candidate.role;
  if (typeof roleValue === "string") {
    const role = options.roleCaseSensitive ? roleValue : roleValue.toLowerCase();
    if (role !== "assistant") {
      return null;
    }
  } else if (options.roleRequirement === "required") {
    return null;
  }

  if (options.requireContentArray) {
    return Array.isArray(candidate.content) ? candidate : null;
  }
  if (!("content" in candidate) && !(options.allowTextField && "text" in candidate)) {
    return null;
  }
  return candidate;
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "required",
    roleCaseSensitive: true,
    requireContentArray: true,
  });
}

function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "optional",
    allowTextField: true,
  });
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }

  const now = Date.now();

  // Build user message content blocks
  const contentBlocks: Array<{ type: string; text?: string; source?: unknown }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  if (hasAttachments) {
    for (const att of attachments) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
      });
    }
  }

  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;

  // Convert attachments to API format
  const apiAttachments = hasAttachments
    ? attachments
        .map((att) => {
          const parsed = dataUrlToBase64(att.dataUrl);
          if (!parsed) {
            return null;
          }
          return {
            type: "image",
            mimeType: parsed.mimeType,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;

  try {
    await state.client.request("chat.send", {
      sessionKey: state.sessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: runId,
      attachments: apiAttachments,
    });
    return runId;
  } catch (err) {
    const error = formatConnectError(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return null;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId ? { sessionKey: state.sessionKey, runId } : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = formatConnectError(err);
    return false;
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  if (payload.sessionKey !== state.sessionKey) {
    return null;
  }

  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizeFinalAssistantMessage(payload.message);
      if (finalMessage && !isAssistantSilentReply(finalMessage)) {
        state.chatMessages = [...state.chatMessages, finalMessage];
        return null;
      }
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (typeof next === "string" && !isSilentReplyStream(next)) {
      const current = state.chatStream ?? "";
      if (!current || next.length >= current.length) {
        state.chatStream = next;
      }
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizeFinalAssistantMessage(payload.message);
    if (finalMessage && !isAssistantSilentReply(finalMessage)) {
      state.chatMessages = [...state.chatMessages, finalMessage];
    } else if (state.chatStream?.trim() && !isSilentReplyStream(state.chatStream)) {
      state.chatMessages = [
        ...state.chatMessages,
        {
          role: "assistant",
          content: [{ type: "text", text: state.chatStream }],
          timestamp: Date.now(),
        },
      ];
    }
    const duration = state.chatStreamStartedAt ? Date.now() - state.chatStreamStartedAt : 0;
    submitTurnLogs(payload, state, duration);

    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage && !isAssistantSilentReply(normalizedMessage)) {
      state.chatMessages = [...state.chatMessages, normalizedMessage];
    } else {
      const streamedText = state.chatStream ?? "";
      if (streamedText.trim() && !isSilentReplyStream(streamedText)) {
        state.chatMessages = [
          ...state.chatMessages,
          {
            role: "assistant",
            content: [{ type: "text", text: streamedText }],
            timestamp: Date.now(),
          },
        ];
      }
    }
    const duration = state.chatStreamStartedAt ? Date.now() - state.chatStreamStartedAt : 0;
    submitTurnLogs(payload, state, duration);

    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "error") {
    const duration = state.chatStreamStartedAt ? Date.now() - state.chatStreamStartedAt : 0;
    submitTurnLogs(payload, state, duration);
    
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
