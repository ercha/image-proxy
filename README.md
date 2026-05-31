# image-proxy

让 Claude Code「看见」图片 — 一个零外部依赖的 Node.js 代理，自动拦截 Anthropic 格式请求中的图片块，调用视觉语言模型（VL Model）识别为文字描述，再转发给上游 LLM。

---

## 目录

- [image-proxy](#image-proxy)
  - [目录](#目录)
  - [工作原理](#工作原理)
  - [快速开始](#快速开始)
  - [前置依赖](#前置依赖)
  - [交互式安装](#交互式安装)
  - [配置文件详解](#配置文件详解)
    - [配置优先级](#配置优先级)
    - [完整配置项](#完整配置项)
    - [config.json 示例](#configjson-示例)
  - [与 cc-switch 配合使用](#与-cc-switch-配合使用)
    - [为什么需要 Common Config？](#为什么需要-common-config)
    - [配置步骤](#配置步骤)
    - [验证是否生效](#验证是否生效)
  - [支持的 VL Provider 矩阵](#支持的-vl-provider-矩阵)
  - [独立运行（不使用 cc-switch）](#独立运行不使用-cc-switch)
  - [调试与日志](#调试与日志)
  - [常见问题](#常见问题)
    - [Q: 图片识别的效果如何？](#q-图片识别的效果如何)
    - [Q: 多张图片会串行处理吗？](#q-多张图片会串行处理吗)
    - [Q: 图片太大怎么办？](#q-图片太大怎么办)
    - [Q: 支持流式响应吗？](#q-支持流式响应吗)
    - [Q: 会不会影响不带图片的普通对话？](#q-会不会影响不带图片的普通对话)
    - [Q: VL 模型调用失败时怎么处理？](#q-vl-模型调用失败时怎么处理)
  - [项目结构](#项目结构)
  - [许可](#许可)

---

## 工作原理

```
┌──────────────┐                                 ┌─────────────────┐
│  Claude Code │ ──────────────────────────────→ │    cc-switch     │
│              │   http://127.0.0.1:15721        │  本地路由 (15721)  │
│              │                                 │                  │
└──────────────┘                                  └────────┬────────┘
                                                           │
                                        Anthropic→OpenAI   │
                                          格式转换后转发    │
                                                           ▼
                                                 ┌─────────────────┐
                                                 │  image-proxy     │
                                                 │  (端口 8787)     │
                                                 │                  │
                                                 │ 1. 扫描 body     │
                                                 │ 2. 检测 image    │
                                                 │ 3. VL 模型识别    │
                                                 │ 4. 替换为文字     │
                                                 └────────┬────────┘
                                                          │
                                                          ▼
                                                 ┌─────────────────┐
                                                 │  DeepSeek /      │
                                                 │  其他 LLM API    │
                                                 └─────────────────┘
```

**核心处理流程：**

1. 拦截所有发往 `/v1/messages` 的 POST 请求
2. 解析 JSON body，扫描 `messages[].content[]` 中 `type: "image"` 的 block
3. 对每张图片并行调用 VL 模型的 `/chat/completions` 接口
4. 在原请求 body 中替换图片块，加上系统提示框架：

```
[系统提示：以下为用户粘贴图片的自动文字描述，由 VL 模型生成]
【图片 1】
<VL 模型返回的文字描述>
[图片描述结束]
```

5. 修改后的 body 继续转发到上游 LLM

**特点：**

- **零外部 npm 依赖** — 仅使用 Node.js 内置模块 (`http`, `https`, `fs`)
- **并行处理** — 多张图片同时识别，不串行等待
- **自动重试** — HTTP 5xx 等可恢复错误自动重试一次
- **透明透传** — 非 `/v1/messages` 路径直接透传，不影响其他 API 调用
- **Provider 可插拔** — 任何兼容 OpenAI `/chat/completions` 格式的 VL 服务均可使用

---

## 快速开始

```bash
# 1. 安装交互式向导
node install.js

# 2. 按提示配置 Provider、API Key、模型
# 3. 向导自动写入 config.json 并复制文件到 ~/.claude/scripts/image-proxy/
# 4. 将启动 hook 添加到 cc-switch Common Config（见下文）
# 5. 重启 cc-switch，完成
```

---

## 前置依赖

| 依赖 | 要求 | 备注 |
|------|------|------|
| Node.js | ≥ 18 | 使用 ESM、fetch API |
| cc-switch | 已开启本地路由，默认端口 15721 | 将 Claude Code 的 Anthropic 请求转为 OpenAI 格式 |
| VL API Key | 千问 / OpenAI / 兼容接口 | 用于图片识别 |

---

## 交互式安装

运行 `node install.js` 后，向导会逐项询问：

```
╔══════════════════════════════════════════════╗
║   Image Proxy — Claude Code Vision Skill    ║
║   安装配置向导                               ║
╚══════════════════════════════════════════════╝

   Node.js v22.x ✓
   cc-switch 本地路由已开启 (端口 15721) ✓
   安装目录: C:\Users\xxx\.claude\scripts\image-proxy

--- VL Provider 配置 ---
   支持所有兼容 OpenAI /chat/completions 的 VL 模型

Provider [qwen]:
API Key: ********
Model [qwen3.5-omni-plus]:
Base URL [https://dashscope.aliyuncs.com/compatible-mode/v1]:
代理端口 [8787]:
识别提示词 [请用中文详细描述这张图片的内容。]:

--- 即将写入的配置 ---
{
  "provider": "qwen",
  "model": "qwen3.5-omni-plus",
  "port": 8787,
  ...
}

确认写入? [Y/n]:
```

**仅在 `VISION_PROVIDER=custom` 时 `VISION_BASE_URL` 是必填的**，其他 provider 有默认值。

---

## 配置文件详解

所有配置存储在 `~/.claude/scripts/image-proxy/config.json`。

### 配置优先级

```
环境变量 > config.json > 默认值
```

### 完整配置项

| 配置项 | 环境变量 | config.json 字段 | 默认值 | 说明 |
|--------|----------|-----------------|--------|------|
| API Key | `VISION_API_KEY` | `api_key` | (空) | **必填**，VL 服务的 API 密钥 |
| Provider | `VISION_PROVIDER` | `provider` | `qwen` | `qwen` / `openai` / `custom` |
| 模型 | `VISION_MODEL` | `model` | `qwen3.5-omni-plus` | VL 模型名称 |
| Base URL | `VISION_BASE_URL` | `base_url` | 按 provider 自动选择 | 仅 `custom` 时必填 |
| 端口 | `IMAGE_PROXY_PORT` | `port` | `8787` | 代理监听端口 |
| 提示词 | `VISION_PROMPT` | `prompt` | 中文详细描述 | 发送给 VL 模型的提示词 |
| 调试 | `DEBUG` | - | `false` | 设为 `true` 开启详细日志 |

### config.json 示例

**千问（阿里云 DashScope）：**

```json
{
  "provider": "qwen",
  "api_key": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "model": "qwen3.5-omni-plus",
  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "port": 8787
}
```

**OpenAI：**

```json
{
  "provider": "openai",
  "api_key": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "model": "gpt-4o",
  "port": 8787
}
```

**自定义（任何 OpenAI 兼容接口）：**

```json
{
  "provider": "custom",
  "api_key": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "model": "your-vl-model",
  "base_url": "https://your-api.com/v1",
  "port": 8787
}
```

---

## 与 cc-switch 配合使用

### 为什么需要 Common Config？

cc-switch 切换供应商时，会用新供应商的配置**整体覆写** `~/.claude/settings.json`。这意味着：

- 手动添加的 `hooks`（启动 image-proxy）会被清掉
- 手动添加的 `env.VISION_*` 也会被清掉

image-proxy v1.0 已改用独立配置文件，**不再依赖 settings.json 的 env**。但启动 hook 仍需通过 cc-switch 的 **Common Config** 来持久化。

### 配置步骤

**步骤 1 — 打开 Common Config**

cc-switch UI → 设置 → Common Config

**步骤 2 — 添加 Hook**

在 Common Config 中添加以下内容：

**Windows（PowerShell）：**

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "command": "Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList 'C:\\Users\\<用户名>\\.claude\\scripts\\image-proxy\\image-proxy.js'",
        "shell": "powershell",
        "timeout": 10,
        "type": "command"
      }]
    }]
  }
}
```

**macOS / Linux（Shell）：**

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "command": "node $HOME/.claude/scripts/image-proxy/image-proxy.js &",
        "timeout": 10,
        "type": "command"
      }]
    }]
  }
}
```

> **注意：** 将 `<用户名>` 替换为你的实际用户名，或使用完整路径 `%USERPROFILE%\.claude\scripts\image-proxy\image-proxy.js`。

**步骤 3 — 保存并重启**

保存 Common Config 后重启 cc-switch。之后每次 Claude Code 会话启动时，cc-switch 会自动在后台拉起 image-proxy。

### 验证是否生效

发送一张图片给 Claude Code，观察终端日志：

```
[image-proxy] Processing 1 image(s) in parallel...
[image-proxy] VL calls completed in 1234ms
[image-proxy] Images processed: 1, new body: 5678 bytes (was 123456)
```

如果看到 `[image-proxy]` 开头的日志，说明图片已被成功拦截并识别。

---

## 支持的 VL Provider 矩阵

| Provider 标识 | Base URL（默认） | 默认模型 | 需要 Key 吗 |
|---------------|------------------|----------|------------|
| `qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.5-omni-plus` | 是 |
| `openai` | `https://api.openai.com/v1` | `gpt-4o` | 是 |
| `custom` | 手动指定 | 手动指定 | 是 |

**推荐组合：** `qwen` + `qwen3.5-omni-plus`，中文识别准确率高，性价比好。

**任何兼容 OpenAI `/chat/completions` 接口的 VL 服务都可以通过 `provider: "custom"` + 手动设定 `base_url` 和 `model` 接入。**

---

## 独立运行（不使用 cc-switch）

如果你有自己的 Anthropic→OpenAI 中转方案（不经过 cc-switch），也可以使用 image-proxy。

**架构变成：**

```
Claude Code → 你的中转代理 (端口 xxxx) → image-proxy (端口 8787) → DeepSeek
```

或者将 image-proxy 放在更上游：

```
Claude Code → image-proxy (端口 8787) → DeepSeek (直接)
```

在第二种方案中，`ANTHROPIC_BASE_URL` 应指向 image-proxy 的地址，image-proxy 再转发到 DeepSeek：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your-token",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-7[1M]"
  }
}
```

并在 image-proxy 的环境变量中设置上游地址：

```bash
UPSTREAM_HOST=api.deepseek.com UPSTREAM_PATH=/ node image-proxy.js
```

---

## 调试与日志

**开启调试模式：**

```bash
DEBUG=true node image-proxy.js
```

调试输出示例：

```
[image-proxy] Processing 2 image(s) in parallel...
[vision] VL response: 200 1823ms
[vision] VL response: 200 2105ms
[image-proxy] VL calls completed in 2107ms
[image-proxy] Images processed: 2, new body: 8912 bytes (was 245678)
```

**手动测试：**

```bash
# 健康检查
curl http://127.0.0.1:8787/health

# 预期返回: {"status":"ok","uptime":123.45}
```

---

## 常见问题

### Q: 图片识别的效果如何？

取决于你选择的 VL 模型。`qwen3.5-omni-plus` 对中文文字、图表、UI 截图识别效果好，但精细文字 OCR 场景仍建议用户直接粘贴文字。

### Q: 多张图片会串行处理吗？

不会。所有图片并行调用 VL 模型，总耗时 ≈ 最慢那一张的耗时。

### Q: 图片太大怎么办？

当前没有做压缩处理，直接以 base64 发送原图给 VL 模型。如果经常处理大图，建议设置 `VISION_PROMPT` 时提示模型「简要描述」。

### Q: 支持流式响应吗？

当前 VL 识别是**非流式**的（`stream: false`），每一张图片返回完整文字描述后，整个请求再以上游 API 支持的格式（流式/非流式）继续转发。

### Q: 会不会影响不带图片的普通对话？

不会。image-proxy 会先检查 body 是否包含 `"image"` 关键字，没有则直接透传，零开销。

### Q: VL 模型调用失败时怎么处理？

返回中文错误信息给 Claude Code：`[图片识别失败: HTTP 503]` 等。可恢复的错误（HTTP 5xx）自动重试一次。

### Q: 每次会话都执行 SessionStart hook，会不会启动一堆重复的 image-proxy 进程？

不会。image-proxy 启动时会检测端口 8787 是否已被占用——如果端口已在使用且 `/health` 返回正常，新进程会静默退出（`Already running, exiting.`），确保只有一个实例在后台运行。

---

## 项目结构

```
image-proxy/
├── CLAUDE.md              # Skill 元信息
├── skill.json             # Skill 声明
├── install.js             # 交互式安装脚本
├── README.md              # 本文件
└── image-proxy/
    ├── package.json
    ├── config.example.json  # 配置模板
    ├── image-proxy.js       # 主代理（图片拦截→VL→转发）
    └── vision.js            # VL Provider 适配器（可插拔）
```

---

## 许可

MIT
