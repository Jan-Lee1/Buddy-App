/**
 * Vercel Serverless: 飞书 API 代理（catch-all）
 * /api/bitable/* → open.feishu.cn/open-apis/*
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
    // 修复：正确提取路径参数
    let apiPath = '';
    if (req.query && req.query.path) {
      const pathSegments = req.query.path;
      apiPath = Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments;
    } else {
      const match = req.url.match(/^\/api\/bitable\/(.+?)(?:\?|$)/);
      if (match) {
        apiPath = match[1];
      }
    }

    if (!apiPath) {
      res.status(400).json({ code: -1, msg: '缺少 API 路径' });
      return;
    }

    if (!apiPath.startsWith('/')) {
      apiPath = '/' + apiPath;
    }
    const targetPath = '/open-apis/bitable' + apiPath;

    // 处理原始 URL 的 query string
    const fullUrl = req.url || '';
    const queryIdx = fullUrl.indexOf('?');
    const targetPathWithQuery = queryIdx !== -1 ? targetPath + fullUrl.substring(queryIdx) : targetPath;

    console.log(`[Feishu Vercel] ${req.method} ${targetPathWithQuery}`);

    // 构建要转发的 headers
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

      const proxyReq = https.request(options, (proxyRes) => {
        const chunks = [];

        proxyRes.on('data', (chunk) => { chunks.push(chunk); });

        proxyRes.on('end', () => {
          const dataBuffer = Buffer.concat(chunks);
          console.log(`[Feishu Vercel] ${proxyRes.statusCode} (${dataBuffer.length} bytes)`);

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