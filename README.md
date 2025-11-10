# OpenAI WebUI Lite - 自部署的 OpenAI API 代理服务

[![Deploy to Deno Deploy](https://img.shields.io/badge/Deploy%20to-Deno%20Deploy-00ADD8?style=flat-square&logo=deno)](https://dash.deno.com/)
[![Deploy to Cloudflare Workers](https://img.shields.io/badge/Deploy%20to-Cloudflare%20Workers-orange?style=flat-square&logo=cloudflare)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](#license)
[![OpenAI API](https://img.shields.io/badge/Powered%20by-OpenAI%20API-412991?style=flat-square&logo=openai)](https://platform.openai.com/)

一个简单易用的 Deno Deploy / Cloudflare Worker 程序，让您能够快速部署自己的 OpenAI API 代理服务。只需要一个域名和 OpenAI API Key，即可免费为家人朋友提供 AI 问答服务。

> 🎯 **何种情况下推荐使用 Deno Deploy 部署**  
> Deno Deploy 部署简单快捷，且在中国境内（及港澳地区）没有边缘节点，因此可以流畅代理请求发往 OpenAI、Gemini 官方 API 而不会因地区原因遭到拒绝。 因此代理上述官方 API 时首选 Deno Deploy 方式部署。

> ⚠️ **中国大陆访问注意事项**  
> 由于 Deno Deploy 的 IPv4 地址在中国大陆地区无法直接访问，即使使用自定义域名 CNAME 解析也无法绕过此限制。如需确保中国大陆地区用户正常访问，建议将域名托管至 Cloudflare，并在 DNS 设置中启用代理模式（橙色云朵图标），通过 Cloudflare CDN 进行流量代理，代理至 Deno Deploy 的 IP。

> 💡 **推荐使用心流 AI 获取免费 API**  
> 推荐使用阿里巴巴旗下的 [心流 AI](https://iflow.cn/?invite_code=vNEjKzbSTbhgWooCw15Bsw%3D%3D&open=setting) 获取免费的国产开源大模型 API Key。
>
> - **API 文档**: [https://platform.iflow.cn/docs/](https://platform.iflow.cn/docs/)
> - **API_BASE**: `https://apis.iflow.cn`
> - **API_KEYS**: 在 [心流 - 我的账户](https://iflow.cn/?invite_code=vNEjKzbSTbhgWooCw15Bsw%3D%3D&open=setting) 注册后申请
> - **可用模型**: Qwen3-Max、Qwen3-Coder-Plus、Qwen3-VL-Plus、GLM-4.6、Kimi-K2、DeepSeek-V3.2-Exp、DeepSeek-R1 等国产大模型 ([完整列表](https://platform.iflow.cn/models))
> - **注意事项**:
>   - 心流的 API Key 会在一段时间（约为七天）后自动过期（防滥用措施），过期后需在设置页面手动重置
>   - 每个 Key 最多同时发起一个请求，超出限制会返回 429 错误码
>   - 如果使用心流 AI 则更推荐 Cloudflare Workers 部署

请合理使用 AI 资源，避免滥用！

## ✨ 特性

- 🚀 **一键部署** - 基于 Deno Deploy / Cloudflare Workers，免费且快速
- 🔐 **密码保护** - 支持共享密码，保护您的 API Key
- 🎯 **演示模式** - 支持临时演示密码，带有调用次数限制
- 💬 **实时对话** - 流式响应，支持打字机效果
- 📱 **响应式设计** - 完美适配桌面端和移动端
- 💾 **本地存储** - 基于 IndexedDB 的持久化历史记录
- 🎨 **极简界面** - 养老版 OpenAI Chat，简洁易用
- 🌐 **多模型支持** - 支持 GPT、Gemini、Qwen 等多种 AI 模型
- 🔍 **联网搜索** - 集成 Tavily 搜索，为 AI 提供实时网络信息
- 📸 **分享问答** - 一键生成问答截图，方便社交分享
- 🏷️ **智能命名** - 根据问答内容自动生成会话标题，便于查找管理
- 🔠 **自定义标题** - 支持自定义界面标题和 Favicon

## 🖼️ 截图

![openai_webui_lite](https://lsky.useforall.com/pixel/2025/11/03/690882cd3229a.png)

![openai_webui_lite-m](https://lsky.useforall.com/pixel/2025/11/03/690882cced092.png)

## 🎯 功能说明

### 核心功能

- **代理服务**: 提供标准的 OpenAI API 代理端点
- **Web 界面**: 内置精美的聊天界面
- **密码机制**: 可设置共享密码，避免直接暴露 API Key
- **流式响应**: 实时显示 AI 回答，提升用户体验

### 使用特点

- 支持两轮问答模式：每个会话可以进行一次追问
- 历史记录保存在浏览器本地（注意：更换浏览器无法共享历史）
- 支持角色设定和系统提示词
- 支持 Markdown 渲染和代码高亮
- 支持联网搜索：通过 Tavily API 为 AI 提供实时网络信息作为上下文
- 支持自定义界面标题和 Favicon，打造个性化 AI 助手

## 🚀 快速开始

### 准备工作

1. **获取 OpenAI API Key**

   - 访问 [OpenAI Platform](https://platform.openai.com/api-keys)
   - 创建新的 API Key 并妥善保存

2. **获取 Tavily API Key（可选，用于联网搜索）**

   - 访问 [Tavily](https://tavily.com/)
   - 注册账号并获取 API Key
   - 配置后可在问答时勾选"联网搜索"，为 AI 提供实时网络信息

3. **准备域名**
   - 拥有一个域名（可以是免费域名）
   - 用于绑定到部署服务

### 部署步骤

**🎯 方式一：Deno Deploy（推荐）**

> ⚡ 推荐使用 Deno Deploy，部署简单快捷，访问稳定。

1. **Fork 项目到您的 GitHub**

   - 将项目代码上传到您的 GitHub 仓库

2. **部署到 Deno Deploy**

   - 访问 [Deno Deploy](https://dash.deno.com/)
   - 使用 GitHub 账号登录
   - 点击 "New Project"
   - 选择您的 GitHub 仓库
   - 设置入口文件为 `worker.js`
   - 点击 "Deploy"

3. **配置环境变量（推荐）**

   - 在 Deno Deploy 项目设置中添加环境变量：
     - `SECRET_PASSWORD`: 共享密码
     - `API_KEYS`: API Key 列表（逗号分隔）
     - `MODEL_IDS`: 支持的模型列表（必需，逗号分隔）
     - `API_BASE`: OpenAI API 基础地址（可选，默认 `https://api.openai.com`）
     - `DEMO_PASSWORD`: 临时演示密码（可选）
     - `DEMO_MAX_TIMES_PER_HOUR`: 演示密码每小时调用次数限制（可选，默认 15 次）
     - `TAVILY_KEYS`: 用于启用联网搜索特性
     - `TITLE`: 用于自定义网站标题及 Favicon
   - 环境变量优先级高于代码中的硬编码值

4. **绑定自定义域名（推荐）**

   - 在项目设置中点击 "Domains"
   - 添加您的自定义域名
   - 按照提示配置 DNS 记录
   - Deno Deploy 会自动提供 SSL 证书

5. **测试部署**
   - 访问您的 Deno Deploy 域名（如：`https://your-project.deno.dev`）
   - 或访问您的自定义域名
   - 输入共享密码测试功能
   - 后续为确保国内免科学访问，需套用 Cloudflare CDN

**🛠️ 方式二：Cloudflare Workers（备选）**

1. **创建 Cloudflare Worker**

   ```bash
   # 登录 Cloudflare Dashboard
   # 进入 Workers & Pages
   # 点击 "Create application" -> "Create Worker"
   ```

2. **配置代码**

   - 将 `worker.js` 中的 [代码](https://github.com/icheer/openai-webui-lite/blob/main/worker.js) 复制到 Worker 编辑器
   - 修改以下配置：

   ```javascript
   const SECRET_PASSWORD = 'your-shared-password'; // 设置共享密码
   const API_KEYS = 'sk-key1,sk-key2,sk-key3'; // API Key 列表，逗号分隔
   const MODEL_IDS = 'gpt-5-pro,gpt-5,gpt-5-mini'; // 支持的模型列表（必需）
   const API_BASE = 'https://api.openai.com'; // API 基础地址（可选）
   ```

   - 更推荐以环境变量方式配置以上参数

3. **绑定自定义域名**

   - 在 Worker 设置中添加自定义域名
   - 配置 DNS 记录（需要域名托管在 Cloudflare）

4. **测试部署**
   - 访问您的域名
   - 输入共享密码测试功能

## 📚 API 使用

### 基础端点

```
https://your-domain.com/v1/chat/completions
```

### REST API 调用示例

```bash
# 使用共享密码
curl -X POST "https://your-domain.com/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-shared-password" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {
        "role": "user",
        "content": "你好，请介绍一下自己"
      }
    ]
  }'

# 也可以使用 query 参数传递密钥
curl -X POST "https://your-domain.com/v1/chat/completions?key=your-shared-password" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {
        "role": "user",
        "content": "Hello, how can you help me?"
      }
    ]
  }'

# 使用完整 API Key
curl -X POST "https://your-domain.com/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-full-api-key" \
  -d '{
    "model": "gpt-5",
    "messages": [
      {
        "role": "user",
        "content": "What is the capital of France?"
      }
    ]
  }'
```

### 流式请求示例

```bash
curl -X POST "https://your-domain.com/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-password" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {
        "role": "user",
        "content": "写一首关于编程的诗"
      }
    ],
    "stream": true
  }'
```

## 🎨 Web 界面使用

1. **访问界面**: 打开 `https://your-domain.com`
2. **设置密钥**: 在左侧输入共享密码或完整 API Key
3. **角色设定**: （可选）设置系统提示词或角色设定
4. **开始对话**: 选择模型并输入问题
5. **联网搜索**: （可选）勾选"联网搜索"选项，AI 将获取实时网络信息作为回答参考
6. **追问功能**: 在第一个问题得到回答后，可以继续追问一次
7. **智能命名**: 系统会根据问答内容自动生成会话标题，便于管理查找
8. **分享问答**: 点击右上角"分享问答"按钮，生成问答截图
9. **查看历史**: 左侧会自动保存历史会话

### 支持的模型

默认支持所有 OpenAI 官方模型，包括但不限于：

- `gpt-5-pro` - GPT-5-Pro 模型
- `gpt-5` - GPT-5 模型
- `gpt-5-mini` - GPT-5 Mini 模型
- 以及其他 OpenAI 提供的模型

可以通过 `MODEL_IDS` 环境变量自定义显示在界面中的模型列表。

## ⚙️ 配置说明

### 环境变量配置（推荐）

项目支持通过环境变量进行配置，这样更安全且便于管理：

**主要环境变量：**

- `SECRET_PASSWORD`: 共享密码，用于正常无限制访问
- `API_KEYS`: OpenAI API Key 列表，多个用逗号分隔
- `MODEL_IDS`: 支持的模型列表，多个用逗号分隔（必需）
- `API_BASE`: OpenAI API 基础地址（可选，默认 `https://api.openai.com`）
- `DEMO_PASSWORD`: 临时演示密码，有调用次数限制（可选）
- `DEMO_MAX_TIMES_PER_HOUR`: 演示密码每小时最大调用次数（默认 15 次）
- `TAVILY_KEYS`: Tavily API Key 列表，用于联网搜索功能，多个用逗号分隔（可选）
- `TITLE`: 自定义 Web 界面标题和 Favicon（可选，默认 `OpenAI Chat`）

### 不同 API 提供商配置示例

以下是常见 API 提供商的配置示例，帮助您快速配置环境变量：

| API 提供商        | API_BASE                                    | API_KEYS 示例               | MODEL_IDS 示例                                                              | 备注                                        |
| ----------------- | ------------------------------------------- | --------------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| **OpenAI 官方**   | `https://api.openai.com`                    | `sk-proj-xxxxxx`            | `gpt-4o,gpt-4o-mini,o1-preview,o1-mini`                                     | 官方 API                                    |
| **Google Gemini** | `https://generativelanguage.googleapis.com` | `AIzaSyxxxxx1,AIzaSyxxxxx2` | `gemini-2.5-pro,gemini-2.5-flash,gemini-2.5-flash-lite`                     | 官方 API                                    |
| **心流 AI**       | `https://apis.iflow.cn`                     | `sk-xxxx1,sk-xxxx2`         | `qwen3-max,glm-4.6,kimi-k2,deepseek-v3.2-exp=DeepSeek V3.2`                 | 可以通过 `等号=` 自定义界面上外显的模型名称 |
| **OpenRouter**    | `https://openrouter.ai/api`                 | `sk-or-v1-xxxxxx`           | `openrouter/polaris-alpha,minimax/minimax-m2:free`                          | 官方提供若干免费模型可供调用                |
| **API 中转商 A**  | `https://api.example.com`                   | `sk-xxxxxx`                 | `claude-sonnet-4.5,gemini-3-pro-preview-11-2025` (根据中转商提供的模型列表) | 第三方中转，注意服务稳定性和隐私            |

**配置说明：**

- OpenAI 官方：建议使用 Deno Deploy 部署 worker
- Google AiStudio 官方（Gemini）：需要使用 Google AI Studio 获取 API Key，适合使用 Gemini 系列模型，建议使用 Deno Deploy 部署 worker
- 心流 AI：国内免费额度，适合体验国产大模型，Key 有效期约 7 天，Cloudflare Workers 部署即可
- API 中转商：第三方服务，大部分都兼容 OpenAI API 格式

**Deno Deploy 环境变量设置：**

1. 在项目设置页面找到 "Environment Variables"
2. 添加以下环境变量：
   - `SECRET_PASSWORD`: 共享密码，如 `mypassword123`
   - `API_KEYS`: API Key 列表，多个用逗号分隔，如 `sk-key1,sk-key2,sk-key3`
   - `MODEL_IDS`: 模型列表，如 `gpt-5-pro,gpt-5,gpt-5-mini`（必需）
   - `API_BASE`: 如 `https://api.openai.com`（可选）
   - `DEMO_PASSWORD`: 演示密码，如 `demo123`（可选）
   - `DEMO_MAX_TIMES_PER_HOUR`: 如 `10`（可选，默认 15）
   - `TAVILY_KEYS`: Tavily API Key 列表，如 `tvly-key1,tvly-key2`（可选，用于联网搜索）
   - `TITLE`: 自定义标题，如 `My AI Chat`（可选）

**Cloudflare Workers 环境变量设置：**

1. 在 Worker 设置中找到 "Variables"
2. 添加环境变量（同上）

### 代码配置（备选）

如果不想使用环境变量，也可以直接在 `worker.js` 中修改：

```javascript
// ⚠️ 注意: 当您fork项目并且仓库为公开时，请务必谨慎操作，以免您包含OpenAI密钥的Commit被暴露在公网，造成Key泄露的情况
// ⚠️ 注意: 仅当您有密码共享需求时才需要配置这些变量
// 否则无需配置，默认会使用 WebUI 填写的 API Key 进行请求

// 共享密码 - 您和朋友约定的密码
const SECRET_PASSWORD = 'your-shared-password';

// OpenAI API Key 列表 - 多个用逗号分隔，支持自动轮换，不建议这样明文写在代码里，谨防Key泄露！
const API_KEYS = 'sk-key1,sk-key2,sk-key3';

// 支持的模型列表 - 多个用逗号分隔（必需）
const MODEL_IDS = 'gpt-5-pro,gpt-5,gpt-5-mini';

// OpenAI API 基础地址（可选）
const API_BASE = 'https://api.openai.com';

// 临时演示密码 - 有调用次数限制（可选）
const DEMO_PASSWORD = 'demo123';

// 演示密码每小时最大调用次数
const DEMO_MAX_TIMES_PER_HOUR = 15;

// Tavily API Key 列表 - 用于联网搜索功能（可选）
const TAVILY_KEYS = 'tvly-key1,tvly-key2';

// 自定义界面标题和 Favicon（可选）
const TITLE = 'OpenAI Chat';
```

### 配置优先级

1. **环境变量** > **代码硬编码值**
2. 如果都未配置，将使用默认值：
   - `SECRET_PASSWORD`: 随机生成（如 `yijiaren.123`）
   - `API_KEYS`: 示例密钥（需要替换）
   - `MODEL_IDS`: 默认模型列表（如 `gpt-5-pro,gpt-5,gpt-5-mini`）
   - `API_BASE`: `https://api.openai.com`
   - `DEMO_PASSWORD`: 默认为空（不开启演示模式）
   - `DEMO_MAX_TIMES_PER_HOUR`: 默认为 `15`
   - `TAVILY_KEYS`: 默认为空（不开启联网搜索功能）
   - `TITLE`: 默认为 `OpenAI Chat`

### 使用说明

**无需配置的情况：**

- 如果您只是想个人使用，无需配置任何环境变量
- 直接在 Web 界面输入您的 API Key 即可正常使用

**需要配置的情况：**

- 想要分享给朋友使用，避免暴露真实 API Key
- 希望配置多个 API Key 实现负载均衡
- 需要统一管理 API Key
- 需要提供临时演示访问，限制调用次数
- 需要开启联网搜索功能，为 AI 提供实时网络信息
- 需要自定义界面标题和 Favicon

### 密码类型说明

**正式密码 (`SECRET_PASSWORD`)：**

- 无调用次数限制
- 适合长期使用
- 建议设置强密码

**演示密码 (`DEMO_PASSWORD`)：**

- 有调用次数限制（默认 15 次/小时）
- 适合临时演示和测试
- 超出限制后需要等待下一小时重置
- 可通过 `DEMO_MAX_TIMES_PER_HOUR` 调整限制

### 安全建议

- **优先使用环境变量**：避免在代码中硬编码敏感信息
- **使用强密码**：设置复杂的 `SECRET_PASSWORD`
- **定期轮换**：定期更换共享密码和 API Key
- **访问控制**：不要在公开场合分享您的域名
- **多密钥配置**：配置多个 API Key 提高可用性和稳定性

## 🔧 自定义修改

### 修改界面样式

Web 界面的 HTML/CSS/JS 代码都在 `getHtmlContent()` 函数中，您可以：

- 修改主题颜色
- 调整布局结构
- 添加新功能

### 添加新模型

在 `MODEL_IDS` 环境变量或代码中添加新的模型名称：

```javascript
// 通过环境变量
MODEL_IDS = 'gpt-5-pro,gpt-5,gpt-5-mini';

// 或在代码中
const MODEL_IDS_DEFAULT = 'qwen3-max,kimi-k2,your-new-model';
```

## 📱 移动端支持

界面完全适配移动端：

- 响应式布局
- 触摸友好的操作
- 侧边栏自动收缩
- 优化的输入体验
- 便捷分享功能：
  - **微信浏览器**: 显示图片弹窗，支持长按保存/转发
  - **其他浏览器**: 自动下载截图文件

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE) 文件。

## ⚠️ 注意事项

- 历史记录仅保存在浏览器本地，更换设备或清除浏览器数据会丢失
- 请合理使用 API，避免过度消耗配额
- 建议定期备份重要的对话记录
- 本项目仅供学习和个人使用

## 🙋‍♂️ 常见问题

**Q: 只支持 OpenAI 的模型吗？**<br>
_A: 不是。本项目支持所有兼容 OpenAI API 格式的模型和服务，包括但不限于 OpenAI、Gemini、Qwen、GLM、Kimi、DeepSeek 等。只需配置相应的 `API_BASE` 和 `API_KEYS` 即可使用。_

**Q: 为什么推荐 Deno Deploy 而不是 Cloudflare Workers？**<br>
_A: Deno Deploy 部署简单快捷，提供稳定的全球访问。两个平台都适用，根据个人偏好选择即可。_

**Q: 两个平台的功能有区别吗？**<br>
_A: 功能完全相同，只是部署方式不同。代码都支持流式响应、密钥轮换、Web 界面等全部特性。_

**Q: 可以同时部署到两个平台吗？**<br>
_A: 可以的！`worker.js` 内部判断了当前服务器环境，可以同时部署到两个平台。_

**Q: 为什么选择两轮问答模式？**<br>
_A: 在保持简洁的基础上，支持一次追问能够满足大多数场景需求，避免过于复杂的多轮对话造成不可控的额外开销。_

**Q: 可以支持更多轮对话吗？**<br>
_A: 目前限制为两轮（一问一答+一次追问），这样设计是为了保持界面简洁和交互清晰。如需更复杂对话，建议在角色设定中添加上下文。_

**Q: 会话标题是如何生成的？**<br>
_A: 当您首次在会话中提问并得到回答后，系统会根据问题和回答的内容自动生成一个简洁的标题，方便您后续查找和管理会话。_

**Q: 分享功能在哪些环境下可用？**<br>
_A: 所有现代浏览器都支持。微信浏览器会显示图片弹窗供长按保存，其他浏览器会自动下载 PNG 文件。_

**Q: 历史记录可以导出吗？**<br>
_A: 目前使用 IndexedDB 存储，可以通过浏览器开发者工具查看和导出数据。_

**Q: 部署需要付费吗？**<br>
_A: Deno Deploy 和 Cloudflare Workers 都有免费额度，一般个人使用完全够用。_

**Q: 如何配置多个 API Key？**<br>
_A: 在环境变量 `API_KEYS` 中用逗号分隔多个密钥，如 `sk-key1,sk-key2,sk-key3`，系统会自动轮换使用。_

**Q: 不配置环境变量可以使用吗？**<br>
_A: 可以！如果不配置环境变量，直接在 Web 界面输入您的 API Key 即可正常使用。环境变量主要用于密码共享场景。_

**Q: 环境变量和代码配置的优先级？**<br>
_A: 环境变量优先级更高。如果设置了环境变量，会优先使用环境变量的值，否则使用代码中双竖线`||`后面的默认值。_

**Q: 忘记了共享密码怎么办？**<br>
_A: 查看您部署时配置的环境变量，或查看代码中的 `SECRET_PASSWORD` 常量。_

**Q: 演示密码和正式密码有什么区别？**<br>
_A: 演示密码 (`DEMO_PASSWORD`) 有调用次数限制，默认每小时最多 15 次，适合临时演示；正式密码 (`SECRET_PASSWORD`) 无限制，适合长期使用。_

**Q: 演示密码的调用次数用完了怎么办？**<br>
_A: 需要等待下一个小时重置，或者使用正式密码继续访问。管理员可以通过 `DEMO_MAX_TIMES_PER_HOUR` 环境变量调整限制次数。_

**Q: 如何开启联网搜索功能？**<br>
_A: 在环境变量中配置 `TAVILY_KEYS`，然后在 Web 界面勾选"联网搜索"选项即可。联网搜索会为 AI 提供实时的网络信息作为上下文，提升回答的时效性和准确性。_

**Q: Tavily API Key 如何获取？**<br>
_A: 访问 [Tavily](https://tavily.com/) 注册账号并获取 API Key。可以配置多个 Key 用逗号分隔，系统会自动轮换使用。_

**Q: 如何自定义界面标题和 Favicon？**<br>
_A: 通过环境变量 `TITLE` 设置自定义标题，如 `TITLE=My AI Assistant`。标题会同时影响网页标题和 Favicon 的显示样式。_

**Q: TITLE 环境变量是如何影响 Favicon 的？**<br>
_A: `TITLE` 中包含 Gemini 或 Qwen 字样时（忽略大小写），网站 Favicon 会自动变为相应的模型 Logo，否则 Logo 默认为 OpenAI 的样式。_

---

如果这个项目对您有帮助，请给个 ⭐ Star！
