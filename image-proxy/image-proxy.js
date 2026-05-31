#!/usr/bin/env node
// image-proxy.js — Intercept Anthropic image blocks, convert via VL, forward to DeepSeek

import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeImage, validateConfig } from "./vision.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  try {
    return JSON.parse(readFileSync(join(__dirname, "config.json"), "utf-8"));
  } catch {
    return {};
  }
}

const cfg = loadConfig();

// ---- Config ------------------------------------------------
const PORT = parseInt(process.env.IMAGE_PROXY_PORT || cfg.port || "8787", 10);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || "api.deepseek.com";
const UPSTREAM_PATH = process.env.UPSTREAM_PATH || "/anthropic";
const DEBUG = process.env.DEBUG === "true";

const log = (...args) => { if (DEBUG) console.error(`[image-proxy]`, ...args); };
const warn = (...args) => console.error(`[image-proxy:WARN]`, ...args);

// ---- Helpers -----------------------------------------------
const HOP_BY_HOP = new Set([
  "connection", "transfer-encoding", "keep-alive", "te", "trailer", "upgrade"
]);

function forwardHeaders(reqHeaders) {
  const h = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    const lk = k.toLowerCase();
    if (lk === "host") continue;
    if (lk === "content-length") continue;
    if (HOP_BY_HOP.has(lk)) continue;
    h[k] = v;
  }
  h["host"] = UPSTREAM_HOST;
  return h;
}

function proxyRequest(clientReq, clientRes, modifiedBody) {
  const headers = forwardHeaders(clientReq.headers);
  const body = modifiedBody || null;

  if (body) {
    headers["content-length"] = String(Buffer.byteLength(body));
  }

  // cc-switch sends /v1/messages → forward to UPSTREAM_PATH/v1/messages
  const targetUrl = new URL(clientReq.url, "https://placeholder");
  const options = {
    hostname: UPSTREAM_HOST,
    port: 443,
    path: UPSTREAM_PATH + targetUrl.pathname + targetUrl.search,
    method: clientReq.method,
    headers,
  };

  log(`Forward ${options.method} ${options.path} (body: ${body ? body.length : 0} bytes)`);

  const upstreamReq = https.request(options, (upstreamRes) => {
    // Copy response headers (skip hop-by-hop)
    const resHeaders = {};
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      const lk = k.toLowerCase();
      if (["transfer-encoding", "connection", "keep-alive"].includes(lk)) continue;
      resHeaders[k] = v;
    }
    clientRes.writeHead(upstreamRes.statusCode, resHeaders);
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on("error", (e) => {
    warn(`Upstream error: ${e.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({
        error: { type: "proxy_error", message: `Upstream unreachable: ${e.message}` },
      }));
    } else {
      clientRes.destroy(new Error(`Upstream error mid-stream: ${e.message}`));
    }
  });

  if (body) upstreamReq.write(body);
  upstreamReq.end();
}

// ---- Image Detection & Processing -------------------------
/**
 * Find and process image blocks in the request body.
 * Returns { modifiedBody, imageCount } or null body means "no images, send original".
 */
async function processImages(rawBody) {
  // Fast path: check if body likely contains images
  if (!rawBody.includes('"image"')) return { modifiedBody: null, imageCount: 0 };

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    warn("JSON parse failed, forwarding original body");
    return { modifiedBody: null, imageCount: 0 };
  }

  const messages = parsed?.messages;
  if (!Array.isArray(messages)) return { modifiedBody: null, imageCount: 0 };

  let imageCount = 0;
  const tasks = [];

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    const content = msg?.content;
    if (!Array.isArray(content)) continue;

    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (block?.type !== "image") continue;

      const source = block?.source;
      if (source?.type !== "base64" || !source?.data) continue;

      const idx = ++imageCount;
      const mediaType = source.media_type || "image/jpeg";

      tasks.push(
        describeImage(source.data, mediaType).then((desc) => ({
          msgIndex: msgIdx,  // direct index
          blockIndex: i,
          description: desc,
          label: `【图片 ${idx}】`,
        }))
      );
    }
  }

  if (tasks.length === 0) return { modifiedBody: null, imageCount: 0 };

  // Parallel VL calls
  const startTime = DEBUG ? Date.now() : 0;
  log(`Processing ${tasks.length} image(s) in parallel...`);
  const results = await Promise.all(tasks);
  if (DEBUG) log(`VL calls completed in ${Date.now() - startTime}ms`);

  // Group results by message, then replace image blocks with text blocks
  const byMessage = {};
  for (const r of results) {
    const key = r.msgIndex;
    if (!byMessage[key]) byMessage[key] = [];
    byMessage[key].push(r);
  }

  // Per-message: replace image blocks with text, wrap with system notice framing
  for (const [msgIdx, replacements] of Object.entries(byMessage)) {
    const content = messages[parseInt(msgIdx)].content;
    // Sort by blockIndex descending for safe splice
    replacements.sort((a, b) => b.blockIndex - a.blockIndex);

    for (const r of replacements) {
      content.splice(r.blockIndex, 1, {
        type: "text",
        text: `${r.label}\n${r.description}`,
      });
    }

    // Add opening framing notice
    content.unshift({
      type: "text",
      text: "[系统提示：以下为用户粘贴图片的自动文字描述，由 VL 模型生成]",
    });
    // Add closing framing notice
    content.push({
      type: "text",
      text: "[图片描述结束]",
    });
  }

  const newBody = JSON.stringify(parsed);
  log(`Images processed: ${imageCount}, new body: ${newBody.length} bytes (was ${rawBody.length})`);
  return { modifiedBody: newBody, imageCount };
}

// ---- Server ------------------------------------------------
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
const BODY_TIMEOUT = 15_000; // 15 seconds

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
    return;
  }

  // Intercept /v1/messages for image processing
  const isMessagesEndpoint = req.url.startsWith("/v1/messages");

  if (!isMessagesEndpoint) {
    // Transparent passthrough for all other endpoints (Gemini, OpenAI, etc.)
    log(`Passthrough: ${req.method} ${req.url}`);
    req.on("end", () => proxyRequest(req, res, null));
    return;
  }

  // Body timeout: respond 408 if client sends too slowly
  req.setTimeout(BODY_TIMEOUT, () => {
    if (!res.headersSent) {
      res.writeHead(408, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "timeout", message: "Request body timed out" } }));
    }
    req.destroy();
  });

  // Buffer body with size limit
  let totalSize = 0;
  const chunks = [];
  req.on("data", (c) => {
    totalSize += c.length;
    if (totalSize > MAX_BODY_SIZE) {
      if (!res.headersSent) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "payload_too_large", message: "Request body exceeds 10 MB limit" } }));
      }
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", async () => {
    const rawBody = Buffer.concat(chunks).toString();
    log(`${req.method} ${req.url} body=${rawBody.length}B`);

    try {
      const { modifiedBody } = await processImages(rawBody);
      proxyRequest(req, res, modifiedBody || rawBody);
    } catch (e) {
      warn(`Processing error: ${e.message}`);
      // Fallback: forward original
      proxyRequest(req, res, rawBody);
    }
  });
});

// ---- Startup -----------------------------------------------
const STARTUP_TIMEOUT = 3000;

function tryStart() {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function main() {
  // Validate config
  const configError = validateConfig();
  if (configError) {
    console.error(`[image-proxy] Config error: ${configError}`);
    process.exit(1);
  }

  try {
    await tryStart();
    const provider = process.env.VISION_PROVIDER || "qwen";
    const model = process.env.VISION_MODEL || "qwen3.5-omni-plus";
    console.error(`[image-proxy] Listening on http://127.0.0.1:${PORT} → https://${UPSTREAM_HOST}${UPSTREAM_PATH}`);
    console.error(`[image-proxy] VL: ${provider}/${model}`);
  } catch (e) {
    if (e.code === "EADDRINUSE") {
      // Check if existing process is healthy
      http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
        if (res.statusCode === 200) {
          console.error("[image-proxy] Already running (health check passed), exiting.");
          process.exit(0);
        } else {
          console.error(`[image-proxy] Port ${PORT} occupied by non-proxy process. Exiting.`);
          process.exit(1);
        }
      }).on("error", () => {
        console.error(`[image-proxy] Port ${PORT} occupied, health check failed. Exiting.`);
        process.exit(1);
      }).setTimeout(STARTUP_TIMEOUT, () => {
        console.error("[image-proxy] Health check timed out. Exiting.");
        process.exit(1);
      });
      return;
    }
    console.error(`[image-proxy] Failed to start: ${e.message}`);
    process.exit(1);
  }
}

main();
