const isDeno = typeof Deno !== 'undefined';
const isCf =
  !isDeno &&
  typeof Request !== 'undefined' &&
  typeof Request.prototype !== 'undefined';

// 获取环境变量
const SERVER_TYPE = isDeno ? 'DENO' : isCf ? 'CF' : 'VPS';
function getEnv(key, env = {}) {
  if (isDeno) {
    return Deno.env.get(key) || '';
  } else if (typeof process !== 'undefined' && process.env) {
    // Node.js 环境
    return process.env[key] || '';
  } else {
    // Cloudflare Workers环境，从传入的 env 对象获取
    return env[key] || '';
  }
}

// ⚠️注意: 仅当您有密码共享需求时才需要配置 SECRET_PASSWORD 和 API_KEYS 这两个环境变量! 否则您无需配置, 默认会使用WebUI填写的API Key进行请求
// 这里是您和您的朋友共享的密码, 优先使用环境变量, 双竖线后可以直接硬编码(例如 'yijiaren.308' 免得去管理面板配置环境变量了, 但极不推荐这么做!)
const SECRET_PASSWORD_DEFAULT = `yijiaren.${~~(Math.random() * 1000)}`;
// 这里是您的API密钥清单, 多个时使用逗号分隔, 会轮询(随机)使用, 同样也是优先使用环境变量, 其次使用代码中硬写的值, 注意不要在公开代码仓库中提交密钥的明文信息, 谨防泄露!!
const API_KEYS_DEFAULT = 'sk-xxxxx,sk-yyyyy';
const MODEL_IDS_DEFAULT = 'gpt-5-pro,gpt-5,gpt-5-mini';
const API_BASE_DEFAULT = 'https://api.openai.com';
const DEMO_PASSWORD_DEFAULT = '';
const DEMO_MAX_TIMES_PER_HOUR_DEFAULT = 15;
const TITLE_DEFAULT = 'OpenAI Chat';

// KV 存储适配器 - 兼容 Cloudflare Workers 和 Deno Deploy
let kvStore = null;

/**
 * 初始化 KV 存储
 * @param {Object} env - 环境变量对象（Cloudflare Workers 会传入）
 */
async function initKV(env = {}) {
  if (isDeno) {
    // Deno Deploy: 使用 Deno KV
    try {
      kvStore = await Deno.openKv();
    } catch (error) {
      console.error('Failed to open Deno KV:', error);
      kvStore = null;
    }
  } else if (env.KV) {
    // Cloudflare Workers: 使用绑定的 KV namespace
    kvStore = env.KV;
  } else {
    // 没有 KV 存储，使用内存模拟（不推荐用于生产环境）
    console.warn('KV storage not available, using in-memory fallback');
    kvStore = null;
  }
  return kvStore;
}

/**
 * 从 KV 存储获取值
 * @param {string} key - 键名
 * @returns {Promise<any>} - 返回解析后的 JSON 对象，如果不存在返回 null
 */
async function getKV(key) {
  if (!kvStore) {
    return null;
  }

  try {
    if (isDeno) {
      // Deno KV
      const result = await kvStore.get([key]);
      return result.value;
    } else {
      // Cloudflare Workers KV
      const value = await kvStore.get(key, { type: 'json' });
      return value;
    }
  } catch (error) {
    console.error('KV get error:', error);
    return null;
  }
}

/**
 * 向 KV 存储设置值
 * @param {string} key - 键名
 * @param {any} value - 要存储的值（会被序列化为 JSON）
 * @param {number} ttl - 过期时间（秒），可选
 * @returns {Promise<boolean>} - 成功返回 true
 */
async function setKV(key, value, ttl = null) {
  if (!kvStore) {
    return false;
  }

  try {
    if (isDeno) {
      // Deno KV
      const options = ttl ? { expireIn: ttl * 1000 } : {};
      await kvStore.set([key], value, options);
      return true;
    } else {
      // Cloudflare Workers KV
      const options = ttl ? { expirationTtl: ttl } : {};
      await kvStore.put(key, JSON.stringify(value), options);
      return true;
    }
  } catch (error) {
    console.error('KV set error:', error);
    return false;
  }
}

// 临时演示密码记忆（仅作为 KV 不可用时的后备方案）
const demoMemory = {
  hour: 0,
  times: 0,
  maxTimes: DEMO_MAX_TIMES_PER_HOUR_DEFAULT
};

// API Key 轮询索引
let apiKeyIndex = 0;

// 通用的请求处理函数
async function handleRequest(request, env = {}) {
  // 初始化 KV 存储
  await initKV(env);

  // 从环境变量获取配置
  const SECRET_PASSWORD =
    getEnv('SECRET_PASSWORD', env) || SECRET_PASSWORD_DEFAULT;
  const API_KEYS = getEnv('API_KEYS', env) || API_KEYS_DEFAULT;
  const API_KEY_LIST = (API_KEYS || '')
    .split(',')
    .map(i => i.trim())
    .filter(i => i);
  const MODEL_IDS = getEnv('MODEL_IDS', env) || MODEL_IDS_DEFAULT;
  const API_BASE = getEnv('API_BASE', env) || API_BASE_DEFAULT;
  const DEMO_PASSWORD = getEnv('DEMO_PASSWORD', env) || DEMO_PASSWORD_DEFAULT;
  const DEMO_MAX_TIMES =
    parseInt(getEnv('DEMO_MAX_TIMES_PER_HOUR', env)) ||
    DEMO_MAX_TIMES_PER_HOUR_DEFAULT;
  const TAVILY_KEYS = getEnv('TAVILY_KEYS', env) || '';
  const TAVILY_KEY_LIST = (TAVILY_KEYS || '')
    .split(',')
    .map(i => i.trim())
    .filter(i => i);
  const TITLE = getEnv('TITLE', env) || TITLE_DEFAULT;

  let CHAT_TYPE = 'bot';
  if (/gemini/i.test(TITLE)) {
    CHAT_TYPE = 'gemini';
  } else if (/claude/i.test(TITLE)) {
    CHAT_TYPE = 'claude';
  } else if (/qwen/i.test(TITLE)) {
    CHAT_TYPE = 'qwen';
  } else if (/openai/i.test(TITLE)) {
    CHAT_TYPE = 'openai';
  }

  /**
   * 检查并更新 demo 密码的调用次数
   * @param {number} increment - 要增加的次数，默认为 1
   * @returns {Promise<{allowed: boolean, message: string, data: object}>}
   */
  async function checkAndUpdateDemoCounter(increment = 1) {
    const hour = Math.floor(Date.now() / 3600000);
    const kvKey = 'demo_counter';

    // 尝试从 KV 获取计数器数据
    let demoData = await getKV(kvKey);

    if (!demoData || demoData.hour !== hour) {
      // KV 中没有数据或者已经过了一个小时，重置计数器
      demoData = {
        hour: hour,
        times: 0,
        maxTimes: DEMO_MAX_TIMES
      };
    }

    // 检查是否超过最大调用次数
    if (demoData.times >= demoData.maxTimes) {
      return {
        allowed: false,
        message: `Exceeded maximum API calls (${demoData.maxTimes}) for this hour. Please try again next hour.`,
        data: demoData
      };
    }

    // 增加计数
    demoData.times += increment;

    // 保存到 KV（不设置过期时间，下次检查时会自动重置）
    await setKV(kvKey, demoData);

    // 如果 KV 存储失败，回退到内存记忆（仅当前实例有效）
    if (!kvStore) {
      if (demoMemory.hour === hour) {
        if (demoMemory.times >= DEMO_MAX_TIMES) {
          return {
            allowed: false,
            message: `Exceeded maximum API calls (${DEMO_MAX_TIMES}) for this hour`,
            data: { hour, times: demoMemory.times, maxTimes: DEMO_MAX_TIMES }
          };
        }
      } else {
        demoMemory.hour = hour;
        demoMemory.times = 0;
      }
      demoMemory.times += increment;
    }

    return {
      allowed: true,
      message: 'OK',
      data: demoData
    };
  }

  /**
   * 验证并处理 API Key
   * @param {string} apiKey - 原始 API Key
   * @param {number} demoIncrement - Demo 密码的计数增量，默认为 1
   * @returns {Promise<{valid: boolean, apiKey: string, error?: Response}>}
   */
  async function validateAndProcessApiKey(apiKey, demoIncrement = 1) {
    if (!apiKey) {
      return {
        valid: false,
        apiKey: '',
        error: createErrorResponse(
          'Missing API key. Provide via ?key= parameter or Authorization header',
          401
        )
      };
    }

    // 检查是否是共享密码
    if (apiKey === SECRET_PASSWORD) {
      return {
        valid: true,
        apiKey: getNextApiKey(API_KEY_LIST)
      };
    }

    // 检查是否是临时演示密码
    if (apiKey === DEMO_PASSWORD && DEMO_PASSWORD) {
      const result = await checkAndUpdateDemoCounter(demoIncrement);
      if (!result.allowed) {
        return {
          valid: false,
          apiKey: '',
          error: createErrorResponse(result.message, 429)
        };
      }
      return {
        valid: true,
        apiKey: getNextApiKey(API_KEY_LIST)
      };
    }

    // 其他情况，使用原始 API Key
    return {
      valid: true,
      apiKey: apiKey
    };
  }

  const url = new URL(request.url);
  const apiPath = url.pathname;
  const apiMethod = request.method.toUpperCase();

  // 处理HTML页面请求
  if (apiPath === '/' || apiPath === '/index.html') {
    const htmlContent = getHtmlContent(MODEL_IDS, TAVILY_KEYS, TITLE);
    return new Response(htmlContent, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'public, max-age=43200' // 缓存12小时
      }
    });
  }

  if (apiPath === '/favicon.svg') {
    const svgContent = getSvgContent(CHAT_TYPE);
    return new Response(svgContent, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=43200' // 缓存12小时
      }
    });
  }

  if (apiPath === '/manifest.json' || apiPath === '/site.webmanifest') {
    const manifestContent = getManifestContent(TITLE);
    return new Response(manifestContent, {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Cache-Control': 'public, max-age=43200' // 缓存12小时
      }
    });
  }

  // 直接返回客户端的原本的请求信息(用于调试)
  if (apiPath === '/whoami') {
    return new Response(
      JSON.stringify({
        serverType: SERVER_TYPE,
        serverInfo: isDeno
          ? {
              target: Deno.build.target,
              os: Deno.build.os,
              arch: Deno.build.arch,
              vendor: Deno.build.vendor
            }
          : request.cf || 'unknown',
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        method: request.method,
        bodyUsed: request.bodyUsed
      }),
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  // 调用tavily搜索API
  if (apiPath === '/search' && apiMethod === 'POST') {
    let apiKey =
      url.searchParams.get('key') || request.headers.get('Authorization') || '';
    apiKey = apiKey.replace('Bearer ', '').trim();
    // 从body中获取query参数
    const query = (await request.json()).query || '';
    if (!query) {
      return createErrorResponse('Missing query parameter', 400);
    }

    const keyValidation = await validateAndProcessApiKey(apiKey, 0.1);
    if (!keyValidation.valid) {
      return keyValidation.error;
    }

    const modelPrompt = getTavilyPrompt(query);
    const model = getLiteModelId(MODEL_IDS);
    let modelUrl = `${API_BASE}/v1/chat/completions`;
    modelUrl = replaceApiUrl(modelUrl);
    const modelPayload = {
      model,
      messages: [
        {
          role: 'user',
          content: modelPrompt.trim()
        }
      ]
    };
    const modelResponse = await fetch(modelUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + getNextApiKey(API_KEY_LIST)
      },
      body: JSON.stringify(modelPayload)
    });
    // 接下来从modelResponse中提取content
    const modelJsonData = await modelResponse.json();
    const content = modelJsonData.choices?.[0]?.message?.content || '';
    // 从中找到反引号`的位置, 提取反引号里包裹的内容
    const backtickMatch = content.match(/`([^`]+)`/);
    const searchKeywords = backtickMatch
      ? backtickMatch[1].trim()
      : content.trim();
    if (searchKeywords.includes('非搜索意图')) {
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }

    const tavilyUrl = 'https://api.tavily.com/search';
    const tavilyKey = getRandomApiKey(TAVILY_KEY_LIST);
    const payload = {
      query: searchKeywords,
      max_results: 20,
      include_answer: 'basic',
      auto_parameters: true
    };
    // fetch请求
    const response = await fetch(tavilyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + tavilyKey
      },
      body: JSON.stringify(payload)
    });
    return new Response(response.body, {
      status: response.status,
      headers: response.headers
    });
  }

  // 总结会话
  if (apiPath === '/summarize' && apiMethod === 'POST') {
    let apiKey =
      url.searchParams.get('key') || request.headers.get('Authorization') || '';
    apiKey = apiKey.replace('Bearer ', '').trim();

    // 从body中获取question和answer参数
    const { question, answer } = await request.json();
    if (!question || !answer) {
      return createErrorResponse('Missing question or answer parameter', 400);
    }

    const keyValidation = await validateAndProcessApiKey(apiKey, 0.1);
    if (!keyValidation.valid) {
      return keyValidation.error;
    }

    // 检查是否是有效的密码（SECRET_PASSWORD 或 DEMO_PASSWORD）
    if (![DEMO_PASSWORD, SECRET_PASSWORD].includes(apiKey)) {
      return createErrorResponse('Invalid API key. Provide a valid key.', 403);
    }

    // 截取question和answer，避免过长
    const truncatedQuestion =
      question.length <= 300
        ? question
        : question.slice(0, 150) + '......' + question.slice(-150);
    const truncatedAnswer =
      answer.length <= 300
        ? answer
        : answer.slice(0, 150) + '......' + answer.slice(-150);

    // 构建总结提示词
    const summaryPrompt = `请为以下对话生成一个简短的标题（不超过20个字）：

问题：
\`\`\`
${truncatedQuestion}
\`\`\`

回答：
\`\`\`
${truncatedAnswer}
\`\`\`

要求：
1. 标题要简洁明了，能概括对话的核心内容
2. 不要使用引号或其他标点符号包裹
3. 直接输出标题文本即可`;

    const messages = [
      {
        role: 'user',
        content: summaryPrompt
      }
    ];

    // 选择合适的精简模型
    const summaryModel = getLiteModelId(MODEL_IDS);
    let modelUrl = `${API_BASE}/v1/chat/completions`;
    modelUrl = replaceApiUrl(modelUrl);

    const modelPayload = {
      model: summaryModel,
      messages: messages,
      max_tokens: 300
    };

    try {
      const modelResponse = await fetch(modelUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + getNextApiKey(API_KEY_LIST)
        },
        body: JSON.stringify(modelPayload)
      });

      if (!modelResponse.ok) {
        throw new Error('Model API request failed');
      }

      const modelJsonData = await modelResponse.json();
      const summary = modelJsonData.choices?.[0]?.message?.content || '';

      return new Response(
        JSON.stringify({
          success: true,
          summary: summary.trim()
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (error) {
      console.error('Generate summary failed:', error);
      return createErrorResponse('Failed to generate summary', 500);
    }
  }

  if (!apiPath.startsWith('/v1')) {
    return createErrorResponse(
      apiPath + ' Invalid API path. Must start with /v1',
      400
    );
  }

  // 2. 获取和验证API密钥
  let apiKey =
    url.searchParams.get('key') || request.headers.get('Authorization') || '';
  apiKey = apiKey.replace('Bearer ', '').trim();
  let urlSearch = url.searchParams.toString();

  const originalApiKey = apiKey;
  const keyValidation = await validateAndProcessApiKey(apiKey);
  if (!keyValidation.valid) {
    return keyValidation.error;
  }

  apiKey = keyValidation.apiKey;

  // 替换 URL 中的密码为实际 API Key
  if (originalApiKey === SECRET_PASSWORD) {
    urlSearch = urlSearch.replace(`key=${SECRET_PASSWORD}`, `key=${apiKey}`);
  } else if (originalApiKey === DEMO_PASSWORD) {
    urlSearch = urlSearch.replace(`key=${DEMO_PASSWORD}`, `key=${apiKey}`);
  }

  // 3. 构建请求
  let fullPath = `${API_BASE}${apiPath}`;
  fullPath = replaceApiUrl(fullPath);
  const targetUrl = `${fullPath}?${urlSearch}`;
  const proxyRequest = buildProxyRequest(request, apiKey);

  // 4. 发起请求并处理响应
  try {
    const response = await fetch(targetUrl, proxyRequest);

    // 直接透传响应 - 无缓冲流式处理
    return new Response(response.body, {
      status: response.status,
      headers: response.headers
    });
  } catch (error) {
    console.error('Proxy request failed:', error);
    return createErrorResponse('Proxy request failed', 502);
  }
}

// Cloudflare Workers 导出
export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

// // Deno Deploy 支持
// if (isDeno) {
//   Deno.serve(handleRequest);
// }

/**
 * 构建代理请求配置
 */
function buildProxyRequest(originalRequest, apiKey) {
  const headers = new Headers();

  // 复制必要的请求头
  const headersToForward = [
    'content-type',
    'accept',
    'accept-encoding',
    'user-agent'
  ];

  headersToForward.forEach(headerName => {
    const value = originalRequest.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  });

  // 设置API密钥
  headers.set('Authorization', `Bearer ${apiKey}`);

  return {
    method: originalRequest.method,
    headers: headers,
    body: originalRequest.body,
    redirect: 'follow'
  };
}

/**
 * 创建错误响应
 */
function createErrorResponse(message, status) {
  return new Response(
    JSON.stringify({
      error: message,
      timestamp: new Date().toISOString()
    }),
    {
      status: status,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}

/**
 * 轮询获取下一个 API Key
 * 使用递增索引方式，避免同一时间多个请求使用同一个 Key
 */
function getNextApiKey(apiKeyList) {
  if (!apiKeyList || apiKeyList.length === 0) {
    throw new Error('API Key list is empty');
  }
  const key = apiKeyList[apiKeyIndex % apiKeyList.length];
  apiKeyIndex = (apiKeyIndex + 1) % apiKeyList.length;
  return key;
}

function getRandomApiKey(apiKeyList) {
  if (!apiKeyList || apiKeyList.length === 0) {
    throw new Error('API Key list is empty');
  }
  const randomIndex = Math.floor(Math.random() * apiKeyList.length);
  return apiKeyList[randomIndex];
}

function getLiteModelId(modelIds) {
  if (!modelIds) return 'gemini-2.5-flash-lite';
  const models = modelIds
    .split(',')
    .filter(i => i)
    .map(i => i.trim().split(':')[0])
    .filter(i => i);
  const parts = [
    '-mini',
    '-nano',
    '-lite',
    '-flash',
    '-instruct',
    '-4o',
    '-k2',
    '-v3',
    '-r1',
    '-haiku',
    'gpt'
  ];
  let model = models[0];
  for (const p of parts) {
    const match = models.find(m => m.toLowerCase().includes(p));
    if (match) {
      model = match;
      break;
    }
  }
  return model;
}

function replaceApiUrl(url) {
  const isGemini = [
    'generativelanguage.googleapis.com',
    'gateway.ai.cloudflare.com'
  ].some(p => url.includes(p));
  if (!isGemini) {
    return url;
  } else {
    url = url
      .replace('/v1/chat', '/v1beta/openai/chat')
      .replace('/v1/models', '/v1beta/openai/models');
    return url;
  }
}

function getTavilyPrompt(query) {
  const str = `
你是一位AI聊天应用的前置助手（search-helper），专为调用Tavily搜索引擎API服务。你的核心职责是从用户的自然语言问句中，精准、高效地提炼出最适合搜索引擎查询的关键词字符串。

## 核心使命
你的存在是为了提升搜索引擎的调用效率和准确率。通过将用户的口ü语化、模糊的问题，转化为结构化、精确的搜索指令，你将直接优化用户的搜索体验并提供更相关的结果。

## 任务要求
1.  **意图识别：** 首先判断用户输入是否为有信息检索意图的查询。对于闲聊、打招呼或无法转化为搜索请求的指令，应识别为“非搜索意图”。
2.  **关键信息提炼：** 若为搜索查询，需仔细分析问句，识别出所有关键元素，包括但不限于：核心主题、实体（人名、地名、组织名）、具体对象、时间、事件、属性以及用户的真实意图。
3.  **关键词生成：** 将提炼出的关键信息，依据下述原则，组合成一个简洁、无歧义且能最大化搜索效果的关键词字符串。
4.  **格式化输出：** 你的唯一输出必须是一个独立的字符串。此字符串要么是生成的关键词，要么是“非搜索意图”的标识。禁止添加任何解释或额外的文本。

## 关键词生成原则
1.  **简洁至上：** 使用最少的词语表达最核心的意图。
2.  **核心优先：** 优先提取代表核心主题的名词或实体（人名、地名、产品名、专业术语）。
3.  **移除停用词：** 省略口语化的填充词、疑问词和无实际意义的助词（如“我想知道”、“...是什么”、“...怎么样”、“的”、“呢”、“吗”）。
4.  **处理歧义：** 当用户输入存在歧义时（如“苹果”），结合上下文选择最有可能的解释（通常是科技公司而非水果）。
5.  **处理否定/排除：** 将明确的排除性词语（如“除了...”、“不要...”）转化为搜索引擎可识别的排除操作符（如 \`-\` 符号）。

## 示例
*   **用户输入（常规）：** “我想了解一下最新的人工智能发展趋势，特别是关于大型语言模型在医疗领域的应用。”
*   **你的输出：** \`人工智能发展趋势 大型语言模型 医疗应用\`

*   **用户输入（简单）：** “上海今天的天气怎么样？”
*   **你的输出：** \`上海 今天 天气\`

*   **用户输入（含否定）：** “推荐一些除了特斯拉以外的新能源汽车品牌。”
*   **你的输出：** \`新能源汽车品牌 -特斯拉\`

*   **用户输入（含歧义）：** “分析一下苹果公司最近的财报表现。”
*   **你的输出：** \`苹果公司 最新财报 分析\`

*   **用户输入（非搜索意图）：** “你好呀！”
*   **你的输出：** \`非搜索意图\`

## 时间校准
现在真实世界的时间是${new Date().toISOString()}。

## 用户输入
「${query}」
  `;
  return str.trim();
}

function getSvgContent(chatType) {
  const svgOpenai = `
<svg
  t="1761563068979"
  class="icon"
  viewBox="0 0 1024 1024"
  version="1.1"
  xmlns="http://www.w3.org/2000/svg"
  p-id="2192"
  width="24"
  height="24"
>
  <path
    d="M0 512a512 512 0 1 0 1024 0 512 512 0 0 0-1024 0z"
    fill="#F86AA4"
    p-id="2193"
  ></path>
  <path
    d="M845.585067 442.299733a189.303467 189.303467 0 0 0-16.725334-157.149866c-42.496-72.977067-127.829333-110.421333-211.217066-92.808534a198.417067 198.417067 0 0 0-186.948267-60.142933A195.857067 195.857067 0 0 0 284.330667 261.768533a194.013867 194.013867 0 0 0-129.706667 92.808534 191.453867 191.453867 0 0 0 24.064 227.089066 189.064533 189.064533 0 0 0 16.554667 157.149867c42.530133 72.977067 127.965867 110.455467 211.387733 92.808533a195.345067 195.345067 0 0 0 146.261333 64.375467c85.435733 0.1024 161.109333-54.340267 187.255467-134.621867a194.1504 194.1504 0 0 0 129.672533-92.7744 191.761067 191.761067 0 0 0-24.234666-226.304z m-292.693334 403.456a146.432 146.432 0 0 1-93.320533-33.28l4.608-2.56 154.999467-88.302933a25.3952 25.3952 0 0 0 12.731733-21.742933v-215.586134l65.536 37.376a2.218667 2.218667 0 0 1 1.262933 1.6384v178.653867c-0.2048 79.36-65.365333 143.633067-145.8176 143.803733zM239.479467 713.728a141.380267 141.380267 0 0 1-17.3056-96.426667l4.608 2.696534 155.136 88.302933a25.4976 25.4976 0 0 0 25.2928 0l189.576533-107.793067v74.615467a2.525867 2.525867 0 0 1-1.058133 1.9456l-157.013334 89.326933c-69.768533 39.594667-158.890667 16.042667-199.236266-52.667733zM198.656 380.689067a145.066667 145.066667 0 0 1 76.8-63.146667v181.6576a24.439467 24.439467 0 0 0 12.526933 21.640533l188.689067 107.349334-65.536 37.376a2.4576 2.4576 0 0 1-2.321067 0l-156.672-89.1904a143.0528 143.0528 0 0 1-53.486933-196.471467v0.785067z m538.453333 123.323733l-189.2352-108.373333 65.365334-37.205334a2.4576 2.4576 0 0 1 2.321066 0l156.672 89.258667a143.291733 143.291733 0 0 1 72.465067 136.533333 144.0768 144.0768 0 0 1-94.4128 122.88V525.312a25.258667 25.258667 0 0 0-13.2096-21.333333z m65.194667-96.699733l-4.573867-2.730667-154.862933-89.088a25.4976 25.4976 0 0 0-25.4976 0l-189.371733 107.861333v-74.683733a2.1504 2.1504 0 0 1 0.887466-1.911467l156.706134-89.1904a147.6608 147.6608 0 0 1 156.330666 6.724267 143.1552 143.1552 0 0 1 60.381867 142.404267v0.6144zM392.192 539.613867l-65.536-37.239467a2.525867 2.525867 0 0 1-1.262933-1.8432V322.389333a143.872 143.872 0 0 1 84.104533-130.116266 147.626667 147.626667 0 0 1 155.170133 19.626666l-4.608 2.56-154.999466 88.2688a25.3952 25.3952 0 0 0-12.765867 21.742934l-0.136533 215.1424h0.034133z m35.566933-75.707734l84.411734-47.991466 84.5824 47.991466v96.017067l-84.2752 47.991467-84.548267-47.991467-0.170667-96.017067z"
    fill="#FFFFFF"
    p-id="2194"
  ></path>
</svg>
`;
  const svgGemini = `
<svg
  width="24"
  height="24"
  viewBox="0 0 32 32"
  xmlns="http://www.w3.org/2000/svg"
>
  <title>Gemini</title>
  
  <!-- White circular background with safe area -->
  <circle cx="16" cy="16" r="24" fill="#ffffff"/>
  
  <!-- Icon centered: scale first, then translate to center -->
  <g transform="translate(16, 16) scale(1) translate(-12, -12)">
    <path
      d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
      fill="#3186FF"
    ></path>
    <path
      d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
      fill="url(#lobe-icons-gemini-fill-0)"
    ></path>
    <path
      d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
      fill="url(#lobe-icons-gemini-fill-1)"
    ></path>
    <path
      d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
      fill="url(#lobe-icons-gemini-fill-2)"
    ></path>
  </g>
  <defs>
    <linearGradient
      gradientUnits="userSpaceOnUse"
      id="lobe-icons-gemini-fill-0"
      x1="7"
      x2="11"
      y1="15.5"
      y2="12"
    >
      <stop stop-color="#08B962"></stop>
      <stop offset="1" stop-color="#08B962" stop-opacity="0"></stop>
    </linearGradient>
    <linearGradient
      gradientUnits="userSpaceOnUse"
      id="lobe-icons-gemini-fill-1"
      x1="8"
      x2="11.5"
      y1="5.5"
      y2="11"
    >
      <stop stop-color="#F94543"></stop>
      <stop offset="1" stop-color="#F94543" stop-opacity="0"></stop>
    </linearGradient>
    <linearGradient
      gradientUnits="userSpaceOnUse"
      id="lobe-icons-gemini-fill-2"
      x1="3.5"
      x2="17.5"
      y1="13.5"
      y2="12"
    >
      <stop stop-color="#FABC12"></stop>
      <stop offset=".46" stop-color="#FABC12" stop-opacity="0"></stop>
    </linearGradient>
  </defs>
</svg>
  `;
  const svgClaude = `
<svg
  t="1761630730959"
  class="icon"
  viewBox="0 0 1024 1024"
  version="1.1"
  xmlns="http://www.w3.org/2000/svg"
  p-id="6390"
  width="24"
  height="24"
>
  <path
    d="M198.4 678.4l198.4-115.2 6.4-12.8H243.2l-96-6.4-102.4-6.4-19.2-6.4-25.6-25.6v-12.8l19.2-12.8h32l64 6.4 96 6.4 70.4 6.4L384 512h19.2V492.8l-6.4-6.4-102.4-64-108.8-76.8-51.2-38.4-32-19.2-19.2-25.6-6.4-38.4 32-32h44.8l38.4 32 83.2 64L384 364.8l12.8 12.8 6.4-6.4-6.4-12.8L339.2 256l-64-108.8-25.6-38.4-6.4-25.6c0-12.8-6.4-19.2-6.4-32l32-44.8 19.2-6.4 44.8 6.4 19.2 12.8 25.6 57.6 44.8 96 64 128 19.2 38.4 6.4 38.4 6.4 12.8h6.4V384l6.4-70.4 12.8-89.6 12.8-115.2 6.4-32 19.2-38.4 32-19.2 25.6 12.8 19.2 32v19.2l-32 70.4-19.2 121.6-19.2 83.2h6.4l12.8-12.8 44.8-57.6 70.4-89.6 32-32 38.4-38.4 25.6-19.2h44.8l32 51.2-12.8 51.2-51.2 57.6-38.4 51.2-51.2 70.4-38.4 57.6v6.4h6.4l121.6-25.6 64-12.8 76.8-12.8 38.4 19.2 6.4 19.2-12.8 32-83.2 19.2-96 19.2-147.2 32 64 6.4h96l128 6.4 32 19.2 25.6 38.4-6.4 19.2-51.2 25.6-70.4-12.8-160-38.4-57.6-12.8h-6.4v6.4l44.8 44.8 83.2 76.8 108.8 102.4 6.4 25.6-12.8 19.2h-12.8l-96-70.4-38.4-32-83.2-70.4h-6.4v6.4l19.2 25.6 102.4 147.2 6.4 44.8-6.4 12.8-25.6 6.4-25.6-6.4-57.6-83.2-64-83.2-51.2-83.2-6.4 6.4-25.6 307.2-12.8 12.8-32 12.8-25.6-19.2-12.8-32 12.8-64 19.2-83.2 12.8-64 12.8-83.2 6.4-25.6h-6.4l-64 83.2-96 128-70.4 76.8-19.2 6.4-32-12.8v-25.6l19.2-25.6 102.4-128 64-83.2 38.4-51.2v-6.4l-268.8 172.8-51.2 12.8-19.2-19.2v-32l12.8-12.8 76.8-57.6z m0 0"
    fill="#D97757"
    p-id="6391"
  ></path>
</svg>
  `;
  const svgQwen = `
<svg
  t="1761614247284"
  class="icon"
  viewBox="0 0 1024 1024"
  version="1.1"
  xmlns="http://www.w3.org/2000/svg"
  p-id="5205"
  width="24"
  height="24"
>
  <path
    d="M255.872 279.808h-109.76a21.12 21.12 0 0 0-18.288 10.528L66.816 396a21.168 21.168 0 0 0 0 21.12L317.12 850.144h121.68l180.768-151.84-363.68-418.496z"
    fill="#615CED"
    p-id="5206"
  ></path>
  <path
    d="M182.72 617.76l-54.896 95.04a21.12 21.12 0 0 0 0 21.168l60.992 105.6c3.696 6.56 10.72 10.624 18.256 10.576h231.712L182.672 617.76h0.048z m658.608-211.28l54.848-95.024a21.12 21.12 0 0 0 0-21.152l-60.992-105.6a21.152 21.152 0 0 0-18.24-10.576l-500.208 0.224-60.864 105.36 41.12 232.544 544.336-105.824v0.048z"
    fill="#615CED"
    p-id="5207"
  ></path>
  <path
    d="M585.12 174.16l-54.848-95.04A21.12 21.12 0 0 0 512 68.48h-122a20.976 20.976 0 0 0-18.256 10.624l-55.456 96.032-60.4 104.576 329.264-105.552z m-146.288 676.032l54.8 95.056a21.12 21.12 0 0 0 18.352 10.496h122a21.168 21.168 0 0 0 18.24-10.544l249.92-433.312-60.816-105.376-221.952-80.592-180.544 524.224v0.048z"
    fill="#615CED"
    p-id="5208"
  ></path>
  <path
    d="M768.08 744.512h109.76a21.136 21.136 0 0 0 18.288-10.576l61.008-105.6a20.992 20.992 0 0 0 0-21.168l-55.456-96.032-60.4-104.624-73.2 338z"
    fill="#615CED"
    p-id="5209"
  ></path>
  <path
    d="M452.416 828.656l-243.36 0.928 60.32-105.504 121.856-0.464L145.84 302.64l121.872-0.288L512.848 722.88l-60.448 105.728v0.048z"
    fill="#FFFFFF"
    p-id="5210"
  ></path>
  <path
    d="M267.664 302.32l120.832-211.2 61.232 104.96-60.432 105.728 487.248-2-60.768 105.696-486.704 1.984-61.408-105.168z"
    fill="#FFFFFF"
    p-id="5211"
  ></path>
  <path
    d="M815.824 405.44l122.464 210.272-121.504 0.512-61.312-105.216L513.6 933.984l-61.184-105.424 241.6-422.56 121.856-0.544h-0.048z"
    fill="#FFFFFF"
    p-id="5212"
  ></path>
  <path
    d="M512.848 722.784l181.152-316.768-364.928 1.472 183.776 315.296z"
    fill="#605BEC"
    p-id="5213"
  ></path>
  <path
    d="M512.848 722.784L267.712 302.272l12.112-21.12 245.12 420.528-12.08 21.152v-0.048z"
    fill="#605BEC"
    p-id="5214"
  ></path>
  <path
    d="M329.072 407.584l486.752-2.032 12.24 21.024-486.752 2.032-12.24-21.024z"
    fill="#605BEC"
    p-id="5215"
  ></path>
  <path
    d="M694.048 406.016l-241.6 422.512-24.304 0.08 241.6-422.512 24.32-0.08z"
    fill="#605BEC"
    p-id="5216"
  ></path>
</svg>
  `;
  const svgBot = `
<svg
  t="1761636163452"
  class="icon"
  viewBox="0 0 1024 1024"
  version="1.1"
  xmlns="http://www.w3.org/2000/svg"
  p-id="11897"
  width="24"
  height="24"
>
  <path
    d="M392.533333 362.666667c-25.6 0-51.2 25.6-51.2 55.466666v64c0 29.866667 25.6 51.2 51.2 51.2s51.2-25.6 51.2-51.2V418.133333c4.266667-29.866667-21.333333-55.466667-51.2-55.466666z m238.933334 0c-29.866667 0-51.2 25.6-51.2 51.2v64c0 29.866667 25.6 51.2 51.2 51.2s51.2-25.6 51.2-51.2V418.133333c0-29.866667-25.6-55.466667-51.2-55.466666zM896 302.933333c-8.533333-85.333333-81.066667-153.6-170.666667-153.6H298.666667c-93.866667 0-170.666667 76.8-170.666667 170.666667v4.266667c-38.4 8.533333-64 42.666667-64 81.066666V512c0 38.4 25.6 72.533333 64 81.066667v110.933333c0 93.866667 76.8 170.666667 170.666667 170.666667h42.666666v42.666666c0 25.6 17.066667 42.666667 42.666667 42.666667 12.8 0 21.333333-4.266667 29.866667-12.8l72.533333-72.533333H725.333333c93.866667 0 170.666667-76.8 170.666667-170.666667v-132.266667c38.4-8.533333 64-42.666667 64-81.066666V384c0-38.4-29.866667-72.533333-64-81.066667z m-85.333333 401.066667c0 46.933333-38.4 85.333333-85.333334 85.333333h-268.8c-8.533333 0-17.066667 8.533333-17.066666 8.533334l-34.133334 34.133333V810.666667c0-12.8-8.533333-21.333333-21.333333-21.333334H298.666667c-46.933333 0-85.333333-38.4-85.333334-85.333333v-384c0-46.933333 38.4-85.333333 85.333334-85.333333h426.666666c46.933333 0 85.333333 38.4 85.333334 85.333333v384z"
    fill="#1296db"
    p-id="11898"
  ></path>
</svg>
  `;
  switch (chatType) {
    case 'gemini':
      return svgGemini;
    case 'claude':
      return svgClaude;
    case 'qwen':
      return svgQwen;
    case 'openai':
      return svgOpenai;
    default:
      return svgBot;
  }
}

function getManifestContent(title) {
  const str = `
{
  "name": "${title},
  "short_name": "${title}",
  "description": "${title} - 智能对话助手",
  "start_url": "./index.html",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#605bec",
  "orientation": "portrait-primary",
  "icons": [
    {
      "src": "favicon.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any maskable"
    }
  ],
  "categories": ["productivity", "utilities"],
  "lang": "zh-CN",
  "dir": "ltr"
}
  `;
  return str.trim();
}

function getHtmlContent(modelIds, tavilyKeys, title) {
  let html = `
<!DOCTYPE html>
<html lang="zh-Hans">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#605bec" />
    <meta name="description" content="OpenAI Chat - 智能对话助手" />
    <title>OpenAI Chat</title>

    <!-- Favicon -->
    <link rel="icon" type="image/svg+xml" href="favicon.svg" />

    <!-- Web App Manifest -->
    <link rel="manifest" href="site.webmanifest" />

    <!-- iOS Safari -->
    <link rel="apple-touch-icon" href="favicon.svg" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="OpenAI Chat" />

    <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
    <script src="https://unpkg.com/sweetalert2@11"></script>
    <script src="https://unpkg.com/showdown@2.1.0/dist/showdown.min.js"></script>
    <script src="https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
    <link
      rel="stylesheet"
      href="https://unpkg.com/github-markdown-css/github-markdown-light.css"
    />
    <script>
      var isWechat = new RegExp('wechat', 'i').test(window.navigator.userAgent);
      if (isWechat && document.title) {
        document.title = '✨ ' + document.title;
      }
      // IndexedDB 封装
      class OpenaiDB {
        constructor() {
          this.dbName = 'OpenaiChatDB';
          this.version = 1;
          this.storeName = 'chatData';
          this.db = null;
        }

        async init() {
          return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              this.db = request.result;
              resolve(this.db);
            };

            request.onupgradeneeded = event => {
              const db = event.target.result;
              if (!db.objectStoreNames.contains(this.storeName)) {
                db.createObjectStore(this.storeName, { keyPath: 'key' });
              }
            };
          });
        }

        async setItem(key, value) {
          if (!this.db) await this.init();

          return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(
              [this.storeName],
              'readwrite'
            );
            const store = transaction.objectStore(this.storeName);
            const request = store.put({ key, value });

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
          });
        }

        async getItem(key) {
          if (!this.db) await this.init();

          return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(
              [this.storeName],
              'readonly'
            );
            const store = transaction.objectStore(this.storeName);
            const request = store.get(key);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const result = request.result;
              resolve(result ? result.value : null);
            };
          });
        }

        // 计算IndexedDB存储空间大小（MB）
        async getTotalDataSize() {
          if (!this.db) await this.init();

          return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(
              [this.storeName],
              'readonly'
            );
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const allData = request.result;
              let totalSize = 0;

              // 计算所有数据的JSON字符串大小
              allData.forEach(item => {
                const jsonString = JSON.stringify(item);
                // 使用UTF-8编码计算字节数
                totalSize += new Blob([jsonString]).size;
              });

              // 转换为MB
              const sizeInMB = totalSize / (1024 * 1024);
              resolve(sizeInMB);
            };
          });
        }

        // 获取存储空间统计信息
        async getStorageStats() {
          if (!this.db) await this.init();

          const stats = {
            totalSizeMB: 0,
            itemCount: 0,
            largestItemKey: '',
            largestItemSizeMB: 0
          };

          return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(
              [this.storeName],
              'readonly'
            );
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const allData = request.result;
              let totalSize = 0;
              let maxSize = 0;
              let maxKey = '';

              allData.forEach(item => {
                const jsonString = JSON.stringify(item);
                const itemSize = new Blob([jsonString]).size;
                totalSize += itemSize;

                if (itemSize > maxSize) {
                  maxSize = itemSize;
                  maxKey = item.key || 'unknown';
                }
              });

              stats.totalSizeMB = totalSize / (1024 * 1024);
              stats.itemCount = allData.length;
              stats.largestItemKey = maxKey;
              stats.largestItemSizeMB = maxSize / (1024 * 1024);

              resolve(stats);
            };
          });
        }
      }

      // 全局实例
      window.openaiDB = new OpenaiDB();
    </script>
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      body {
        position: relative;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
          sans-serif;
        background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%);
        min-height: 100vh;
        min-height: 100dvh;
        color: #333;
      }

      [v-cloak] {
        display: none;
      }

      .hidden {
        display: none !important;
      }

      /* 滚动条颜色浅一些 */
      body.pc *::-webkit-scrollbar {
        width: 10px;
        background-color: #f9fafb;
      }

      body.pc *::-webkit-scrollbar-thumb:hover {
        background-color: #d1d5db;
      }

      body.pc *::-webkit-scrollbar-thumb {
        background-color: #e5e7eb;
        border-radius: 5px;
      }

      body.pc *::-webkit-scrollbar-track {
        background-color: #f9fafb;
      }

      button,
      label {
        user-select: none;
      }

      label * {
        vertical-align: middle;
      }

      input::placeholder,
      textarea::placeholder {
        color: #a0aec0;
        user-select: none;
      }

      .container {
        max-width: 1200px;
        margin: 0 auto;
        padding: 20px;
        height: 100vh;
        display: flex;
        gap: 20px;
      }

      .sidebar {
        width: 300px;
        background: rgba(255, 255, 255, 0.95);
        border-radius: 15px;
        padding: 20px;
        backdrop-filter: blur(10px);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        display: flex;
        flex-direction: column;
      }

      .sidebar.mobile {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100vh;
        height: 100dvh;
        z-index: 1000;
        padding: 20px;
        transform: translateX(-100%);
        transition: transform 0.3s ease;
        backdrop-filter: blur(15px);
        background: rgba(255, 255, 255, 0.98);
        border-radius: 0;
      }

      .sidebar.mobile.show {
        transform: translateX(0);
      }

      .sidebar-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100vh;
        height: 100dvh;
        background: rgba(0, 0, 0, 0.5);
        z-index: 999;
        opacity: 0;
        visibility: hidden;
        transition: all 0.3s ease;
      }

      .sidebar-overlay.show {
        opacity: 1;
        visibility: visible;
      }

      .mobile-menu-btn {
        position: fixed;
        top: 20px;
        left: 20px;
        width: 44px;
        height: 44px;
        background: rgba(255, 255, 255, 0.35);
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        cursor: pointer;
        z-index: 1001;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        color: #4a5568;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        transition: all 0.2s ease;
      }

      .mobile-menu-btn:hover {
        /* background: #f7fafc; */
        transform: scale(1.05);
      }

      .main-chat {
        flex: 1 1 0;
        background: rgba(255, 255, 255, 0.95);
        border-radius: 15px;
        backdrop-filter: blur(10px);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        display: flex;
        flex-direction: column;
        min-width: 0; /* 防止flex子项撑大父容器 */
        overflow: hidden; /* 确保内容不会溢出 */
      }

      .header {
        position: relative;
        padding: 18px 32px 18px 18px;
        border-bottom: 1px solid #e1e5e9;
        display: flex;
        justify-content: between;
        align-items: center;
        gap: 15px;
        flex-wrap: wrap;
      }

      .header h2 {
        display: flex;
        align-items: center;
        margin: 0;
        color: #495057;
        gap: 6px;
        user-select: none;
      }

      .header .share-btn {
        position: absolute;
        top: 0;
        bottom: 0;
        right: 18px;
        margin: auto 0;
        height: 32px;
        background: none;
        border: 1px solid #e1e5e9;
        color: #666;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
      }

      .header .share-btn:hover {
        background: #f8f9fa;
        border-color: #a8edea;
        color: #2d3748;
        transform: translateY(-1px);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
      }

      .api-key-section {
        margin-bottom: 20px;
      }

      .api-key-input {
        width: 100%;
        padding: 12px;
        border: 2px solid #e1e5e9;
        border-radius: 8px;
        font-size: 14px;
        transition: border-color 0.3s;
      }

      .api-key-input:focus {
        outline: none;
        border-color: #a8edea;
      }

      .model-select {
        padding: 8px 12px;
        border: 2px solid #e1e5e9;
        border-radius: 6px;
        background: white;
        font-size: 14px;
        cursor: pointer;
        user-select: none;
      }

      .model-wrap {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: nowrap;
      }

      .model-search-label {
        display: flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
        cursor: pointer;
        font-size: 14px;
        color: #4a5568;
      }

      .model-search-label:hover {
        color: #2d3748;
      }

      .model-search {
        cursor: pointer;
        width: 16px;
        height: 16px;
        margin: 0;
      }

      .sessions {
        flex: 1;
        overflow-x: hidden;
        overflow-y: auto;
      }

      .session-item {
        padding: 10px 12px;
        margin-bottom: 8px;
        background: #f8f9fa;
        border: 1px solid transparent;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .session-item:hover {
        background: #e9ecef;
        /* transform: translateX(3px); */
      }

      .session-item.active {
        background: #ffffff;
        color: #2d3748;
        border: 1px solid #a8edea;
        box-shadow: 0 2px 8px rgba(168, 237, 234, 0.2);
      }

      .session-title {
        font-size: 14px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        margin-right: 8px;
      }

      .delete-btn {
        background: none;
        border: none;
        color: #dc3545;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 16px;
        opacity: 0.7;
      }

      .delete-btn:hover {
        opacity: 1;
        background: rgba(220, 53, 69, 0.1);
      }

      .new-session-btn {
        width: 100%;
        padding: 12px;
        background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%);
        color: #333;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        margin-bottom: 20px;
        transition: all 0.2s ease;
      }

      .new-session-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(76, 175, 80, 0.12);
        color: #2d3748;
      }

      .messages-container {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 15px;
        min-width: 0; /* 防止内容撑大容器 */
      }

      .message-content {
        flex: 1;
        line-height: 1.5;
        white-space: pre-wrap;
      }

      .input-area {
        padding: 20px;
        border-top: 1px solid #e1e5e9;
        display: flex;
        gap: 10px;
        align-items: flex-end;
        position: relative;
      }

      .input-wrapper {
        flex: 1;
        position: relative;
      }

      .message-input {
        display: block;
        width: 100%;
        min-height: 44px;
        max-height: 144px;
        padding: 9px 16px;
        padding-right: 34px;
        border: 2px solid #e1e5e9;
        border-radius: 22px;
        resize: none;
        font-family: inherit;
        font-size: 14px;
        line-height: 1.4;
        transition: border-color 0.3s;
      }

      .message-input.can-upload {
        padding-left: 44px;
      }

      .message-input:focus {
        outline: none;
        border-color: #a8edea;
      }

      .clear-btn {
        position: absolute;
        right: 12px;
        top: 50%;
        transform: translateY(-50%);
        width: 20px;
        height: 20px;
        background: #cbd5e0;
        border: none;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 15px;
        color: #fff;
        transition: all 0.2s ease;
        opacity: 0.7;
      }

      .clear-btn:hover {
        background: #a0aec0;
        opacity: 1;
        transform: translateY(-50%) scale(1.1);
      }

      .send-btn {
        padding: 12px 18px;
        background: #4299e1;
        color: white;
        border: none;
        border-radius: 22px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        transition: all 0.2s ease;
        min-width: 60px;
        height: 44px;
        box-shadow: 0 2px 4px rgba(66, 153, 225, 0.3);
      }

      .send-btn:hover:not(:disabled) {
        background: #3182ce;
        transform: translateY(-1px);
        box-shadow: 0 4px 8px rgba(66, 153, 225, 0.4);
      }

      .send-btn:disabled {
        background: #cbd5e0;
        color: #a0aec0;
        cursor: not-allowed;
        transform: none;
        box-shadow: none;
      }

      /* 上传图片按钮 */
      .upload-image-btn {
        position: absolute;
        left: 12px;
        top: 50%;
        transform: translateY(-50%);
        width: 28px;
        height: 28px;
        background: none;
        border: none;
        cursor: pointer;
        font-size: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.6;
        transition: all 0.2s ease;
        padding: 0;
      }

      .upload-image-btn:hover:not(:disabled) {
        opacity: 1;
        transform: translateY(-50%) scale(1.1);
      }

      .upload-image-btn:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }

      /* 上传的图片标签容器 */
      .uploaded-images-tags {
        position: absolute;
        top: -44px;
        left: 0;
        display: flex;
        gap: 8px;
        padding-left: 20px;
        z-index: 10;
      }

      /* 单个图片标签 */
      .image-tag {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px 4px 4px;
        background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%);
        border-radius: 20px;
        font-size: 12px;
        color: #333;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
      }

      .image-tag img {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        object-fit: cover;
        border: 2px solid white;
      }

      .image-tag-text {
        font-weight: 500;
        white-space: nowrap;
      }

      .image-tag-remove {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.15);
        border: none;
        color: white;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        padding: 0;
      }

      .image-tag-remove:hover {
        background: rgba(220, 53, 69, 0.8);
        transform: scale(1.1);
      }

      /* 问题区域的图片链接 */
      .question-images {
        margin-top: 8px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .question-images a {
        display: inline-block;
        padding: 4px 10px;
        background: rgba(168, 237, 234, 0.3);
        border: 1px solid rgba(168, 237, 234, 0.5);
        border-radius: 12px;
        color: #2d3748;
        text-decoration: none;
        font-size: 12px;
        transition: all 0.2s ease;
      }

      .question-images a:hover {
        background: rgba(168, 237, 234, 0.5);
        border-color: #a8edea;
        transform: translateY(-1px);
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        cursor: pointer;
      }

      /* SweetAlert2 图片预览样式 */
      .swal-image-preview {
        max-width: 90vw !important;
        max-height: 90vh !important;
        object-fit: contain !important;
      }

      .loading {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #a8edea;
        padding: 0px 16px 16px;
      }

      .spinner {
        width: 20px;
        height: 20px;
        border: 2px solid #e1e5e9;
        border-top: 2px solid #a8edea;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        0% {
          transform: rotate(0deg);
        }

        100% {
          transform: rotate(360deg);
        }
      }

      /* 移动端适配 */
      @media (max-width: 768px) {
        body {
          overflow: hidden;
        }

        .container {
          flex-direction: column;
          padding: 10px;
          height: 100vh;
          height: 100dvh;
          position: relative;
        }

        div.swal2-html-container {
          padding-left: 1em;
          padding-right: 1em;
        }

        .main-chat {
          flex: 1;
          min-height: 0;
          width: 100%;
          margin-top: 0;
        }

        .header {
          padding: 15px;
          padding-left: 70px;
          flex-direction: column;
          align-items: stretch;
          gap: 10px;
        }

        .header .share-btn {
          top: 16px;
          bottom: auto;
          margin: 0;
        }

        .model-wrap {
          width: 100%;
        }

        .model-select {
          flex: 1;
          min-width: 0;
        }

        .model-search-label {
          flex-shrink: 0;
          font-size: 13px;
        }

        .input-area {
          padding: 12px;
          gap: 6px;
        }

        .input-wrapper {
          flex: 1;
        }

        .message-input {
          font-size: 16px;
          /* 防止iOS缩放 */
        }

        .sessions {
          max-height: none;
          flex: 1;
        }

        /* 移动端图片标签样式 */
        .uploaded-images-tags {
          top: -36px;
        }

        .image-tag {
          padding: 3px 6px 3px 3px;
          font-size: 11px;
        }

        .image-tag img {
          width: 24px;
          height: 24px;
        }

        .content-section > h4 small {
          position: relative;
          display: inline-block;
          vertical-align: middle;
          white-space: nowrap;
          max-width: 13em;
          padding-bottom: 1px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      }

      .empty-state {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        color: #6c757d;
        text-align: center;
        padding: 40px;
      }

      .empty-state h3 {
        margin-bottom: 10px;
        color: #495057;
      }

      .error-message {
        background: #f8d7da;
        color: #721c24;
        padding: 12px 16px;
        border-radius: 8px;
        margin: 10px 0;
        border: 1px solid #f5c6cb;
      }

      .role-setting {
        margin-bottom: 15px;
      }

      .role-textarea {
        width: 100%;
        min-height: 90px;
        max-height: 30vh;
        padding: 12px;
        border: 2px solid #e1e5e9;
        border-radius: 8px;
        font-size: 14px;
        font-family: inherit;
        resize: vertical;
        transition: border-color 0.3s;
      }

      .role-textarea:focus {
        outline: none;
        border-color: #a8edea;
      }

      .copy-btn,
      .reset-btn {
        background: none;
        border: 1px solid #e1e5e9;
        color: #666;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        margin-left: 8px;
        opacity: 0;
        transition: all 0.2s;
      }

      .reset-btn {
        padding: 3px 8px;
        opacity: 1 !important;
      }

      .copy-btn:hover {
        background: #f8f9fa;
        border-color: #a8edea;
      }

      .content-section:hover .copy-btn {
        opacity: 1;
      }

      .session-content {
        display: flex;
        flex-direction: column;
        gap: 15px;
        padding: 8px;
      }

      .content-section {
        flex: 0 0 auto;
        position: relative;
        padding: 15px;
        border-radius: 8px;
        border: 1px solid #e1e5e9;
      }

      .content-section > h4 {
        margin: 0 0 10px 0;
        color: #495057;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .content-section > h4 small {
        color: #6c757d;
        font-size: 12px;
        font-weight: normal;
      }

      .content-section > h4:has(input:checked) + .rendered-content {
        position: relative;
        max-height: 10em;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .role-section {
        position: relative;
        background: #f8f9fa;
      }

      .role-section:has(input:checked):after {
        content: '';
        display: block;
        position: absolute;
        z-index: 1;
        left: 0;
        right: 0;
        bottom: 0;
        height: 50%;
        background: linear-gradient(
          to bottom,
          rgba(255, 255, 255, 0) 0%,
          #f8f9fa 85%
        );
        pointer-events: none;
      }

      .question-section {
        background: linear-gradient(
          135deg,
          rgba(168, 237, 234, 0.18),
          rgba(254, 214, 227, 0.18)
        );
      }

      .answer-section {
        background: #ffffff;
      }

      .markdown-body {
        background: none;
        white-space-collapse: collapse;
        overflow-x: auto;
        max-width: 100%;
        word-wrap: break-word;
      }

      /* 表格样式 - 防止溢出 */
      .markdown-body table {
        max-width: 100%;
        width: 100%;
        table-layout: auto;
        border-collapse: collapse;
        margin: 1em 0;
        font-size: 0.9em;
      }

      .markdown-body th,
      .markdown-body td {
        padding: 8px 12px;
        border: 1px solid #e1e5e9;
        text-align: left;
        vertical-align: top;
        word-break: break-word;
        min-width: 0;
      }

      .markdown-body th {
        background-color: #f8f9fa;
        font-weight: 600;
      }

      /* 表格容器 - 提供水平滚动 */
      .rendered-content {
        position: relative;
        line-height: 1.6;
        overflow-x: auto;
        overflow-y: visible;
        max-width: 100%;
      }

      .rendered-content p {
        margin: 0.5em 0;
      }

      .rendered-content code {
        background: #f1f3f5;
        padding: 2px 4px;
        border-radius: 3px;
        white-space: pre-wrap !important;
        word-break: break-all !important;
        font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
        font-size: 0.9em;
      }

      .rendered-content pre {
        background: #f8f9fa;
        border: 1px solid #e1e5e9;
        padding: 15px;
        border-radius: 8px;
        overflow-x: auto;
        white-space-collapse: collapse;
        margin: 1em 0;
      }

      .rendered-content pre code {
        background: none;
        padding: 0;
      }

      .rendered-content blockquote {
        border-left: 4px solid #a8edea;
        margin: 1em 0;
        padding-left: 1em;
        color: #666;
      }

      .streaming-answer {
        min-height: 1.5em;
      }
    </style>
  </head>

  <body>
    <div id="app">
      <!-- 移动端菜单按钮 -->
      <button
        v-cloak
        v-show="isMobile"
        class="mobile-menu-btn"
        style="display: none"
        @click="toggleSidebar"
      >
        {{ !showSidebar ? '☰' : '＜' }}
      </button>
      <!-- 移动端遮罩层 -->
      <div
        class="sidebar-overlay"
        :class="{ show: showSidebar && isMobile }"
        v-cloak
        @click="hideSidebar"
      ></div>
      <div class="container">
        <!-- 侧边栏 -->
        <div
          class="sidebar"
          :class="{ show: showSidebar || !isMobile, mobile: isMobile }"
          v-cloak
        >
          <!-- API Key 设置 -->
          <div class="api-key-section">
            <label
              for="apiKey"
              style="display: block; margin-bottom: 8px; font-weight: 500"
              @dblclick="reloadPage()"
              >API Key:</label
            >
            <input
              type="password"
              id="apiKey"
              v-model="apiKey"
              @input="saveApiKey"
              class="api-key-input"
              placeholder="请输入您的 OpenAI API Key"
              autocomplete="new-password"
            />
          </div>
          <!-- 角色设定 -->
          <div class="role-setting">
            <label
              for="rolePrompt"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
                font-weight: 500;
              "
            >
              <span>角色设定 (可选):</span>
              <button
                v-if="globalRolePrompt"
                class="reset-btn"
                @click="clearRolePrompt"
                title="清空角色设定"
              >
                清空
              </button>
            </label>
            <textarea
              id="rolePrompt"
              v-model="globalRolePrompt"
              @input="updateGlobalRolePrompt"
              class="role-textarea"
              placeholder="输入系统提示词或角色设定..."
            >
            </textarea>
          </div>
          <!-- 新建会话按钮 -->
          <button @click="createNewSession" class="new-session-btn">
            + 新建会话
          </button>
          <!-- 会话列表 -->
          <div class="sessions">
            <div
              v-for="session in sessions"
              :key="session.id"
              @click="switchSession(session.id)"
              :class="['session-item', { active: currentSessionId === session.id }]"
              :title="session.summary || session.title || '新会话'"
            >
              <div class="session-title">
                {{ session.summary || session.title || '新会话' }}
              </div>
              <button
                @click.stop="deleteSession(session.id)"
                class="delete-btn"
                title="删除会话"
              >
                ×
              </button>
            </div>
          </div>
        </div>
        <!-- 主聊天区域 -->
        <div class="main-chat">
          <!-- 头部 -->
          <div class="header">
            <h2 @click="showAbout" style="cursor: pointer">
              <img
                src="./favicon.svg"
                alt=""
                width="24"
                height="24"
                style="flex: 0 0 auto; line-height: 1"
              />
              <span>OpenAI Chat</span>
            </h2>
            <div class="model-wrap">
              <select
                v-model="selectedModel"
                class="model-select"
                id="selectedModel"
                :disabled="isLoading || isStreaming"
                @change="saveData()"
              >
                <option
                  v-for="i in availableModels"
                  :key="i.value"
                  :value="i.value"
                >
                  {{ i.label }}
                </option>
              </select>
              <label for="needSearch" class="model-search-label">
                <input
                  type="checkbox"
                  v-model="needSearch"
                  class="model-search"
                  id="needSearch"
                />
                <span>联网搜索</span>
              </label>
            </div>
            <button
              v-if="currentSession && currentSession.answer && !isLoading && !isStreaming"
              class="share-btn"
              @click="shareSession"
            >
              分享问答
            </button>
          </div>
          <!-- 消息区域 -->
          <div class="messages-container" ref="messagesContainer">
            <div
              v-if="!currentSession || (!currentSession.question && !currentSession.answer)"
              class="empty-state"
            >
              <h3>开始与 AI 对话</h3>
              <p>选择一个模型并输入您的问题</p>
            </div>
            <div
              v-if="currentSession && (currentSession.question || currentSession.answer)"
              class="session-content"
            >
              <!-- 角色设定显示 -->
              <div
                v-if="currentSession.role.trim()"
                class="content-section role-section"
              >
                <h4>
                  <span>
                    <label for="fold">
                      <span>角色设定　</span>
                      <input type="checkbox" id="fold" v-model="isFoldRole" />
                      <small>&nbsp;折叠</small>
                    </label>
                  </span>
                  <button
                    @click="copyToClipboard(currentSession.role)"
                    class="copy-btn"
                    title="复制角色设定"
                  >
                    复制
                  </button>
                </h4>
                <div
                  class="rendered-content markdown-body"
                  v-html="renderMarkdown(currentSession.role)"
                ></div>
              </div>
              <!-- 问题1 -->
              <div
                v-if="currentSession.question"
                class="content-section question-section"
              >
                <h4>
                  <span>
                    <span>问题</span>
                    <small v-if="currentSession.createdAt"
                      >&emsp;{{ new
                      Date(currentSession.createdAt).toLocaleString() }}</small
                    >
                  </span>
                  <div>
                    <button
                      v-if="!isLoading && !isStreaming && !currentSession.question2"
                      class="copy-btn"
                      title="编辑问题"
                      @click="editQuestion()"
                    >
                      编辑
                    </button>
                    <button
                      @click="copyToClipboard(currentSession.question)"
                      class="copy-btn"
                      title="复制问题"
                    >
                      复制
                    </button>
                  </div>
                </h4>
                <div
                  class="rendered-content markdown-body"
                  v-html="renderMarkdown(currentSession.question)"
                ></div>
                <!-- 图片链接 -->
                <div
                  v-if="currentSession.images && currentSession.images.length > 0"
                  class="question-images"
                >
                  <a
                    v-for="(img, index) in currentSession.images"
                    :key="index"
                    href="javascript:void(0)"
                    @click="previewImage(img)"
                  >
                    📎 图片{{ index + 1 }}
                  </a>
                </div>
              </div>
              <!-- 回答1 -->
              <div
                v-if="currentSession.answer || isStreaming"
                class="content-section answer-section"
              >
                <h4>
                  <span>
                    <span>回答</span>
                    <small v-if="currentSession.model"
                      >&emsp;{{ getModelName(currentSession.model) }}</small
                    >
                  </span>
                  <div v-if="!isStreaming">
                    <button
                      v-if="!currentSession.question2"
                      class="copy-btn"
                      title="删除并重新回答"
                      @click="regenerateAnswer()"
                    >
                      重新回答
                    </button>
                    <button
                      class="copy-btn"
                      title="复制回答"
                      @click="copyToClipboard(currentSession.answer)"
                    >
                      复制
                    </button>
                  </div>
                </h4>
                <div
                  class="rendered-content markdown-body streaming-answer"
                  v-html="renderMarkdown(isStreaming && !currentSession.question2 ? streamingContent : currentSession.answer)"
                  @click="answerClickHandler"
                ></div>
              </div>
              <!-- 问题2 -->
              <div
                v-if="currentSession.question2"
                class="content-section question-section"
              >
                <h4>
                  <span>
                    <span>追问</span>
                    <small v-if="currentSession.createdAt2"
                      >&emsp;{{ new
                      Date(currentSession.createdAt2).toLocaleString() }}</small
                    >
                  </span>
                  <div>
                    <button
                      v-if="!isLoading && !isStreaming"
                      class="copy-btn"
                      title="编辑追问"
                      @click="editQuestion()"
                    >
                      编辑
                    </button>
                    <button
                      @click="copyToClipboard(currentSession.question2)"
                      class="copy-btn"
                      title="复制问题"
                    >
                      复制
                    </button>
                  </div>
                </h4>
                <div
                  class="rendered-content markdown-body"
                  v-html="renderMarkdown(currentSession.question2)"
                ></div>
                <!-- 图片链接 -->
                <div
                  v-if="currentSession.images2 && currentSession.images2.length > 0"
                  class="question-images"
                >
                  <a
                    v-for="(img, index) in currentSession.images2"
                    :key="index"
                    href="javascript:void(0)"
                    @click="previewImage(img)"
                  >
                    📎 图片{{ index + 1 }}
                  </a>
                </div>
              </div>
              <!-- 回答2 -->
              <div
                v-if="currentSession.question2 && (currentSession.answer2 || isStreaming)"
                class="content-section answer-section"
              >
                <h4>
                  <span>
                    <span>回答</span>
                    <small v-if="currentSession.model2"
                      >&emsp;{{ getModelName(currentSession.model2) }}</small
                    >
                  </span>
                  <div v-if="!isStreaming">
                    <button
                      class="copy-btn"
                      title="删除并重新回答"
                      @click="regenerateAnswer()"
                    >
                      重新回答
                    </button>
                    <button
                      class="copy-btn"
                      title="复制回答"
                      @click="copyToClipboard(currentSession.answer2)"
                    >
                      复制
                    </button>
                  </div>
                </h4>
                <div
                  class="rendered-content markdown-body streaming-answer"
                  v-html="renderMarkdown(isStreaming ? streamingContent : currentSession.answer2)"
                  @click="answerClickHandler"
                ></div>
              </div>
            </div>
            <div v-if="isLoading && !isStreaming" class="loading">
              <div class="spinner"></div>
              <span>AI 正在思考中...</span>
            </div>

            <div v-if="errorMessage" class="error-message">
              {{ errorMessage }}
            </div>
          </div>
          <!-- 输入区域 -->
          <div class="input-area">
            <!-- 上传的图片标签 -->
            <div v-if="uploadedImages.length > 0" class="uploaded-images-tags">
              <div
                v-for="(img, index) in uploadedImages"
                :key="index"
                class="image-tag"
              >
                <img :src="img.url" :alt="'图片' + (index + 1)" />
                <span class="image-tag-text">图片{{ index + 1 }}</span>
                <button
                  class="image-tag-remove"
                  @click="removeImage(index)"
                  title="移除图片"
                >
                  ×
                </button>
              </div>
            </div>

            <div class="input-wrapper">
              <!-- 上传图片按钮 -->
              <button
                v-if="canUpload"
                class="upload-image-btn"
                @click="triggerImageUpload"
                :disabled="!canInput || uploadedImages.length >= 2 || isUploadingImage"
                :title="uploadedImages.length >= 2 ? '最多上传2张图片' : '上传图片'"
              >
                📎
              </button>
              <input
                type="file"
                ref="imageInput"
                accept="image/*"
                style="display: none"
                @change="handleImageSelect"
              />

              <textarea
                v-model="messageInput"
                @input="onInputChange"
                @keydown="handleKeyDown"
                @paste="handlePaste"
                class="message-input"
                :class="{'can-upload': canUpload}"
                :placeholder="inputPlaceholder"
                :disabled="!canInput"
                rows="1"
                ref="messageInputRef"
              ></textarea>
              <button
                v-show="messageInput.trim()"
                @click="clearInput"
                class="clear-btn"
                title="清空输入"
              >
                ×
              </button>
            </div>
            <button
              v-if="isCurrentEnd"
              class="send-btn"
              @click="createNewSession"
            >
              新会话
            </button>
            <button
              v-else
              @click="sendMessage"
              :disabled="!canSend"
              class="send-btn"
            >
              发送
            </button>
          </div>
        </div>
      </div>

      <!-- 隐藏的搜索结果模板 -->
      <div v-if="searchRes" ref="searchResTemplate" style="display: none">
        <div
          style="
            text-align: left;
            max-height: 70vh;
            overflow-y: auto;
            padding: 10px;
          "
        >
          <!-- 搜索查询 -->
          <div style="margin-bottom: 20px">
            <h3 style="margin: 0 0 10px; color: #333; font-size: 16px">
              🔍 搜索查询
            </h3>
            <div
              style="
                padding: 12px;
                background: #f8f9fa;
                border-radius: 8px;
                border-left: 4px solid #a8edea;
              "
            >
              <strong style="color: #2d3748; font-size: 15px"
                >{{ searchRes.query }}</strong
              >
            </div>
          </div>

          <!-- AI 总结答案 -->
          <div v-if="searchRes.answer" style="margin-bottom: 20px">
            <h3 style="margin: 0 0 10px; color: #333; font-size: 16px">
              💡 AI 总结
            </h3>
            <div
              style="
                padding: 12px;
                background: #fff3cd;
                border-radius: 8px;
                border-left: 4px solid #ffc107;
                line-height: 1.6;
                color: #666;
                font-size: 14px;
              "
            >
              {{ searchRes.answer }}
            </div>
          </div>

          <!-- 搜索结果列表 -->
          <div v-if="searchRes.results && searchRes.results.length > 0">
            <div style="margin-bottom: 10px">
              <h3 style="margin: 0 0 10px; color: #333; font-size: 16px">
                📚 搜索结果 ({{ searchRes.results.length }} 条)
              </h3>
            </div>

            <div
              v-for="(result, index) in searchRes.results"
              :key="index"
              style="
                margin-bottom: 15px;
                padding: 15px;
                background: #ffffff;
                border: 1px solid #e1e5e9;
                border-radius: 8px;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
              "
            >
              <div style="margin-bottom: 8px">
                <span
                  style="
                    display: inline-block;
                    padding: 2px 8px;
                    background: #a8edea;
                    color: #2d3748;
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: 500;
                    margin-right: 8px;
                  "
                >
                  {{ index + 1 }}
                </span>
                <strong style="color: #2d3748; font-size: 14px">
                  {{ result.title || '无标题' }}
                </strong>
              </div>

              <div
                v-if="result.content"
                style="
                  margin: 8px 0;
                  color: #666;
                  font-size: 13px;
                  line-height: 1.5;
                "
              >
                {{ result.content.length > 200 ? result.content.slice(0, 200) +
                '...' : result.content }}
              </div>

              <div v-if="result.url" style="margin-top: 8px">
                <a
                  :href="result.url"
                  target="_blank"
                  style="
                    line-height: 1;
                    color: #0066cc;
                    text-decoration: none;
                    font-size: 12px;
                    word-break: break-all;
                  "
                >
                  🔗 {{ result.url }}
                </a>
              </div>
            </div>
          </div>

          <!-- 无结果提示 -->
          <div
            v-else
            style="
              padding: 20px;
              text-align: center;
              color: #999;
              font-size: 14px;
            "
          >
            暂无搜索结果
          </div>
        </div>
      </div>
    </div>

    <script>
      const { createApp } = Vue;

      window.app = createApp({
        data() {
          return {
            apiKey: '',
            messageInput: '',
            isLoading: false,
            errorMessage: '',
            selectedModel: 'gpt-5-mini',
            availableModels: ['$MODELS_PLACEHOLDER$'],
            sessions: [],
            currentSessionId: null,
            isFoldRole: false,
            converter: null,
            globalRolePrompt: '',
            isMobile: window.innerWidth <= 768,
            showSidebar: false,
            isStreaming: false,
            streamingContent: '',
            abortController: null,
            uploadedImages: [], // 待发送的图片列表 [{ url: string, file: File }]
            isUploadingImage: false,
            needSearch: false,
            searchRes: null
          };
        },
        computed: {
          isPC() {
            return !this.isMobile;
          },
          hostname() {
            return window.location.hostname;
          },
          canUpload() {
            const isSite = this.hostname.endsWith('.keyi.ma');
            const isClaude = this.selectedModel.startsWith('claude');
            return isSite && !isClaude;
          },
          currentSession() {
            return this.sessions.find(s => s.id === this.currentSessionId);
          },
          isCurrentEnd() {
            const session = this.currentSession;
            return session && session.answer && session.answer2;
          },
          isTotallyBlank() {
            const list = this.sessions || [];
            return !list.some(s => s.answer);
          },
          inputPlaceholder() {
            const session = this.currentSession || {};
            if (!this.apiKey) {
              return '请先在左上角设置 API Key';
            } else if (this.isLoading) {
              return 'AI 正在思考中...';
            } else if (this.isStreaming) {
              return 'AI 正在生成回答...';
            } else if (this.isUploadingImage) {
              return '图片上传中...';
            } else if (session.answer2) {
              return '当前会话已结束';
            } else if (session.answer) {
              return '输入您的追问...';
            } else {
              return '输入您的问题...';
            }
          },
          canInput() {
            const session = this.currentSession;
            return (
              this.apiKey &&
              !this.isLoading &&
              !this.isStreaming &&
              (!session || !session.answer2)
            );
          },
          canSend() {
            return (
              (this.messageInput.trim() || this.uploadedImages.length > 0) &&
              !this.isUploadingImage &&
              this.canInput
            );
          }
        },
        async mounted() {
          this.initModels();

          // 初始化 IndexedDB
          await window.openaiDB.init();

          this.converter = new showdown.Converter({
            simpleLineBreaks: true,
            simplifiedAutoLink: true,
            openLinksInNewWindow: true,
            excludeTrailingPunctuationFromURLs: true,
            literalMidWordUnderscores: true,
            strikethrough: true,
            tasklists: true,
            tables: true
          });

          await this.loadData();
          if (this.sessions.length === 0) {
            this.createNewSession();
          }
          // 检测是否为移动端
          this.checkMobile();
          window.addEventListener('resize', this.checkMobile);

          // 计算OpenAI DB总数据量
          const totalDataSize = await window.openaiDB.getTotalDataSize();
          if (totalDataSize > 2) {
            Swal.fire({
              title: '数据量过大',
              text:
                '当前存储的数据量为' +
                totalDataSize.toFixed(2) +
                ' MB，超过了 2MB，可能会影响性能。建议清理一些旧会话。',
              icon: 'warning',
              confirmButtonText: '知道了'
            });
          }
        },

        beforeUnmount() {
          window.removeEventListener('resize', this.checkMobile);
        },
        watch: {
          messageInput() {
            this.autoResizeTextarea();
          },
          streamingContent() {
            this.stickToBottom();
          }
        },
        methods: {
          initModels() {
            const firstItem = this.availableModels[0];
            if (typeof firstItem === 'string') {
              this.availableModels = firstItem
                .trim()
                .split(',')
                .map(id => id.trim())
                .filter(id => id)
                .map(id => {
                  if (id.includes('=')) {
                    const [value, label] = id.split('=').map(s => s.trim());
                    return { value, label };
                  }
                  const parts = id.split('-');
                  parts.forEach((part, index) => {
                    if (part.includes('/')) {
                      const idx = part.indexOf('/');
                      part =
                        part.slice(0, idx + 1) +
                        (part.charAt(idx + 1) || '').toUpperCase() +
                        part.slice(idx + 2);
                    }
                    parts[index] = part.charAt(0).toUpperCase() + part.slice(1);
                  });
                  return {
                    value: id,
                    label: parts.join(' ')
                  };
                });
            }
          },
          reloadPage() {
            location.reload();
          },
          // 备用的花括号解析方法，用于处理特殊情况
          parseWithBraceMethod(inputBuffer) {
            let buffer = inputBuffer;
            let braceCount = 0;
            let startIndex = -1;
            let processed = false;

            for (let i = 0; i < buffer.length; i++) {
              if (buffer[i] === '{') {
                if (braceCount === 0) {
                  startIndex = i;
                }
                braceCount++;
              } else if (buffer[i] === '}') {
                braceCount--;
                if (braceCount === 0 && startIndex !== -1) {
                  // 找到完整的JSON对象
                  const jsonStr = buffer.substring(startIndex, i + 1);

                  try {
                    const data = JSON.parse(jsonStr);

                    if (
                      data.candidates &&
                      data.candidates[0] &&
                      data.candidates[0].content
                    ) {
                      const content = data.candidates[0].content;
                      const delta =
                        (content &&
                          content.parts[0] &&
                          content.parts[0].text) ||
                        '';
                      if (delta) {
                        const shouldScroll = !this.streamingContent;
                        this.streamingContent += delta;
                        if (shouldScroll) {
                          this.scrollToBottom();
                        }
                      }
                      processed = true;
                    }
                  } catch (parseError) {
                    console.warn(
                      '花括号解析方法也失败:',
                      parseError,
                      'JSON:',
                      jsonStr
                    );
                  }

                  // 移除已处理的部分
                  buffer = buffer.substring(i + 1);
                  i = -1; // 重置循环
                  startIndex = -1;
                  braceCount = 0;
                }
              }
            }

            return { buffer, processed };
          },

          sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
          },
          async loadData() {
            // 加载 API Key
            this.apiKey =
              (await window.openaiDB.getItem('openai_api_key')) || '';

            // 加载全局角色设定
            this.globalRolePrompt =
              (await window.openaiDB.getItem('openai_global_role_prompt')) ||
              '';

            // 加载会话数据
            const savedSessions = await window.openaiDB.getItem(
              'openai_sessions'
            );
            if (savedSessions) {
              this.sessions = JSON.parse(savedSessions);
            }

            // 加载当前会话ID
            const savedCurrentId = await window.openaiDB.getItem(
              'openai_current_session'
            );
            if (
              savedCurrentId &&
              this.sessions.find(s => s.id === savedCurrentId)
            ) {
              this.currentSessionId = savedCurrentId;
            } else if (this.sessions.length > 0) {
              this.currentSessionId = this.sessions[0].id;
            }
            this.autoFoldRolePrompt();

            // 加载选中的模型
            this.selectedModel =
              (await window.openaiDB.getItem('openai_selected_model')) ||
              this.availableModels[0].value;

            // 加载当前会话的草稿
            this.loadDraftFromCurrentSession();

            // 首次向用户询问 API Key
            if (!this.apiKey && this.isTotallyBlank) {
              this.askApiKeyIfNeeded();
            }
          },

          async saveData() {
            await window.openaiDB.setItem(
              'openai_sessions',
              JSON.stringify(this.sessions)
            );
            await window.openaiDB.setItem(
              'openai_current_session',
              this.currentSessionId
            );
            await window.openaiDB.setItem(
              'openai_selected_model',
              this.selectedModel
            );
          },

          async saveApiKey() {
            await window.openaiDB.setItem('openai_api_key', this.apiKey);
          },

          askApiKeyIfNeeded() {
            if (this.apiKey) return;
            Swal.fire({
              title: '请输入 API Key',
              input: 'password',
              inputPlaceholder: '请输入您的 OpenAI API Key',
              showCancelButton: true,
              confirmButtonText: '保存',
              cancelButtonText: '取消',
              reverseButtons: true,
              preConfirm: value => {
                if (!value) {
                  Swal.showValidationMessage('API Key 不能为空');
                  return false;
                }
                this.apiKey = value;
                this.saveApiKey();
              }
            });
          },

          createNewSession() {
            if (this.isLoading || this.isStreaming || this.isUploadingImage)
              return;
            // 保存当前会话的草稿
            this.saveDraftToCurrentSession();
            const firstSession = this.sessions[0];
            if (firstSession && !firstSession.question) {
              this.currentSessionId = firstSession.id;
            } else {
              const newSession = {
                id: Date.now().toString(),
                title: '新会话',
                summary: '',
                model: '',
                model2: '',
                role: '',
                question: '',
                answer: '',
                question2: '',
                answer2: '',
                createdAt: '',
                createdAt2: '',
                draft: '',
                images: [],
                images2: []
              };
              this.sessions.unshift(newSession);
              this.currentSessionId = newSession.id;
            }
            // 加载新会话的草稿
            this.loadDraftFromCurrentSession();
            this.saveData();
            // 移动端创建新会话后隐藏侧边栏
            if (this.isMobile) {
              this.hideSidebar();
            }
          },

          switchSession(sessionId) {
            if (this.isLoading || this.isStreaming || this.isUploadingImage)
              return;
            // 保存当前会话的草稿
            this.saveDraftToCurrentSession();
            this.currentSessionId = sessionId;
            // 加载新会话的草稿
            this.loadDraftFromCurrentSession();
            this.saveData();
            // 移动端切换会话后隐藏侧边栏
            if (this.isMobile) {
              this.hideSidebar();
            }
            this.scrollToTop();
          },

          deleteSession(sessionId) {
            if (this.isLoading || this.isStreaming || this.isUploadingImage)
              return;
            const doDelete = () => {
              this.sessions = this.sessions.filter(s => s.id !== sessionId);
              if (this.currentSessionId === sessionId) {
                this.currentSessionId =
                  this.sessions.length > 0 ? this.sessions[0].id : null;
              }
              if (this.sessions.length === 0) {
                this.createNewSession();
              }
              this.loadDraftFromCurrentSession();
              this.saveData();
            };
            // 如果是空会话, 直接删除
            const session = this.sessions.find(s => s.id === sessionId);
            if (!session) return;
            if (!session.question && !session.answer && !session.draft) {
              doDelete();
              return;
            }
            Swal.fire({
              title: '确认删除',
              text: '您确定要删除这个会话吗？',
              icon: 'warning',
              showCancelButton: true,
              confirmButtonColor: '#d33',
              confirmButtonText: '删除',
              cancelButtonText: '取消',
              reverseButtons: true
            }).then(result => {
              if (result.isConfirmed) {
                doDelete();
              }
            });
          },

          updateRolePrompt() {
            this.saveData();
          },

          async updateGlobalRolePrompt() {
            await window.openaiDB.setItem(
              'openai_global_role_prompt',
              this.globalRolePrompt
            );
          },

          clearRolePrompt() {
            this.globalRolePrompt = '';
            this.updateGlobalRolePrompt();
          },

          // 触发图片上传
          triggerImageUpload() {
            if (this.uploadedImages.length >= 2) return;
            this.$refs.imageInput.click();
          },

          // 处理粘贴事件
          async handlePaste(event) {
            // 只有在 canUpload 为 true 时才处理图片粘贴
            if (!this.canUpload) return;

            const clipboardData = event.clipboardData || window.clipboardData;
            if (!clipboardData) return;

            const items = clipboardData.items;
            if (!items) return;

            // 遍历剪贴板项目，查找图片
            for (let i = 0; i < items.length; i++) {
              const item = items[i];

              // 检查是否为图片类型
              if (item.type.startsWith('image/')) {
                event.preventDefault(); // 阻止默认粘贴行为

                // 检查是否已达到上传限制
                if (this.uploadedImages.length >= 2) {
                  Swal.fire({
                    title: '无法上传',
                    text: '最多只能上传2张图片',
                    icon: 'warning',
                    confirmButtonText: '确定'
                  });
                  return;
                }

                // 获取图片文件
                const file = item.getAsFile();
                if (!file) continue;

                // 检查文件大小 (限制10MB)
                if (file.size > 10 * 1024 * 1024) {
                  Swal.fire({
                    title: '文件过大',
                    text: '图片大小不能超过10MB',
                    icon: 'error',
                    confirmButtonText: '确定'
                  });
                  return;
                }

                // 上传图片
                await this.uploadImageFile(file);
                return; // 只处理第一张图片
              }
            }
          },

          // 上传图片文件（提取公共逻辑）
          async uploadImageFile(file) {
            this.isUploadingImage = true;
            try {
              const formData = new FormData();
              formData.append('image', file);

              // 创建超时 Promise
              const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('上传超时（15秒）')), 15000);
              });

              // 创建上传 Promise
              const uploadPromise = fetch('https://pic.keyi.ma/upload', {
                method: 'POST',
                body: formData
              });

              // 使用 Promise.race 实现超时控制
              const response = await Promise.race([
                uploadPromise,
                timeoutPromise
              ]);

              if (!response.ok) {
                throw new Error('上传失败: ' + response.statusText);
              }

              const data = await response.json();

              if (data.success && data.url) {
                this.uploadedImages.push({
                  url: data.url,
                  file: file
                });
              } else {
                throw new Error('上传失败: 返回数据格式错误');
              }
            } catch (error) {
              console.error('上传图片失败:', error);
              Swal.fire({
                title: '上传失败',
                text: error.message,
                icon: 'error',
                confirmButtonText: '确定'
              });
            } finally {
              this.isUploadingImage = false;
            }
          },

          // 处理图片选择
          async handleImageSelect(event) {
            const file = event.target.files[0];
            if (!file) return;

            // 检查文件类型
            if (!file.type.startsWith('image/')) {
              Swal.fire({
                title: '文件类型错误',
                text: '请选择图片文件',
                icon: 'error',
                confirmButtonText: '确定'
              });
              event.target.value = '';
              return;
            }

            // 检查文件大小 (限制10MB)
            if (file.size > 10 * 1024 * 1024) {
              Swal.fire({
                title: '文件过大',
                text: '图片大小不能超过10MB',
                icon: 'error',
                confirmButtonText: '确定'
              });
              event.target.value = '';
              return;
            }

            // 上传图片
            await this.uploadImageFile(file);
            event.target.value = ''; // 清空input,允许重复选择同一文件
          },

          // 移除图片
          removeImage(index) {
            this.uploadedImages.splice(index, 1);
          },

          // 清空上传的图片
          clearUploadedImages() {
            this.uploadedImages = [];
          },

          // 预览图片
          previewImage(imageUrl) {
            Swal.fire({
              imageUrl: imageUrl,
              imageAlt: '图片预览',
              showCloseButton: true,
              showConfirmButton: false,
              width: 'auto',
              customClass: {
                image: 'swal-image-preview'
              }
            });
          },

          checkMobile() {
            const isUaMobile = navigator.userAgent
              .toLowerCase()
              .includes('mobile');
            const isSizeMobile = window.innerWidth <= 768;
            this.isMobile = isUaMobile || isSizeMobile;
            if (this.isMobile) {
              document.body.className = 'mobile';
              return true;
            } else {
              document.body.className = 'pc';
              this.showSidebar = true;
              return false;
            }
          },

          toggleSidebar() {
            if (this.isLoading || this.isStreaming) return;
            this.showSidebar = !this.showSidebar;
          },

          hideSidebar() {
            this.showSidebar = false;
          },

          cancelStreaming() {
            if (this.abortController) {
              this.abortController.abort();
              this.abortController = null;
            }
            this.isStreaming = false;
            this.isLoading = false;
            this.streamingContent = '';
          },

          renderMarkdown(text) {
            if (!text) return '';
            let html = this.converter.makeHtml(text);
            // 修复有序列表的连续编号问题
            html = this.fixOrderedListNumbers(html);

            return html;
          },

          // 预处理 Markdown 文本，修复嵌套列表的缩进问题
          preprocessMarkdown(text) {
            if (!text) return '';

            const lines = text.split('\\n');
            const processedLines = [];

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];

              // 检测是否是缩进的列表项（以2个或4个空格+列表符号开头）
              // 匹配格式: "  - " 或 "    - " 或 "  * " 或 "    * "
              const indentedListMatch = line.match(/^( {2,4})([*\\-+]) /);

              if (indentedListMatch) {
                const indent = indentedListMatch[1];
                const marker = indentedListMatch[2];
                const content = line.slice(indent.length + 2) || ''; // +2 是列表符号和空格

                // 将2个空格的缩进转换为4个空格（Showdown 需要4个空格才能识别为子列表）
                if (indent.length === 2) {
                  processedLines.push('    ' + marker + ' ' + content);
                } else {
                  // 已经是4个空格，保持不变
                  processedLines.push(line);
                }
              } else {
                // 不是缩进列表项，保持原样
                processedLines.push(line);
              }
            }

            return processedLines.join('\\n');
          },

          fixOrderedListNumbers(html) {
            // 创建一个临时容器来解析 HTML
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = html;

            // 追踪同一层级的 ol 计数器
            const processNode = (parentNode, olCounter = { count: 0 }) => {
              const children = Array.from(parentNode.children);

              for (let i = 0; i < children.length; i++) {
                const node = children[i];

                // 如果遇到标题标签，重置计数器
                if (/^H[1-6]$/.test(node.tagName)) {
                  olCounter.count = 0;
                  // 递归处理标题内部（虽然通常标题内部不会有列表）
                  if (node.children.length > 0) {
                    processNode(node, { count: 0 });
                  }
                } else if (node.tagName === 'OL') {
                  // 如果是有序列表
                  if (olCounter.count > 0) {
                    // 不是第一个 ol，需要设置 start 属性
                    node.setAttribute('start', olCounter.count + 1);
                  }

                  // 计算这个 ol 中有多少个 li
                  const liCount = node.querySelectorAll(':scope > li').length;
                  olCounter.count += liCount;

                  // 递归处理 ol 内部的子节点，使用新的计数器
                  processNode(node, { count: 0 });
                } else if (node.tagName === 'UL') {
                  // 无序列表不影响计数，但需要递归处理内部
                  processNode(node, olCounter);
                } else if (node.children.length > 0) {
                  // 其他有子节点的元素（如 div, p 等），继续递归
                  processNode(node, olCounter);
                }
              }
            };

            // 从根节点开始处理
            processNode(tempDiv);

            return tempDiv.innerHTML;
          },

          copyToClipboard(text) {
            navigator.clipboard
              .writeText(text)
              .then(() => {
                Swal.fire({
                  title: '复制成功',
                  text: '内容已复制到剪贴板',
                  icon: 'success',
                  timer: 1500,
                  showConfirmButton: false
                });
              })
              .catch(() => {
                Swal.fire({
                  title: '复制失败',
                  text: '请手动复制内容',
                  icon: 'error',
                  confirmButtonText: '确定'
                });
              });
          },

          answerClickHandler(e) {
            if (!this.searchRes) return;
            const target = e.target;
            const blockquote = target.closest('blockquote');
            const isClickingSearchRes =
              blockquote && blockquote.innerText.startsWith('联网搜索：');
            if (!isClickingSearchRes) return;
            if (!blockquote.innerText.includes(this.searchRes.query)) return;
            this.showSearchRes();
          },

          // 展示搜索结果
          showSearchRes() {
            const searchRes = this.searchRes;
            // 获取渲染后的 HTML
            const template = this.$refs.searchResTemplate;
            if (!template) {
              Swal.fire({
                title: '渲染失败',
                text: '无法找到搜索结果模板',
                icon: 'error',
                confirmButtonText: '确定'
              });
              return;
            }

            const htmlContent = template.innerHTML;
            const query = searchRes.query;
            const answer = searchRes.answer;
            const results = searchRes.results || [];

            // 显示弹窗
            Swal.fire({
              title: '联网搜索详情',
              html: htmlContent,
              width: this.isMobile ? '95%' : '800px',
              showConfirmButton: true,
              confirmButtonText: '关闭',
              showCancelButton: false,
              reverseButtons: true,
              customClass: {
                popup: 'search-results-popup',
                htmlContainer: 'search-results-content'
              }
            });
          },

          shareSession() {
            const sessionContent = document.querySelector('.session-content');
            if (!sessionContent) {
              Swal.fire({
                title: '截图失败',
                text: '未找到要截图的内容',
                icon: 'error',
                confirmButtonText: '确定'
              });
              return;
            }

            // 显示加载提示
            Swal.fire({
              title: '正在生成截图...',
              allowOutsideClick: false,
              didOpen: () => {
                Swal.showLoading();
              }
            });

            // 使用html2canvas截图
            html2canvas(sessionContent, {
              backgroundColor: '#ffffff',
              scale: window.devicePixelRatio || 1,
              useCORS: true,
              allowTaint: false,
              logging: false,
              height: null,
              width: null
            })
              .then(canvas => {
                // 检测是否为微信浏览器环境
                const userAgent = navigator.userAgent.toLowerCase();
                const isWechat =
                  userAgent.includes('micromessenger') &&
                  userAgent.includes('mobile');
                const isMobile = this.checkMobile();
                const imageDataUrl = canvas.toDataURL('image/png');
                Swal.fire({
                  title: isMobile ? '长按保存图片' : '右键复制图片',
                  html:
                    '<div style="max-height: 70vh; overflow-y: auto;"><img src="' +
                    imageDataUrl +
                    '" style="max-width: 100%; height: auto; border-radius: 8px;" /></div>',
                  showConfirmButton: true,
                  confirmButtonText: '关闭',
                  showCancelButton: true,
                  cancelButtonText: '下载',
                  reverseButtons: true,
                  width: isMobile ? '92%' : 'auto',
                  padding: '0.25em 0 1em',
                  customClass: {
                    htmlContainer: 'swal-image-container'
                  }
                }).then(result => {
                  // 如果点击了取消按钮（显示为"下载"）
                  if (result.dismiss === Swal.DismissReason.cancel) {
                    const link = document.createElement('a');
                    const regex = new RegExp('[\/\: ]', 'g');
                    link.download =
                      'openai-chat-' +
                      new Date().toLocaleString().replace(regex, '-') +
                      '.png';
                    link.href = imageDataUrl;

                    // 触发下载
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);

                    // 显示下载成功提示
                    Swal.fire({
                      title: '下载成功',
                      text: '图片已保存到下载文件夹',
                      icon: 'success',
                      timer: 2000,
                      showConfirmButton: false
                    });
                  }
                });
              })
              .catch(error => {
                console.error('截图失败:', error);
                Swal.fire({
                  title: '截图失败',
                  text: '生成图片时出现错误: ' + error.message,
                  icon: 'error',
                  confirmButtonText: '确定'
                });
              });
          },

          updateSessionTitle() {
            if (this.currentSession && this.currentSession.question) {
              this.currentSession.title =
                this.currentSession.question.slice(0, 30) +
                (this.currentSession.question.length > 30 ? '...' : '');
            }
          },

          getModelName(value) {
            const model = this.availableModels.find(i => i.value === value);
            if (model) {
              return model.label;
            } else {
              return value;
            }
          },

          async sendMessage() {
            if (
              (!this.messageInput.trim() && this.uploadedImages.length === 0) ||
              !this.apiKey
            )
              return;
            if (this.isLoading || this.isStreaming || this.isUploadingImage)
              return;

            // 如果当前会话已有回答，创建新会话
            if (this.currentSession && this.currentSession.answer2) {
              this.createNewSession();
              return;
            }

            this.errorMessage = '';
            const userMessage = this.messageInput
              .trim()
              .replace(new RegExp('<', 'g'), '&lt;');
            const userImages = [...this.uploadedImages.map(img => img.url)]; // 复制图片URL数组
            this.clearInput();
            this.clearUploadedImages(); // 清空上传的图片
            // 清空当前会话的草稿
            if (this.currentSession) {
              this.currentSession.draft = '';
            }

            // 添加用户消息
            if (!this.currentSession) {
              this.createNewSession();
            }
            const session = this.currentSession;
            session.role = this.globalRolePrompt.trim();

            // 判断是第一轮or第二轮问答
            if (!session.answer) {
              session.createdAt = new Date().toISOString();
              session.model = this.selectedModel;
              session.question = userMessage;
              session.images = userImages;
              session.answer = '';
              session.question2 = '';
              session.answer2 = '';
              session.images2 = [];
              this.autoFoldRolePrompt();
            } else {
              session.createdAt2 = new Date().toISOString();
              session.model2 = this.selectedModel;
              session.question2 = userMessage;
              session.images2 = userImages;
              session.answer2 = '';
            }
            this.updateSessionTitle();
            this.saveData();
            this.scrollToBottom();

            // 发送到 OpenAI API (流式)
            const messages = [];
            this.isLoading = true;
            this.isStreaming = false;
            this.streamingContent = '';
            this.abortController = new AbortController();

            // 组装messages - OpenAI格式
            if (this.globalRolePrompt.trim()) {
              const needAssistant = /claude|gpt5/i.test(this.selectedModel);
              messages.push({
                role: !needAssistant ? 'system' : 'assistant',
                content: this.globalRolePrompt.trim()
              });
            }

            // 添加对话历史
            if (session.question) {
              const content = [];

              // 添加文本内容
              if (session.question.trim()) {
                content.push({
                  type: 'text',
                  text: session.question
                });
              }

              // 添加图片内容
              if (session.images && session.images.length > 0) {
                session.images.forEach(imageUrl => {
                  content.push({
                    type: 'image_url',
                    image_url: {
                      url: imageUrl
                    }
                  });
                });
              }

              messages.push({
                role: 'user',
                content:
                  content.length === 1 && content[0].type === 'text'
                    ? content[0].text
                    : content
              });
            }
            if (session.answer) {
              messages.push({
                role: 'assistant',
                content: session.answer
              });
            }
            if (session.question2) {
              const content = [];

              // 添加文本内容
              if (session.question2.trim()) {
                content.push({
                  type: 'text',
                  text: session.question2
                });
              }

              // 添加图片内容
              if (session.images2 && session.images2.length > 0) {
                session.images2.forEach(imageUrl => {
                  content.push({
                    type: 'image_url',
                    image_url: {
                      url: imageUrl
                    }
                  });
                });
              }

              messages.push({
                role: 'user',
                content:
                  content.length === 1 && content[0].type === 'text'
                    ? content[0].text
                    : content
              });
            }

            // 这里根据最新的问句, 调用/search接口查询语料
            let searchQuery = '';
            let searchResultsCount = 0;
            if (this.needSearch) {
              const query = session.question2 || session.question;
              const searchRes = await fetch('/search', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: 'Bearer ' + this.apiKey
                },
                body: JSON.stringify({ query })
              })
                .then(res => res.json())
                .catch(() => ({}));
              this.searchRes = JSON.parse(JSON.stringify(searchRes));
              const hasResult =
                searchRes.results &&
                searchRes.results.length &&
                JSON.stringify(searchRes).length > 40;
              if (hasResult) {
                searchRes.results = searchRes.results.map(i => {
                  const { url, score, raw_content, ...rest } = i;
                  return { ...rest };
                });
                searchQuery = searchRes.query || '';
                searchResultsCount = searchRes.results.length;
                messages.push({
                  role: 'assistant',
                  content:
                    'AI 模型通过实时调用 Tavily 搜索引擎，找到了以下信息: \\n' +
                    '<pre><code>' +
                    JSON.stringify(searchRes) +
                    '</code></pre>'
                });
                messages.push({
                  role: 'user',
                  content:
                    '强调：这不是虚构的未来时间，现在真实世界的时间是： ' +
                    new Date().toDateString() +
                    ' ' +
                    new Date().toTimeString() +
                    '。\\n请基于你已经掌握的知识，并结合上述你在搜索引擎获取到的搜索结果，详细回答我的问题。'
                });
              }
            }

            try {
              const url = '/v1/chat/completions';

              const response = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: 'Bearer ' + this.apiKey
                },
                body: JSON.stringify({
                  model: this.selectedModel,
                  messages: messages,
                  temperature: 1,
                  stream: true
                }),
                signal: this.abortController.signal
              }).catch(e => {
                throw e;
              });

              if (!response.ok) {
                const errorData = await response.json().catch(e => ({}));
                const message =
                  (errorData.error && errorData.error.message) ||
                  'HTTP ' + response.status + ': ' + response.statusText;
                throw new Error(message);
              }

              // 开始流式读取
              this.isLoading = false;
              this.isStreaming = true;

              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';

              while (true) {
                const { done, value } = await reader.read();

                // 显示搜索结果数量（如果有）
                if (searchResultsCount > 0 && !this.streamingContent) {
                  this.streamingContent =
                    '> 联网搜索：「' +
                    searchQuery +
                    '」\\n> \\n> AI 模型通过实时调用 Tavily 搜索引擎，找到了 ' +
                    searchResultsCount +
                    ' 条相关信息。\\n\\n';
                }
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\\n');
                buffer = lines.pop() || ''; // 保留最后一个不完整的行

                for (const line of lines) {
                  const trimmedLine = line.trim();
                  if (!trimmedLine || trimmedLine === 'data: [DONE]') continue;

                  if (trimmedLine.startsWith('data:')) {
                    try {
                      // 移除 'data:' 前缀（注意可能没有空格）
                      const jsonStr = trimmedLine.startsWith('data: ')
                        ? trimmedLine.slice(6)
                        : trimmedLine.slice(5);
                      const data = JSON.parse(jsonStr);

                      if (data.choices && data.choices[0].delta.content) {
                        let delta = data.choices[0].delta.content;
                        const regThinkStart = new RegExp('<think>');
                        const regThinkEnd = new RegExp('</think>');
                        delta = delta
                          .replace(
                            regThinkStart,
                            '<blockquote style="font-size: 0.75em">'
                          )
                          .replace(regThinkEnd, '</blockquote>');
                        if (delta) {
                          const shouldScroll = !this.streamingContent;
                          this.streamingContent += delta;
                          if (shouldScroll) {
                            this.scrollToBottom();
                          }
                        }
                      }
                    } catch (parseError) {
                      console.warn(
                        '解析 SSE 数据失败:',
                        parseError,
                        'Line:',
                        trimmedLine
                      );
                    }
                  }
                }
              }

              // 流式完成
              const answerKey = session.question2 ? 'answer2' : 'answer';
              // 预处理 Markdown 文本，修复嵌套列表问题
              const processedContent = this.preprocessMarkdown(
                this.streamingContent
              );
              this.currentSession[answerKey] = processedContent;
              this.saveData();
            } catch (error) {
              console.error('Error:', error);

              if (error.name === 'AbortError') {
                this.errorMessage = '请求已取消';
              } else {
                this.errorMessage = '发送失败: ' + error.message;

                // 显示错误提示
                Swal.fire({
                  title: '发送失败',
                  text: error.message,
                  icon: 'error',
                  confirmButtonText: '确定'
                });
              }
            } finally {
              this.isLoading = false;
              this.isStreaming = false;
              this.streamingContent = '';
              this.abortController = null;
              this.generateSessionSummary();
              // this.scrollToBottom();
            }
          },

          // 编辑已经问过的问题
          editQuestion() {
            if (this.isLoading || this.isStreaming || this.isUploadingImage)
              return;
            if (!this.currentSession) return;
            // 二次确认
            Swal.fire({
              title: '确认编辑问题',
              text: '这会导致对应的回答被清空，您确定要编辑这个问题吗？',
              icon: 'warning',
              showCancelButton: true,
              confirmButtonText: '确定',
              confirmButtonColor: '#d33',
              cancelButtonText: '取消',
              reverseButtons: true
            }).then(result => {
              if (!result.isConfirmed) return;
              const session = this.currentSession;
              const questionText = session.question2 || session.question || '';
              if (session.question2) {
                this.uploadedImages = (session.images2 || []).map(i => ({
                  url: i
                }));
                session.question2 = '';
                session.images2 = [];
                session.createdAt2 = '';
                session.model2 = '';
                session.answer2 = '';
              } else {
                this.uploadedImages = (session.images || []).map(i => ({
                  url: i
                }));
                session.question = '';
                session.images = [];
                session.createdAt = '';
                session.model = '';
                session.answer = '';
                session.title = '新会话';
                session.summary = '';
              }
              session.draft = questionText;
              this.messageInput = questionText;
              this.saveData();
            });
          },

          // 删除最新的回答并重新回答
          regenerateAnswer() {
            // 二次确认
            Swal.fire({
              title: '确认删除回答',
              text: '确定要删除这个回答并重新生成吗？',
              icon: 'warning',
              showCancelButton: true,
              confirmButtonText: '确定',
              confirmButtonColor: '#d33',
              cancelButtonText: '取消',
              reverseButtons: true
            }).then(result => {
              if (!result.isConfirmed) return;
              if (this.isLoading || this.isStreaming || this.isUploadingImage)
                return;
              if (!this.currentSession || !this.currentSession.answer) return;
              // 如果是第二轮问答，删除第二轮回答
              if (this.currentSession.answer2) {
                this.currentSession.answer2 = '';
                this.currentSession.createdAt2 = '';
                this.currentSession.model2 = '';
                this.messageInput = this.currentSession.question2 || '';
                this.currentSession.question2 = '';
                this.currentSession.images2 = [];
              } else {
                // 如果是第一轮问答，删除第一轮回答
                this.currentSession.answer = '';
                this.currentSession.createdAt = '';
                this.currentSession.model = '';
                this.messageInput = this.currentSession.question || '';
                this.currentSession.question = '';
                this.currentSession.images = [];
              }
              this.saveData();
              this.sendMessage();
            });
          },

          // 生成会话摘要
          async generateSessionSummary() {
            const session = this.currentSession;
            if (!session || !session.question || !session.answer) return;
            if (session.summary && session.question2) return;
            const { id, question, answer } = session;

            await this.sleep(150);

            fetch('/summarize', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + this.apiKey
              },
              body: JSON.stringify({
                question: question,
                answer: answer
              })
            })
              .then(response => {
                if (!response.ok) {
                  throw new Error(
                    'HTTP ' + response.status + ': ' + response.statusText
                  );
                }
                return response.json();
              })
              .then(async data => {
                if (data.success && data.summary) {
                  let summary = data.summary.trim();
                  const item = this.sessions.find(s => s.id === id);
                  if (item) {
                    // 移除结尾的标点符号
                    if (
                      summary.endsWith('。') ||
                      summary.endsWith('！') ||
                      summary.endsWith('？')
                    ) {
                      summary = summary.slice(0, -1);
                    }
                    item.summary = summary;
                    this.sleep(1000).then(() => {
                      this.saveData();
                    });
                  }
                } else {
                  throw new Error('未能生成摘要');
                }
              })
              .catch(error => {
                console.error('生成摘要失败:', error);
              });
          },

          // 根据全局角色设定的字符长度决定是否折叠
          autoFoldRolePrompt() {
            const len = (
              (this.currentSession && this.currentSession.role) ||
              ''
            ).length;
            if (len > 150) {
              this.isFoldRole = true;
            } else {
              this.isFoldRole = false;
            }
          },

          handleKeyDown(event) {
            if (this.isPC && event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              this.sendMessage();
            }
          },

          autoResizeTextarea() {
            this.$nextTick(() => {
              const textarea = this.$refs.messageInputRef;
              if (textarea) {
                textarea.style.height = 'auto';
                textarea.style.height =
                  Math.min(textarea.scrollHeight, 144) + 'px';
              }
            });
          },

          scrollToTop() {
            this.$nextTick(() => {
              const container = this.$refs.messagesContainer;
              if (container) {
                container.scrollTop = 0;
              }
            });
          },

          scrollToBottom() {
            this.$nextTick(() => {
              const container = this.$refs.messagesContainer;
              if (container) {
                container.scrollTop = container.scrollHeight;
              }
            });
          },

          // 如果当前已经滑动到底部，则保持在底部
          async stickToBottom() {
            await this.$nextTick();
            const vh = window.innerHeight;
            const container = this.$refs.messagesContainer;
            if (!container) return;
            // 如果当前容器滚动高度低于1.5倍window.innerHeight, 强制滚动到底部
            if (container.scrollHeight < vh * 1.5) {
              container.scrollTop = container.scrollHeight;
              return;
            }
            const isAtBottom =
              container.scrollHeight - container.scrollTop <=
              container.clientHeight + vh * 0.25;
            if (isAtBottom) {
              container.scrollTop = container.scrollHeight;
            }
          },

          // 清空输入框
          clearInput() {
            this.messageInput = '';
            this.saveDraftToCurrentSession();
          },

          // 输入变化时的处理
          onInputChange() {
            this.saveDraftToCurrentSession();
          },

          // 保存草稿到当前会话
          saveDraftToCurrentSession() {
            if (this.currentSession) {
              this.currentSession.draft = this.messageInput;
              this.saveData();
            }
          },

          // 从当前会话加载草稿
          loadDraftFromCurrentSession() {
            if (this.currentSession) {
              this.messageInput = (this.currentSession.draft || '').trim();
            } else {
              this.messageInput = '';
            }
          },

          // 显示关于信息
          showAbout() {
            const isMobile = this.checkMobile();
            Swal.fire({
              title: '关于 OpenAI WebUI Lite',
              confirmButtonText: '知道了',
              width: isMobile ? '90%' : '600px',
              html: \`
                <div style="text-align: left; padding: 10px;">
                  <h3 style="margin: 0 0 10px; color: #333;">✨ 应用简介</h3>
                  <p style="line-height: 1.6; color: #666;">
                    这是一个简单易用的 OpenAI API 代理服务，基于 Deno Deploy / Cloudflare Workers 部署。
                    只需要一个域名和 OpenAI API Key，即可免费为家人朋友提供 AI 问答服务。
                  </p>

                  <h3 style="margin: 20px 0 10px; color: #333;">🎯 核心功能</h3>
                  <ul style="line-height: 1.8; color: #666; padding-left: 20px;">
                    <li>提供标准的 OpenAI API 代理端点</li>
                    <li>内置精美的 Web 聊天界面</li>
                    <li>支持密码保护，避免直接暴露 API Key</li>
                    <li>流式响应，实时显示 AI 回答</li>
                    <li>基于 IndexedDB 的本地历史记录存储</li>
                    <li>支持多模型切换和自定义系统提示词</li>
                    <li>一键生成问答截图，方便分享</li>
                    <li>智能会话命名，便于查找管理</li>
                  </ul>

                  <h3 style="margin: 20px 0 10px; color: #333;">🔗 GitHub 仓库</h3>
                  <p style="line-height: 1.6; color: #666;">
                    <a href="https://github.com/icheer/openai-webui-lite" target="_blank" style="color: #0066cc; text-decoration: none;">
                      https://github.com/icheer/openai-webui-lite
                    </a>
                  </p>

                  <p style="margin: 20px 0 10px; color: #999; font-size: 0.9em;">
                    请合理使用 AI 资源，避免滥用！
                  </p>
                </div>
              \`
            });
          }
        }
      }).mount('#app');
    </script>
  </body>
</html>


  `;
  html = html.replace(`'$MODELS_PLACEHOLDER$'`, `'${modelIds}'`);
  // 控制"联网搜索"复选框的显隐
  if (!tavilyKeys) {
    html = html.replace(`"model-search-label"`, `"hidden"`);
  }
  // 替换网页标题
  if (title) {
    const regex = new RegExp(TITLE_DEFAULT, 'g');
    html = html.replace(regex, title);
  }
  return html;
}
