/**
 * Vercel Serverless: 飞书 API 代理（catch-all）
 * /api/* → open.feishu.cn/open-apis/*
 * 注意：具体路由如 /api/transcribe, /api/dashscope/chat/completions, /api/feishu/token 优先于此 catch-all
 */
console.log("CATCH ALL API LOADED");
const https = require('https');
const FEISHU_HOST = 'open.feishu.cn';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    // 从 Vercel 动态路由获取路径
    const pathSegments = req.query?.path;
    const apiPath = Array.isArray(pathSegments) ? '/' + pathSegments.join('/') : '/' + (pathSegments || '');
    const targetPath = '/open-apis' + apiPath;

    // 处理原始 URL 的 query string
    const fullUrl = req.url || '';
    const queryIdx = fullUrl.indexOf('?');
    const targetPathWithQuery = queryIdx !== -1 ? targetPath + fullUrl.substring(queryIdx) : targetPath;

    // 构建要转发的 headers（只保留必要 header，防止 Vercel 内部 header 泄漏）
    const cleanHeaders = { 'host': FEISHU_HOST };
    if (req.headers['content-type']) cleanHeaders['content-type'] = req.headers['content-type'];
    if (req.headers['authorization']) cleanHeaders['authorization'] = req.headers['authorization'];

    // 序列化请求体
    let bodyBuffer = null;
    if (req.body) {
      let bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      bodyBuffer = Buffer.from(bodyStr, 'utf8');
      cleanHeaders['content-length'] = String(bodyBuffer.length);
    }

    await new Promise((resolve, reject) => {
      const options = {
        hostname: FEISHU_HOST,
        port: 443,
        path: targetPathWithQuery,
        method: req.method,
        headers: cleanHeaders,
        timeout: 25000,
      };

      console.log(`[Feishu Vercel] ${req.method} ${targetPathWithQuery}`);

      const proxyReq = https.request(options, (proxyRes) => {
        const chunks = [];

        proxyRes.on('data', (chunk) => { chunks.push(chunk); });

        proxyRes.on('end', () => {
          const dataBuffer = Buffer.concat(chunks);
          console.log(`[Feishu Vercel] ${proxyRes.statusCode} (${dataBuffer.length} bytes)`);

          // 转发响应 headers（排除内部 headers）
          const resHeaders = {};
          for (const key of Object.keys(proxyRes.headers)) {
            const lower = key.toLowerCase();
            if (!['access-control-allow-origin', 'access-control-allow-methods',
                  'access-control-allow-headers', 'transfer-encoding',
                  'content-encoding'].includes(lower)) {
              resHeaders[key] = proxyRes.headers[key];
            }
          }
          resHeaders['Access-Control-Allow-Origin'] = '*';

          res.writeHead(proxyRes.statusCode || 200, resHeaders);
          res.end(dataBuffer);
          resolve();
        });

        proxyRes.on('error', (err) => {
          console.error('[Feishu Vercel] 响应错误:', err.message);
          reject(err);
        });
      });

      proxyReq.on('error', (err) => {
        console.error('[Feishu Vercel] 连接错误:', err.message);
        reject(err);
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        reject(new Error('飞书 API 连接超时'));
      });

      if (bodyBuffer) proxyReq.write(bodyBuffer);
      proxyReq.end();
    });
  } catch (err) {
    console.error('[Feishu Vercel] 代理失败:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ code: -1, msg: '飞书代理连接失败: ' + err.message });
    }
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '1mb' } } };
