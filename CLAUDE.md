# Claude Vision Skill

让 Claude Code「看见」图片。当 Claude Code 通过 DeepSeek 或其他非原生视觉模型中转时，自动拦截请求中的图片块，调用视觉语言模型（VL Model，如千问 VL / GPT-4o）识别图片内容，替换为文字描述后继续转发。

## 工作原理

```
Claude Code
    │  ANTHROPIC_BASE_URL=http://127.0.0.1:15721
    ▼
cc-switch (端口 15721)          ← 用户自行安装
    │  Anthropic → OpenAI 格式转换
    ▼
image-proxy (端口 8787)         ← 本 Skill 提供
    │  1. 检测请求中 type="image" 的 content block
    │  2. 并行调用 VL 模型识别图片
    │  3. 替换图片块为 [图片 N] + 文字描述
    │  4. 转发到上游 DeepSeek
    ▼
DeepSeek / 其他 LLM API
```

## 安装

```bash
node install.js
```

交互式向导会引导你完成配置。

## 前置依赖

- Node.js ≥ 18
- [cc-switch](https://github.com/farion1231/cc-switch)（或等效的 Anthropic→OpenAI 中转代理）
- 一个 VL 模型的 API Key（千问 / OpenAI / 兼容接口均可）

## 配置文件

所有配置写入 `~/.claude/scripts/image-proxy/config.json`：

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `provider` | VL Provider 标识 | `qwen` |
| `api_key` | API 密钥（必填） | 无 |
| `model` | VL 模型名 | `qwen3.5-omni-plus` |
| `base_url` | API 端点 | 自动根据 provider 选择 |
| `port` | 代理监听端口 | `8787` |
| `prompt` | 识别提示词 | 中文详细描述 |

环境变量具有最高优先级，可覆盖 config.json 中的值：
- `VISION_API_KEY` / `VISION_PROVIDER` / `VISION_MODEL` / `VISION_BASE_URL` / `VISION_PROMPT`

## 与 cc-switch 配合

**重要：** cc-switch 切换供应商时会整体覆写 `~/.claude/settings.json`。为确保持久生效，请将 image-proxy 的启动 hook 添加到 cc-switch 的 **Common Config** 中：

1. 打开 cc-switch UI → 设置 → Common Config
2. 添加 hook（Windows PowerShell）：
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "command": "Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList 'C:\\Users\\<你的用户名>\\.claude\\scripts\\image-proxy\\image-proxy.js'",
        "shell": "powershell",
        "type": "command"
      }]
    }]
  }
}
```
3. 保存并重启 cc-switch

## 支持的 VL Provider

| provider | 默认 base_url | 默认 model |
|----------|---------------|------------|
| `qwen` | dashscope.aliyuncs.com | qwen3.5-omni-plus |
| `openai` | api.openai.com | gpt-4o |
| `custom` | 手动指定 | 手动指定 |
