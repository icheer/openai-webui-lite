import { createServer } from 'node:http';
import worker from '../worker.js';

const PORT = process.env.PORT || 8787;

createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    const url = `http://${host}${req.url}`;

    // 构造 Web 标准 Headers
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }

    // 构造 Web 标准 Request
    const body = ['GET', 'HEAD'].includes(req.method)
      ? undefined
      : await new Promise((resolve) => {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks)));
        });

    const request = new Request(url, {
      method: req.method,
      headers,
      body,
      duplex: 'half',
    });

    // 调用 worker 的 fetch handler
    const response = await worker.fetch(request, process.env);

    // 写回 Node.js 响应
    res.writeHead(response.status, Object.fromEntries(response.headers));

    if (response.body) {
      // 流式响应 (SSE / streaming chat)
      const reader = response.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      pump().catch(() => res.end());
    } else {
      res.end(await response.text());
    }
  } catch (err) {
    console.error('Request error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
}).listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
