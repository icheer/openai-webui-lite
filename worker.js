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
    // Cloudflare Workers 环境，从传入的 env 对象获取
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

// 临时演示密码记忆
const demoMemory = {
  hour: 0,
  times: 0,
  maxTimes: DEMO_MAX_TIMES_PER_HOUR_DEFAULT
};

// API Key 轮询索引
let apiKeyIndex = 0;

// 通用的请求处理函数
async function handleRequest(request, env = {}) {
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

  // 更新 demoMemory 的最大次数
  demoMemory.maxTimes = DEMO_MAX_TIMES;

  const url = new URL(request.url);
  const apiPath = url.pathname;

  // 处理HTML页面请求
  if (apiPath === '/' || apiPath === '/index.html') {
    const htmlContent = getHtmlContent(MODEL_IDS);
    return new Response(htmlContent, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
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

  if (!apiPath.startsWith('/v1/')) {
    return createErrorResponse(
      apiPath + ' Invalid API path. Must start with /v1/',
      400
    );
  }

  // 2. 获取和验证API密钥
  let apiKey =
    url.searchParams.get('key') || request.headers.get('Authorization') || '';
  apiKey = apiKey.replace('Bearer ', '').trim();
  let urlSearch = url.searchParams.toString();
  if (!apiKey) {
    return createErrorResponse(
      'Missing API key. Provide via ?key= parameter or Authorization header',
      401
    );
  } else if (apiKey === SECRET_PASSWORD) {
    apiKey = getNextApiKey(API_KEY_LIST);
    urlSearch = urlSearch.replace(`key=${SECRET_PASSWORD}`, `key=${apiKey}`);
  } else if (apiKey === DEMO_PASSWORD && DEMO_PASSWORD) {
    // 临时密码, 仅限于测试使用, 每小时最多调用指定次数
    const hour = Math.floor(Date.now() / 3600000);
    // 检查当前小时是否超过最大调用次数
    if (demoMemory.hour === hour) {
      if (demoMemory.times >= demoMemory.maxTimes) {
        return createErrorResponse(
          'Exceeded maximum API calls for this hour',
          429
        );
      }
    } else {
      // 重置计数
      demoMemory.hour = hour;
      demoMemory.times = 0;
    }
    demoMemory.times++;
    apiKey = getNextApiKey(API_KEY_LIST);
    urlSearch = urlSearch.replace(`key=${DEMO_PASSWORD}`, `key=${apiKey}`);
  }

  // 3. 构建请求
  const targetUrl = `${API_BASE}${apiPath}?${urlSearch}`;
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

// Deno Deploy 支持
if (isDeno) {
  Deno.serve(handleRequest);
}

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

function getHtmlContent(modelIds) {
  let html = `
<!DOCTYPE html>
<html lang="zh-Hans">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>✨ OpenAI Chat</title>
    <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
    <script src="https://unpkg.com/sweetalert2@11"></script>
    <script src="https://unpkg.com/showdown@2.1.0/dist/showdown.min.js"></script>
    <script src="https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
    <link
      rel="stylesheet"
      href="https://unpkg.com/github-markdown-css/github-markdown-light.css"
    />
    <script>
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

        .model-select {
          width: 100%;
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
      <button v-show="isMobile" class="mobile-menu-btn" @click="toggleSidebar">
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
              <div
                aria-label="OpenAI"
                class="layoutkit-center css-ph96xn"
                style="
                  display: inline-flex;
                  align-items: center;
                  justify-content: center;
                  background: rgb(248, 106, 164);
                  border-radius: 50%;
                  color: rgb(255, 255, 255);
                  height: 24px;
                  width: 24px;
                "
              >
                <svg
                  fill="currentColor"
                  fill-rule="evenodd"
                  height="18"
                  viewBox="0 0 24 24"
                  width="18"
                  xmlns="http://www.w3.org/2000/svg"
                  color="#fff"
                  style="flex: 0 0 auto; line-height: 1"
                >
                  <title>OpenAI</title>
                  <path
                    d="M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z"
                  ></path>
                </svg>
              </div>
              <span>OpenAI Chat</span>
            </h2>
            <select
              v-model="selectedModel"
              class="model-select"
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
                    问题
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
                    :href="img"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    图片{{ index + 1 }}
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
                    回答
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
                ></div>
              </div>
              <!-- 问题2 -->
              <div
                v-if="currentSession.question2"
                class="content-section question-section"
              >
                <h4>
                  <span>
                    追问
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
                    :href="img"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    [图片{{ index + 1 }}]
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
                    回答
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
                v-if="isMySite"
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
                class="message-input"
                :class="{'can-upload': isMySite}"
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
            isUploadingImage: false
          };
        },
        computed: {
          isPC() {
            return !this.isMobile;
          },
          hostname() {
            return window.location.hostname;
          },
          isMySite() {
            return this.hostname.endsWith('.keyi.ma');
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
                  if (id.includes(':')) {
                    const [value, label] = id.split(':').map(s => s.trim());
                    return { value, label };
                  }
                  const parts = id.split('-');
                  parts.forEach((part, index) => {
                    parts[index] = part.charAt(0).toUpperCase() + part.slice(1);
                  });
                  return {
                    value: id,
                    label: parts.join(' ')
                  };
                });
            }
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
            // this.scrollToBottom();
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
              event.target.value = ''; // 清空input,允许重复选择同一文件
            }
          },

          // 移除图片
          removeImage(index) {
            this.uploadedImages.splice(index, 1);
          },

          // 清空上传的图片
          clearUploadedImages() {
            this.uploadedImages = [];
          },

          checkMobile() {
            const isUaMobile = navigator.userAgent
              .toLowerCase()
              .includes('mobile');
            const isSizeMobile = window.innerWidth <= 768;
            this.isMobile = isUaMobile || isSizeMobile;
            if (this.isMobile) {
              document.body.className = 'mobile';
            } else {
              document.body.className = 'pc';
              this.showSidebar = true;
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
            return this.converter.makeHtml(text);
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
                if (true || isWechat) {
                  // 微信环境：显示图片让用户长按保存
                  const imageDataUrl = canvas.toDataURL('image/png');
                  Swal.fire({
                    title: '右键/长按图片保存',
                    html:
                      '<img src="' +
                      imageDataUrl +
                      '" style="max-width: 100%; height: auto; border-radius: 8px;" />',
                    showConfirmButton: true,
                    confirmButtonText: '我知道了',
                    width: isMobile ? '92%' : 'auto',
                    padding: '0.25em 0 2em',
                    customClass: {
                      htmlContainer: 'swal-image-container'
                    }
                  });
                } else {
                  // 非微信环境：使用原有的下载逻辑
                  const link = document.createElement('a');
                  const regex = new RegExp('[\/\: ]', 'g');
                  link.download =
                    'openai-chat-' +
                    new Date().toLocaleString().replace(regex, '-') +
                    '.png';
                  link.href = canvas.toDataURL('image/png');

                  // 触发下载
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);

                  // 显示成功消息
                  Swal.fire({
                    title: '截图成功',
                    text: '图片已保存到下载文件夹',
                    icon: 'success',
                    timer: 2000,
                    showConfirmButton: false
                  });
                }
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
            const userMessage = this.messageInput.trim();
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
              messages.push({
                role: 'system',
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
                  temperature: 0.7,
                  stream: true
                }),
                signal: this.abortController.signal
              }).catch(e => {
                throw e;
              });

              if (!response.ok) {
                const errorData = await response.json().catch(e => ({}));
                const message =
                  errorData.error?.message ||
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

                      if (data.choices && data.choices[0]?.delta?.content) {
                        const delta = data.choices[0].delta.content;
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
              this.currentSession[answerKey] = this.streamingContent;
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
            let { id, question, answer } = session;
            question =
              question.length <= 300
                ? question
                : question.slice(0, 150) + '......' + question.slice(-150);
            answer =
              answer.length <= 300
                ? answer
                : answer.slice(0, 150) + '......' + answer.slice(-150);

            const messages = [
              {
                role: 'user',
                content: question
              },
              {
                role: 'assistant',
                content: answer
              },
              {
                role: 'user',
                content:
                  '请为以上的一问一答生成一个简短的摘要，概括对话的主题，12字以内（不要有任何开场白、解释说明、结尾总结，也不要任何格式，句中可以包含标点符号，但不要以标点符号结尾）'
              }
            ];

            await this.sleep(150);
            fetch('/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + this.apiKey
              },
              body: JSON.stringify({
                model: this.selectedModel,
                messages: messages,
                temperature: 0.7,
                max_tokens: 100
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
                if (
                  data.choices &&
                  data.choices[0] &&
                  data.choices[0].message
                ) {
                  let summary = data.choices[0].message.content || '';
                  if (summary) {
                    const item = this.sessions.find(s => s.id === id);
                    if (item) {
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
              \`,
              confirmButtonText: '知道了',
              confirmButtonColor: '#10a37f',
              width: isMobile ? '90%' : '600px'
            });
          }
        },
        watch: {
          messageInput() {
            this.autoResizeTextarea();
          },
          streamingContent() {
            this.stickToBottom();
          }
        }
      }).mount('#app');
    </script>
  </body>
</html>

  `;
  html = html.replace(`'$MODELS_PLACEHOLDER$'`, `'${modelIds}'`);
  return html;
}
