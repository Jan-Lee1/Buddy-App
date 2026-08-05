/**
 * 个人管理系统 - 本地代理服务器
 * 功能：静态文件服务 + 飞书 API 反向代理 + DashScope AI 代理
 * 启动：node server.js
 * 环境变量：
 *   DASHSCOPE_API_KEY  - 阿里云 DashScope API Key（通过环境变量读取，不硬编码）
 * 零依赖，纯 Node.js 内置模块
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const STATIC_DIR = __dirname;
const FEISHU_HOST = 'open.feishu.cn';
const DASHSCOPE_HOST = 'dashscope.aliyuncs.com';

// API Key 通过环境变量读取，绝不硬编码
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
if (DASHSCOPE_API_KEY) {
  console.log('[DashScope] API Key 已从环境变量加载 (' + DASHSCOPE_API_KEY.substring(0, 8) + '***)');
} else {
  console.log('[DashScope] 未设置 DASHSCOPE_API_KEY 环境变量，AI 代理将不可用');
}

// MIME 类型映射
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let filePath;
  if (req.url === '/' || req.url === '') {
    filePath = path.join(STATIC_DIR, 'index.html');
  } else {
    // Strip query string
    const cleanPath = req.url.split('?')[0];
    filePath = path.join(STATIC_DIR, cleanPath);
  }

  // Security: prevent directory traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: any 404 goes to index.html
      fs.readFile(path.join(STATIC_DIR, 'index.html'), (e2, indexData) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(indexData);
        }
      });
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=3600',
      });
      res.end(data);
    }
  });
}

function proxyToDashScope(req, res) {
  // /api/dashscope/chat/completions → /compatible-mode/v1/chat/completions
  const targetPath = req.url.replace(/^\/api\/dashscope/, '/compatible-mode/v1');

  if (!DASHSCOPE_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: '服务端未配置 DASHSCOPE_API_KEY 环境变量' } }));
    return;
  }

  // Collect body first, then forward
  let rawBody = '';
  req.on('data', (chunk) => { rawBody += chunk; });
  req.on('end', () => {
    const cleanHeaders = {
      'host': DASHSCOPE_HOST,
      'accept': 'application/json',
      'content-type': 'application/json',
      'authorization': `Bearer ${DASHSCOPE_API_KEY}`,
    };

    const options = {
      hostname: DASHSCOPE_HOST,
      port: 443,
      path: targetPath,
      method: req.method,
      headers: cleanHeaders,
      timeout: 60000,
    };

    console.log(`[DashScope] ${req.method} ${targetPath} (${rawBody.length} bytes)`);

    const proxyReq = https.request(options, (proxyRes) => {
      let resBody = '';
      proxyRes.on('data', (chunk) => { resBody += chunk.toString(); });

      const resHeaders = {};
      for (const key of Object.keys(proxyRes.headers)) {
        const lower = key.toLowerCase();
        if (!['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers'].includes(lower)) {
          resHeaders[key] = proxyRes.headers[key];
        }
      }
      resHeaders['Access-Control-Allow-Origin'] = '*';
      resHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, OPTIONS';
      resHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';

      res.writeHead(proxyRes.statusCode, resHeaders);

      proxyRes.on('end', () => {
        console.log(`[DashScope] Response ${proxyRes.statusCode} for ${targetPath}`);
        res.end(resBody);
      });
    });

    proxyReq.on('error', (err) => {
      console.error('[DashScope Error]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'DashScope 代理连接失败: ' + err.message } }));
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'DashScope 代理连接超时' } }));
    });

    if (rawBody) {
      proxyReq.write(rawBody);
    }
    proxyReq.end();
  });
}

function proxyToFeishu(req, res) {
  // /api/auth/v3/... → /open-apis/auth/v3/...
  const targetPath = req.url.replace(/^\/api/, '/open-apis');

  // Collect the body first, then forward
  let rawBody = '';
  req.on('data', (chunk) => { rawBody += chunk; });
  req.on('end', () => {
    // Build clean headers: only forward essential ones, NOT content-length
    // (Node.js will recalculate it from the actual body we send)
    const cleanHeaders = {
      'host': FEISHU_HOST,
      'accept': 'application/json',
    };
    // Forward content-type if present
    if (req.headers['content-type']) {
      cleanHeaders['content-type'] = req.headers['content-type'];
    }
    // Forward authorization if present
    if (req.headers['authorization']) {
      cleanHeaders['authorization'] = req.headers['authorization'];
    }

    const options = {
      hostname: FEISHU_HOST,
      port: 443,
      path: targetPath,
      method: req.method,
      headers: cleanHeaders,
      timeout: 30000,
    };

    console.log(`[Proxy] ${req.method} ${targetPath} (${rawBody.length} bytes body)`);

    const proxyReq = https.request(options, (proxyRes) => {
      // Collect response for logging
      let resBody = '';
      proxyRes.on('data', (chunk) => { resBody += chunk.toString(); });

      // Pass through all response headers except CORS-related ones
      const resHeaders = {};
      for (const key of Object.keys(proxyRes.headers)) {
        const lower = key.toLowerCase();
        if (!['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers'].includes(lower)) {
          resHeaders[key] = proxyRes.headers[key];
        }
      }
      resHeaders['Access-Control-Allow-Origin'] = '*';
      resHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
      resHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';

      res.writeHead(proxyRes.statusCode, resHeaders);

      proxyRes.on('end', () => {
        console.log(`[Proxy] Response ${proxyRes.statusCode} for ${targetPath}:`, resBody.substring(0, 200));
        res.end(resBody);
      });
    });

    proxyReq.on('error', (err) => {
      console.error('[Proxy Error]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: -1, msg: '飞书代理连接失败: ' + err.message }));
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: -1, msg: '飞书代理连接超时' }));
    });

    // Write body and end
    if (rawBody) {
      proxyReq.write(rawBody);
    }
    proxyReq.end();
  });
}

const server = http.createServer((req, res) => {
  console.log(`[Request] ${req.method} ${req.url}`);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // Proxy /api/dashscope/* → DashScope AI (must check BEFORE /api/ feishu)
  if (req.url.startsWith('/api/dashscope/')) {
    proxyToDashScope(req, res);
    return;
  }

  // Proxy /api/* → Feishu Open API
  if (req.url.startsWith('/api/')) {
    proxyToFeishu(req, res);
    return;
  }

  // Serve static files
  serveStatic(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   个人管理系统 · 已启动                  ║');
  console.log('║   http://localhost:' + PORT + '                    ║');
  console.log('║   飞书代理: /api → open.feishu.cn/open-apis ║');
  console.log('║    AI 代理: /api/dashscope → dashscope    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('按 Ctrl+C 停止服务器');
});
