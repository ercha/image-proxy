#!/usr/bin/env node
// install.js — Interactive setup for image-proxy (Claude Code Vision Skill)

import { writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";

function ask(rl, prompt, sensitive) {
  return new Promise((resolve) => {
    if (sensitive && process.stdin.isTTY) {
      // Simple masking for API key
      const stdin = process.stdin;
      const prevRaw = stdin.isRaw;
      stdin.setRawMode(true);
      let buf = "";
      process.stdout.write(prompt);
      const onData = (c) => {
        c = c.toString();
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(prevRaw);
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(buf.trim());
        } else if (c === "\x08" || c === "\x7f") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\x08 \x08");
          }
        } else if (c === "\x03") {
          process.stdout.write("\n");
          process.exit(0);
        } else {
          buf += c;
          process.stdout.write("*");
        }
      };
      stdin.on("data", onData);
    } else {
      rl.question(prompt, resolve);
    }
  });
}

async function main() {
  console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║   Image Proxy — Claude Code Vision Skill    ║${RESET}`);
  console.log(`${BOLD}${CYAN}║   安装配置向导                               ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════╝${RESET}\n`);

  // 1. Check prerequisites
  const nodeVer = process.versions.node.split(".").map(Number);
  if (nodeVer[0] < 18) {
    console.log(`${RED}错误: 需要 Node.js ≥ 18，当前版本: ${process.versions.node}${RESET}`);
    process.exit(1);
  }
  console.log(`   Node.js ${GREEN}v${process.versions.node}${RESET} ✓`);

  // 2. Check cc-switch
  try {
    const result = await fetch("http://127.0.0.1:15721/health");
    if (result.ok) {
      console.log(`   cc-switch ${GREEN}运行中 (端口 15721)${RESET} ✓`);
    }
  } catch {
    console.log(`   cc-switch ${YELLOW}未检测到${RESET} — 请确保已安装并运行 cc-switch`);
  }

  // 3. Determine install directory
  const targetDir = join(homedir(), ".claude", "scripts", "image-proxy");
  console.log(`   安装目录: ${targetDir}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // 4. Collect config
  console.log(`\n${BOLD}--- VL Provider 配置 ---${RESET}`);
  console.log("   支持所有兼容 OpenAI /chat/completions 的 VL 模型\n");

  const provider = (await ask(rl, "Provider [qwen]: ")) || "qwen";
  const apiKey = (await ask(rl, "API Key: ", true)) || "";

  let defaultModel = "qwen3.5-omni-plus";
  if (provider === "openai") defaultModel = "gpt-4o";
  const model = (await ask(rl, `Model [${defaultModel}]: `)) || defaultModel;

  let defaultBaseUrl = "";
  if (provider === "qwen") defaultBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
  else if (provider === "openai") defaultBaseUrl = "https://api.openai.com/v1";
  let baseUrlPrompt = `Base URL`;
  if (defaultBaseUrl) baseUrlPrompt += ` [${defaultBaseUrl}]`;
  baseUrlPrompt += ": ";
  const baseUrl = (await ask(rl, baseUrlPrompt)) || defaultBaseUrl;

  const portStr = (await ask(rl, "代理端口 [8787]: ")) || "8787";

  const promptText =
    (await ask(rl, `识别提示词 [请用中文详细描述这张图片的内容。]: `)) ||
    "请用中文详细描述这张图片的内容。";

  // 5. Build config
  const config = { provider, model, port: parseInt(portStr, 10), prompt: promptText };
  if (apiKey) config.api_key = apiKey;
  if (baseUrl) config.base_url = baseUrl;

  console.log(`\n${BOLD}--- 即将写入的配置 ---${RESET}`);
  console.log(JSON.stringify(config, null, 2));

  const confirm = (await ask(rl, "\n确认写入? [Y/n]: ")) || "Y";
  if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "") {
    console.log("已取消。");
    rl.close();
    process.exit(0);
  }

  // 6. Write config.json
  mkdirSync(targetDir, { recursive: true });
  const configPath = join(targetDir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`\n${GREEN}✓ config.json 已写入${RESET}`);

  // 7. Copy source files
  const sourceDir = __dirname;
  const files = ["image-proxy.js", "vision.js", "package.json"];
  for (const f of files) {
    const src = join(sourceDir, f);
    const dst = join(targetDir, f);
    if (existsSync(src)) {
      copyFileSync(src, dst);
      console.log(`  复制: ${f}`);
    }
  }

  // 8. Print cc-switch Common Config guidance
  console.log(`\n${BOLD}${YELLOW}--- cc-switch 持久化设置 ---${RESET}`);
  console.log(`\n为避免 cc-switch 切换供应商时覆盖配置，请将以下内容`);
  console.log(`添加到 cc-switch UI → Common Config：\n`);
  console.log(`${CYAN}  hooks:${RESET}`);
  console.log(`${CYAN}    SessionStart:${RESET}`);
  console.log(`${CYAN}      - command: node ${join(targetDir, "image-proxy.js")}${RESET}`);
  console.log(`${CYAN}        shell: powershell  (Windows) 或省略 (macOS/Linux)${RESET}`);
  console.log(`${CYAN}        type: command${RESET}`);
  console.log(`\n操作步骤:`);
  console.log(`  1. 打开 cc-switch UI → 设置 → Common Config`);
  console.log(`  2. 添加 hooks.SessionStart（如上所示）`);
  console.log(`  3. 保存并重启 cc-switch\n`);

  // 9. Test start
  console.log(`${BOLD}--- 启动测试 ---${RESET}`);
  const { spawn } = await import("node:child_process");
  const child = spawn("node", [join(targetDir, "image-proxy.js")], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  await new Promise((r) => setTimeout(r, 2000));

  try {
    const health = await fetch(`http://127.0.0.1:${config.port}/health`);
    const data = await health.json();
    if (data.status === "ok") {
      console.log(`${GREEN}✓ image-proxy 启动成功 (端口 ${config.port})${RESET}`);
    }
  } catch {
    console.log(
      `${YELLOW}⚠ 启动验证失败 — 请手动运行: node ${join(targetDir, "image-proxy.js")}${RESET}`
    );
  }

  console.log(`\n${BOLD}${GREEN}安装完成!${RESET}\n`);
  rl.close();
}

main().catch((e) => {
  console.error(`${RED}安装失败: ${e.message}${RESET}`);
  process.exit(1);
});
