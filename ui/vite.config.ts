import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  return {
    base,
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    build: {
      outDir: path.resolve(here, "../dist/control-ui"),
      emptyOutDir: true,
      sourcemap: true,
      // Keep CI/onboard logs clean; current control UI chunking is intentionally above 500 kB.
      chunkSizeWarningLimit: 1024,
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
    },
    plugins: [
      {
        name: "control-ui-dev-stubs",
        configureServer(server) {
          server.middlewares.use("/api/save-chat", (req, res) => {
            if (req.method === "POST") {
              let body = "";
              req.on("data", (chunk) => {
                body += chunk.toString();
              });
              req.on("end", () => {
                try {
                  const data = JSON.parse(body);
                  const logDir = path.resolve(here, "chat-logs");
                  if (!fs.existsSync(logDir)) {
                    fs.mkdirSync(logDir, { recursive: true });
                  }
                  const logFile = path.resolve(logDir, "dialogue.jsonl");
                  fs.appendFileSync(logFile, JSON.stringify(data) + "\\n");
                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify({ success: true }));
                } catch (e) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: String(e) }));
                }
              });
            } else {
              res.statusCode = 405;
              res.end();
            }
          });
          server.middlewares.use("/api/get-chat-logs", (req, res) => {
            if (req.method === "GET") {
              try {
                const os = require("node:os");
                const sessionsDir = path.join(os.homedir(), ".openclaw", "agents", "main", "sessions");
                const logs = [];
                
                if (fs.existsSync(sessionsDir)) {
                  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
                  const allMessagesById = new Map();
                  const allUserMessages = [];
                  
                  for (const file of files) {
                    const content = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
                    const lines = content.split("\n").filter((l) => l.trim().length > 0);
                    for (const line of lines) {
                      try {
                        const parsed = JSON.parse(line);
                        if (parsed.id) allMessagesById.set(parsed.id, parsed);
                        if (parsed.type === "message" && parsed.message?.role === "user") {
                          allUserMessages.push(parsed);
                        }
                      } catch (e) {}
                    }
                  }
                  
                  allUserMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                  
                  for (const uMsg of allUserMessages) {
                    let currentId = uMsg.id;
                    const history = [uMsg.message];
                    let childMsg;
                    let lastMsg = uMsg;
                    let finalAssistantMsg = null;
                    
                    do {
                      childMsg = Array.from(allMessagesById.values()).find((m) => m.parentId === currentId);
                      if (childMsg) {
                        if (childMsg.type === "message") {
                          if (childMsg.message?.role === "user") break;
                          history.push(childMsg.message);
                          if (childMsg.message?.role === "assistant") {
                            finalAssistantMsg = childMsg;
                          }
                        }
                        currentId = childMsg.id;
                        lastMsg = childMsg;
                      }
                    } while (childMsg);
                    
                    const durationMs = new Date(lastMsg.timestamp).getTime() - new Date(uMsg.timestamp).getTime();
                    logs.push({
                      timestamp: new Date(uMsg.timestamp).getTime(),
                      durationMs: durationMs,
                      runId: uMsg.id,
                      sessionKey: "agent:main:main",
                      endState: "final",
                      userInput: uMsg.message?.content?.[0]?.text || "",
                      message: finalAssistantMsg ? finalAssistantMsg.message : null,
                      skillsUsed: [],
                      tokenUsage: null,
                      history: history
                    });
                  }
                }
                
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ logs }));
              } catch (e) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: String(e) }));
              }
            } else {
              res.statusCode = 405;
              res.end();
            }
          });
          server.middlewares.use("/__openclaw/control-ui-config.json", (_req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                basePath: "/",
                assistantName: "",
                assistantAvatar: "",
                assistantAgentId: "",
              }),
            );
          });
        },
      },
    ],
  };
});
