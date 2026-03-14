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
              const logFile = path.resolve(here, "chat-logs", "dialogue.jsonl");
              try {
                if (fs.existsSync(logFile)) {
                  const content = fs.readFileSync(logFile, "utf-8");
                  const lines = content.split("\\n").filter((line) => line.trim().length > 0);
                  const logs = lines.map((line) => JSON.parse(line));
                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify({ logs }));
                } else {
                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify({ logs: [] }));
                }
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
