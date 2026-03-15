import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";

type ChatHistoryState = {
  logs: any[];
  loading: boolean;
  error: string | null;
  detailLog: any | null;
  currentPage: number;
  pageSize: number;
};

const localState: ChatHistoryState = {
  logs: [],
  loading: false,
  error: null,
  detailLog: null,
  currentPage: 0,
  pageSize: 10,
};

let initialized = false;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "object" && c !== null && "text" in c ? (c as any).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractLogDetails(log: any) {
  // 1. 获取 userInput
  let userInput: string = log.userInput || "—";
  if (userInput === "—" && Array.isArray(log.history)) {
    for (let i = log.history.length - 1; i >= 0; i--) {
      const msg = log.history[i] as any;
      if (msg?.role === "user") {
        userInput = extractText(msg.content) || "—";
        break;
      }
    }
  }

  // 2. 获取 modelReply
  // 优先从 log.message 提取，回退到 history 最后一条 assistant 消息
  let modelReply = "—";
  const extractContentText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return (content as any[])
      .filter((c: any) => c?.type === "text" && c.text)
      .map((c: any) => c.text as string)
      .join("\n");
  };
  if (log.message) {
    if (typeof log.message.text === "string" && log.message.text) {
      modelReply = log.message.text;
    } else if (Array.isArray(log.message.content)) {
      const t = extractContentText(log.message.content);
      if (t) modelReply = t;
    }
  }
  // 若 log.message 不存在或无文本，从 history 找最后一条 assistant text
  if (modelReply === "—" && Array.isArray(log.history)) {
    for (let i = log.history.length - 1; i >= 0; i--) {
      const msg = log.history[i] as any;
      if (!msg || msg.role !== "assistant") continue;
      // 跳过纯工具调用消息（content 全是 toolCall）
      const txt = extractContentText(msg.content);
      if (txt && txt.trim()) {
        modelReply = txt.trim();
        break;
      }
    }
  }

  // 3. 获取 skillsUsed
  // 优先读 log.skillsUsed（新格式直接存储），否则从 history 提取
  let skillsUsed: string[] = [];
  if (Array.isArray(log.skillsUsed) && log.skillsUsed.length > 0) {
    skillsUsed = log.skillsUsed as string[];
  } else if (Array.isArray(log.history)) {
    for (const msg of log.history) {
      if (!msg) continue;
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if ((c?.type === "toolCall" || c?.type === "tool_use") && c.name) {
            skillsUsed.push(c.name);
          }
        }
      }
      if (msg.type === "toolCall" && msg.name) {
        skillsUsed.push(msg.name);
      }
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          if (tc?.function?.name) {
            skillsUsed.push(tc.function.name);
          }
        }
      }
    }
  }

  // 4. 获取 tokens, model, provider
  let inputTokens: number | string = "—";
  let outputTokens: number | string = "—";
  let model: string | null = (log.model as string | null) ?? null;
  let provider: string | null = (log.provider as string | null) ?? null;

  // 优先读新格式 log.tokenUsage 直接字段（由 submitTurnLogs 填充）
  if (log.tokenUsage) {
    const tu = log.tokenUsage as any;
    const inp = tu.inputTokens ?? tu.input ?? tu.input_tokens;
    const out = tu.outputTokens ?? tu.output ?? tu.output_tokens;
    if (typeof inp === "number") inputTokens = inp;
    if (typeof out === "number") outputTokens = out;
  }

  // 若新格式无数据，回退到 log.message?.usage
  if (inputTokens === "—" || outputTokens === "—") {
    let usage = log.message?.usage;

    if (Array.isArray(log.history)) {
      let sumInp = 0;
      let sumOut = 0;
      let foundUsage = false;

      for (let i = log.history.length - 1; i >= 0; i--) {
        const msg = log.history[i];
        if (!msg) continue;
        if (msg.role === "user") break;

        if (msg.usage) {
          const inp2 = msg.usage.input ?? msg.usage.inputTokens ?? msg.usage.input_tokens ?? 0;
          const out2 = msg.usage.output ?? msg.usage.outputTokens ?? msg.usage.output_tokens ?? 0;
          if (inp2 > 0 || out2 > 0) {
            foundUsage = true;
            sumInp += inp2;
            sumOut += out2;
          }
        }

        if (!model && typeof msg.model === "string") model = msg.model;
        if (!provider && typeof msg.provider === "string") provider = msg.provider;
      }

      if (!usage && foundUsage) {
        usage = { input: sumInp, output: sumOut };
      }
    }

    if (usage) {
      const inp = usage.input ?? usage.inputTokens ?? usage.input_tokens;
      const out = usage.output ?? usage.outputTokens ?? usage.output_tokens;
      if (inputTokens === "—" && inp !== undefined && inp !== null) inputTokens = inp;
      if (outputTokens === "—" && out !== undefined && out !== null) outputTokens = out;
    }
  }

  return {
    userInput,
    modelReply,
    skillsUsed: Array.from(new Set(skillsUsed)),
    inputTokens,
    outputTokens,
    model,
    provider,
  };
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/**
 * 当 log.durationMs 为 0 时，尝试从 history 中找到最后一个 user 消息和最后一个 assistant 消息
 * 的 timestamp 差值来推算实际耗时。
 */
function resolveDuration(log: any): number | undefined {
  const d = log.durationMs as number | undefined;
  if (d !== undefined && d !== null && d > 0) return d;
  // 降级：用 history 时间戳推算
  if (Array.isArray(log.history)) {
    let lastUserTs = 0;
    let lastAssistantTs = 0;
    for (const msg of log.history) {
      if (!msg || typeof msg.timestamp !== "number") continue;
      if (msg.role === "user") lastUserTs = msg.timestamp;
      if (msg.role === "assistant") lastAssistantTs = msg.timestamp;
    }
    if (lastUserTs > 0 && lastAssistantTs > lastUserTs) {
      return lastAssistantTs - lastUserTs;
    }
  }
  return d;
}

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) return "—";
  if (ms === 0) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function fetchLogs(requestUpdate: () => void) {
  if (localState.loading) return;
  localState.loading = true;
  localState.error = null;
  requestUpdate();
  try {
    const res = await fetch("/api/get-chat-logs");
    const json = await res.json();
    if (Array.isArray(json.logs)) {
      localState.logs = json.logs.reverse();
      localState.currentPage = 0;
      localState.detailLog = null;
    } else {
      localState.error = json.error || "加载失败";
    }
  } catch (e) {
    localState.error = String(e);
  } finally {
    localState.loading = false;
    requestUpdate();
  }
}

function renderDetailModal(log: any, update: () => void) {
  const d = extractLogDetails(log);
  const time = new Date(log.timestamp).toLocaleString("zh-CN");

  return html`
    <div
      style="
        position:fixed; inset:0; z-index:9999;
        background: rgba(0,0,0,0.55);
        backdrop-filter: blur(4px);
        display:flex; align-items:center; justify-content:center;
        animation: fadeIn 0.15s ease;
      "
      @click=${(e: Event) => { if (e.target === e.currentTarget) { localState.detailLog = null; update(); } }}
    >
      <div style="
        background: var(--bg, #18181b);
        border: 1px solid var(--border-color, #3f3f46);
        border-radius: 12px;
        width: min(780px, 94vw);
        max-height: 86vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 24px 64px rgba(0,0,0,0.5);
        animation: slideUp 0.2s ease;
        overflow: hidden;
      ">
        <div style="
          display:flex; align-items:center; justify-content:space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-color, #3f3f46);
          background: var(--bg-inset, #1c1c1f);
        ">
          <div>
            <div style="font-weight:600; font-size:15px;">对话详情</div>
            <div style="font-size:12px; color:var(--fg-muted, #71717a); margin-top:2px;">${time}</div>
          </div>
          <button
            style="
              background:transparent; border:none; cursor:pointer;
              color:var(--fg-muted, #71717a); padding:4px; border-radius:6px;
              display:flex; align-items:center;
            "
            title="关闭"
            @click=${() => { localState.detailLog = null; update(); }}
          >${icons.x}</button>
        </div>

        <div style="
          display:flex; gap:16px; flex-wrap:wrap;
          padding: 12px 20px;
          border-bottom: 1px solid var(--border-color, #3f3f46);
          background: var(--bg-inset, #1c1c1f);
          font-size: 12px;
        ">
          <span style="display:flex;align-items:center;gap:5px;">
            <span style="color:var(--fg-muted);">耗时</span>
            <strong>${fmtDuration(resolveDuration(log))}</strong>
          </span>
          <span style="display:flex;align-items:center;gap:5px;">
            <span style="color:var(--fg-muted);">输入 Token</span>
            <strong>${d.inputTokens}</strong>
          </span>
          <span style="display:flex;align-items:center;gap:5px;">
            <span style="color:var(--fg-muted);">输出 Token</span>
            <strong>${d.outputTokens}</strong>
          </span>
          <span style="display:flex;align-items:center;gap:5px;">
            <span style="color:var(--fg-muted);">状态</span>
            <span style="
              padding:1px 8px; border-radius:4px; font-weight:600;
              background:${log.endState === "final" ? "rgba(34,197,94,0.15)" : log.endState === "error" ? "rgba(239,68,68,0.15)" : "rgba(250,204,21,0.15)"};
              color:${log.endState === "final" ? "#22c55e" : log.endState === "error" ? "#ef4444" : "#ca8a04"};
            ">${log.endState ?? "unknown"}</span>
          </span>
          ${d.skillsUsed.length > 0 ? html`
            <span style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
              <span style="color:var(--fg-muted);">Skills</span>
              ${d.skillsUsed.map(s => html`<span style="background:var(--bg);border:1px solid var(--border-color);border-radius:4px;padding:1px 7px;font-size:11px;">${s}</span>`)}
            </span>
          ` : ""}
        </div>

        <div style="flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:20px;">
          <div>
            <div style="
              display:flex; align-items:center; gap:8px;
              font-size:12px; font-weight:600; color:var(--fg-muted);
              text-transform:uppercase; letter-spacing:0.05em;
              margin-bottom:8px;
            ">
              <span style="width:8px;height:8px;border-radius:50%;background:#3b82f6;display:inline-block;"></span>
              用户输入
            </div>
            <div style="
              background: rgba(59,130,246,0.06);
              border: 1px solid rgba(59,130,246,0.2);
              border-radius: 8px;
              padding: 14px 16px;
              font-size:14px;
              line-height:1.7;
              white-space:pre-wrap;
              word-break:break-word;
            ">${d.userInput}</div>
          </div>

          <div>
            <div style="
              display:flex; align-items:center; gap:8px;
              font-size:12px; font-weight:600; color:var(--fg-muted);
              text-transform:uppercase; letter-spacing:0.05em;
              margin-bottom:8px;
            ">
              <span style="width:8px;height:8px;border-radius:50%;background:#a855f7;display:inline-block;"></span>
              模型回复
            </div>
            <div style="
              background: rgba(168,85,247,0.06);
              border: 1px solid rgba(168,85,247,0.2);
              border-radius: 8px;
              padding: 14px 16px;
              font-size:14px;
              line-height:1.7;
              white-space:pre-wrap;
              word-break:break-word;
            ">${d.modelReply}</div>
          </div>
        </div>
      </div>
    </div>
    <style>
      @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
      @keyframes slideUp { from { transform:translateY(20px); opacity:0 } to { transform:translateY(0); opacity:1 } }
    </style>
  `;
}

export function renderChatHistory(props: { onRequestUpdate?: () => void }) {
  const update = props.onRequestUpdate ?? (() => {});

  if (!initialized) {
    initialized = true;
    fetchLogs(update);
  }

  const totalLogs = localState.logs.length;
  const totalPages = Math.max(1, Math.ceil(totalLogs / localState.pageSize));
  const start = localState.currentPage * localState.pageSize;
  const pageLogs = localState.logs.slice(start, start + localState.pageSize);

  return html`
    ${localState.detailLog ? renderDetailModal(localState.detailLog, update) : ""}

    <div class="view-content" style="padding: 0 24px 24px;">
      <div style="display:flex; align-items:center; justify-content:space-between; padding: 16px 0 12px;">
        <span style="color:var(--fg-muted); font-size:13px;">
          ${t("subtitles.chatHistory") || "本地保存的完整对话历史记录"}${totalLogs > 0 ? `，共 ${totalLogs} 条` : ""}
        </span>
        <button class="btn btn--sm" @click=${() => { initialized = false; fetchLogs(update); }}>
          ${icons.refresh}&nbsp;刷新
        </button>
      </div>

      ${localState.loading
        ? html`<div style="padding:40px; text-align:center; color:var(--fg-muted);">加载中…</div>`
        : localState.error
        ? html`<div class="callout danger">${localState.error}</div>`
        : totalLogs === 0
        ? html`<div class="callout info">暂无对话记录，请先发送消息后再查看。</div>`
        : html`
            <div style="overflow-x:auto; border:1px solid var(--border-color); border-radius:8px;">
              <table style="width:100%; border-collapse:collapse; font-size:13px;">
                <thead>
                  <tr style="background:var(--bg-inset); border-bottom:1px solid var(--border-color);">
                    <th style="padding:10px 12px; text-align:left;">#</th>
                    <th style="padding:10px 12px; text-align:left; white-space:nowrap;">输入时间</th>
                    <th style="padding:10px 12px; text-align:left; min-width:140px;">输入内容</th>
                    <th style="padding:10px 12px; text-align:left; min-width:140px;">模型回复</th>
                    <th style="padding:10px 12px; text-align:left;">使用的 Skills</th>
                    <th style="padding:10px 12px; text-align:right; white-space:nowrap;">耗时</th>
                    <th style="padding:10px 12px; text-align:right; white-space:nowrap;">输入 Token</th>
                    <th style="padding:10px 12px; text-align:right; white-space:nowrap;">输出 Token</th>
                    <th style="padding:10px 12px; text-align:center; white-space:nowrap;">状态</th>
                    <th style="padding:10px 12px; text-align:center;">操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${pageLogs.map((log, i) => {
                    const d = extractLogDetails(log);
                    return html`
                      <tr style="border-bottom:1px solid var(--border-color);">
                        <td style="padding:10px 12px; color:var(--fg-muted);">${totalLogs - (start + i)}</td>
                        <td style="padding:10px 12px; white-space:nowrap; color:var(--fg-muted); font-size:12px;">
                          ${new Date(log.timestamp).toLocaleString("zh-CN")}
                        </td>
                        <td style="padding:10px 12px; max-width:160px;" title="${d.userInput}">
                          ${truncate(d.userInput, 35)}
                        </td>
                        <td style="padding:10px 12px; max-width:160px;" title="${d.modelReply}">
                          ${truncate(d.modelReply, 35)}
                        </td>
                        <td style="padding:10px 12px;">
                          ${d.skillsUsed.length > 0
                            ? d.skillsUsed.map(s => html`<span style="display:inline-block;background:var(--bg-inset);border:1px solid var(--border-color);border-radius:3px;padding:1px 5px;margin:1px;font-size:11px;">${s}</span>`)
                            : html`<span style="color:var(--fg-muted);">—</span>`}
                        </td>
                        <td style="padding:10px 12px; text-align:right; white-space:nowrap;">${fmtDuration(resolveDuration(log))}</td>
                        <td style="padding:10px 12px; text-align:right;">${d.inputTokens}</td>
                        <td style="padding:10px 12px; text-align:right;">${d.outputTokens}</td>
                        <td style="padding:10px 12px; text-align:center;">
                          <span style="
                            display:inline-block; padding:2px 8px; border-radius:4px;
                            font-size:11px; font-weight:500;
                            background:${log.endState === "final" ? "rgba(34,197,94,0.12)" : log.endState === "error" ? "rgba(239,68,68,0.12)" : "rgba(250,204,21,0.12)"};
                            color:${log.endState === "final" ? "#22c55e" : log.endState === "error" ? "#ef4444" : "#ca8a04"};
                          ">${log.endState ?? "unknown"}</span>
                        </td>
                        <td style="padding:10px 12px; text-align:center;">
                          <button
                            class="btn btn--sm"
                            style="font-size:12px; padding:3px 10px;"
                            @click=${() => { localState.detailLog = log; update(); }}
                          >详情</button>
                        </td>
                      </tr>
                    `;
                  })}
                </tbody>
              </table>
            </div>

            <div style="display:flex; align-items:center; justify-content:space-between; margin-top:12px;">
              <span style="font-size:13px; color:var(--fg-muted);">
                共 ${totalLogs} 条 · 第 ${localState.currentPage + 1} / ${totalPages} 页
              </span>
              <div style="display:flex; gap:8px;">
                <button class="btn btn--sm"
                  ?disabled=${localState.currentPage === 0}
                  @click=${() => { localState.currentPage--; update(); }}>上一页</button>
                <button class="btn btn--sm"
                  ?disabled=${localState.currentPage >= totalPages - 1}
                  @click=${() => { localState.currentPage++; update(); }}>下一页</button>
              </div>
            </div>
          `}
    </div>
  `;
}
