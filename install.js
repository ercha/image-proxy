#!/usr/bin/env node
// install.js — Interactive setup for image-proxy

import { writeFileSync, mkdirSync, copyFileSync, existsSync, readFileSync } from "node:fs";
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
  console.log(`${BOLD}${CYAN}║        image-proxy — 安装配置向导           ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════╝${RESET}\n`);

  // 1. Check prerequisites
  const nodeVer = process.versions.node.split(".").map(Number);
  if (nodeVer[0] < 18) {
    console.log(`${RED}错误: 需要 Node.js ≥ 18，当前版本: ${process.versions.node}${RESET}`);
    process.exit(1);
  }
  console.log(`   Node.js ${GREEN}v${process.versions.node}${RESET} ✓`);

  // 2. Determine install directory
  const targetDir = join(homedir(), ".claude", "scripts", "image-proxy");
  console.log(`   安装目录: ${targetDir}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // 3. Collect VL Provider config
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

  // 4. Build config
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

  // 5. Write config.json
  mkdirSync(targetDir, { recursive: true });
  const configPath = join(targetDir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`\n${GREEN}✓ config.json 已写入${RESET}`);

  // 6. Copy source files
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

  // 7. settings.json configuration guidance
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const startupCmd = process.platform === "win32"
    ? `Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList '${join(targetDir, "image-proxy.js")}'`
    : `node '${join(targetDir, "image-proxy.js")}' &`;

  console.log(`\n${BOLD}${YELLOW}--- settings.json 配置 ---${RESET}`);
  console.log(`\n请在 ${CYAN}~/.claude/settings.json${RESET} 中添加以下内容：\n`);
  console.log(`${CYAN}{${RESET}`);
  console.log(`${CYAN}  "env": {${RESET}`);
  console.log(`${CYAN}    "ANTHROPIC_AUTH_TOKEN": "sk-your-deepseek-api-key",${RESET}`);
  console.log(`${CYAN}    "ANTHROPIC_BASE_URL": "http://127.0.0.1:${config.port}"${RESET}`);
  console.log(`${CYAN}  }${RESET}`);
  console.log(`${CYAN}}${RESET}`);

  console.log(`\n如需自动启动 image-proxy，可额外添加 SessionStart hook：\n`);
  console.log(`${CYAN}"hooks": {${RESET}`);
  console.log(`${CYAN}  "SessionStart": [{${RESET}`);
  console.log(`${CYAN}    "hooks": [{${RESET}`);
  console.log(`${CYAN}      "command": "${startupCmd}",${RESET}`);
  if (process.platform === "win32") {
    console.log(`${CYAN}      "shell": "powershell",${RESET}`);
  }
  console.log(`${CYAN}      "type": "command"${RESET}`);
  console.log(`${CYAN}    }]${RESET}`);
  console.log(`${CYAN}  }]${RESET}`);
  console.log(`${CYAN}}${RESET}`);

  // 8. Try auto-configure settings.json
  try {
    let settings = {};
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    }
    const autoConfirm = (await ask(rl,
      `\n${YELLOW}是否自动写入 settings.json？(仅添加缺少的字段，不覆盖已有配置) [y/N]: ${RESET}`
    )) || "n";
    if (autoConfirm.toLowerCase() === "y") {
      if (!settings.env) settings.env = {};
      if (!settings.env.ANTHROPIC_BASE_URL) {
        settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${config.port}`;
      }
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionStart) {
        const hook = {
          hooks: [{
            command: startupCmd,
            type: "command"
          }]
        };
        if (process.platform === "win32") hook.hooks[0].shell = "powershell";
        settings.hooks.SessionStart = [hook];
      }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      console.log(`${GREEN}✓ settings.json 已更新${RESET}`);
    }
  } catch (e) {
    console.log(`${YELLOW}⚠ 自动写入 settings.json 失败: ${e.message}${RESET}`);
  }

  // 9. Test start
  console.log(`\n${BOLD}--- 启动测试 ---${RESET}`);
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
