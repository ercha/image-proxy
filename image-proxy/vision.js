// vision.js — Pluggable VL provider adapter
// All providers use OpenAI-compatible /chat/completions format.
// Config priority: env vars > config.json > defaults

import https from "node:https";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  try {
    return JSON.parse(readFileSync(join(__dirname, "config.json"), "utf-8"));
  } catch {
    return {};
  }
}

const cfg = loadConfig();

const PROVIDER = process.env.VISION_PROVIDER || cfg.provider || "qwen";
const API_KEY = process.env.VISION_API_KEY || cfg.api_key || "";
const MODEL = process.env.VISION_MODEL || cfg.model || "qwen3.5-omni-plus";
const DEFAULT_PROMPT =
  process.env.VISION_PROMPT || cfg.prompt || "请用中文详细描述这张图片的内容。";
const DEBUG = process.env.DEBUG === "true";

const log = (...args) => { if (DEBUG) console.error("[vision]", ...args); };

const DEFAULT_BASE_URLS = {
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  openai: "https://api.openai.com/v1",
};

function resolveBaseUrl() {
  if (process.env.VISION_BASE_URL) return process.env.VISION_BASE_URL;
  if (cfg.base_url) return cfg.base_url;
  if (DEFAULT_BASE_URLS[PROVIDER]) return DEFAULT_BASE_URLS[PROVIDER];
  return null;
}

async function describeImageOnce(imageBase64, mediaType, prompt) {
  if (!API_KEY) {
    return "[图片识别失败: VISION_API_KEY 未配置]";
  }

  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    return "[图片识别失败: VISION_BASE_URL 未配置（provider=custom 时必填）]";
  }

  let apiUrl;
  try {
    apiUrl = new URL(baseUrl.replace(/\/?$/, "/") + "chat/completions");
  } catch {
    return "[图片识别失败: VISION_BASE_URL 格式无效]";
  }

  const body = JSON.stringify({
    model: MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:${mediaType};base64,${imageBase64}`,
            },
          },
          { type: "text", text: prompt || DEFAULT_PROMPT },
        ],
      },
    ],
    stream: false,
    max_tokens: 1024,
  });

  const transport = apiUrl.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    let settled = false;
    const done = (text) => { if (!settled) { settled = true; resolve(text); } };

    const req = transport.request(
      apiUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        const startTime = DEBUG ? Date.now() : 0;
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (DEBUG) log(`VL response: ${res.statusCode} ${Date.now() - startTime}ms`);
          if (res.statusCode >= 400) {
            return done(`[图片识别失败: HTTP ${res.statusCode}]`);
          }
          try {
            const text = JSON.parse(data)?.choices?.[0]?.message?.content;
            done(text || "[图片识别失败: 空响应]");
          } catch {
            done("[图片识别失败: 响应解析错误]");
          }
        });
      }
    );
    req.on("error", (e) => done(`[图片识别失败: ${e.message}]`));
    req.on("socket", (socket) => {
      if (!socket) return;
      socket.setTimeout(30000);
      socket.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });
    });
    req.write(body);
    req.end();
  });
}

function isRetryableError(text) {
  if (!text || !text.startsWith("[图片识别失败:")) return false;
  if (text.startsWith("[图片识别失败: HTTP 5")) return true;
  if (text.startsWith("[图片识别失败: HTTP 4")) return false;
  if (text === "[图片识别失败: 空响应]") return false;
  if (text === "[图片识别失败: 响应解析错误]") return false;
  if (text.startsWith("[图片识别失败: VISION_")) return false;
  return true;
}

export async function describeImage(imageBase64, mediaType, prompt) {
  const result = await describeImageOnce(imageBase64, mediaType, prompt);
  if (isRetryableError(result)) {
    log("Retrying after transient failure:", result);
    await new Promise((r) => setTimeout(r, 1000));
    return describeImageOnce(imageBase64, mediaType, prompt);
  }
  return result;
}

export function validateConfig() {
  if (!API_KEY) return "VISION_API_KEY is not set (set in config.json or env)";
  if (PROVIDER === "custom" && !resolveBaseUrl()) {
    return "VISION_PROVIDER=custom requires VISION_BASE_URL (set in config.json or env)";
  }
  return null;
}
