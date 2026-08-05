/**
 * Vercel Serverless: 飞书 API 代理（catch-all）
 * /api/* → open.feishu.cn/open-apis/*
 * 注意：具体路由如 /api/transcribe, /api/dashscope/chat/completions 优先于此 catch-all
 */

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

  // 从 Vercel 动态路由获取路径
  const pathSegments = req.query.path;
  const apiPath = Array.isArray(pathSegments) ? '/' + pathSegments.join('/') : '/' + (pathSegments || '');
  const targetPath = '/open-apis' + apiPath;

  // 处理原始 URL 的 query string
  const fullUrl = req.url || '';
  const queryIdx = fullUrl.indexOf('?');
  const targetPathWithQuery = queryIdx !== -1 ? targetPath + fullUrl.substring(queryIdx) : targetPath;

  // 构建要转发的 headers
  const cleanHeaders = { 'host': FEISHU_HOST };
  if (req.headers['content-type']) cleanHeaders['content-type'] = req.headers['content-type'];
  if (req.headers['authorization']) cleanHeaders['authorization'] = req.headers['authorization'];

  try {
    // 序列化请求体：如果是对象则 JSON 化，否则作为字符串
    let bodyStr = '';
    if (req.body) {
      bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      cleanHeaders['content-length'] = String(Buffer.byteLength(bodyStr));
    }

    await new Promise((resolve, reject) => {
      const options = {
        hostname: FEISHU_HOST,
        port: 443,
        path: targetPathWithQuery,
        method: req.method,
        headers: cleanHeaders,
        timeout: 30000,
      };

      console.log(`[Feishu Vercel] ${req.method} ${targetPathWithQuery}`);

      const proxyReq = https.request(options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', (chunk) => { data += chunk; });

        // 转发响应 headers（排除 CORS 和 transfer-encoding）
        const resHeaders = {};
        for (const key of Object.keys(proxyRes.headers)) {
          const lower = key.toLowerCase();
          if (!['access-control-allow-origin', 'access-control-allow-methods',
                'access-control-allow-headers', 'transfer-encoding'].includes(lower)) {
            resHeaders[key] = proxyRes.headers[key];
          }
        }
        resHeaders['Access-Control-Allow-Origin'] = '*';

        res.writeHead(proxyRes.statusCode, resHeaders);

        proxyRes.on('end', () => {
          console.log(`[Feishu Vercel] Response ${proxyRes.statusCode} (${data.length} bytes)`);
          res.end(data);
          resolve();
        });
      });

      proxyReq.on('error', (err) => reject(err));
      proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('飞书连接超时')); });

      if (bodyStr) proxyReq.write(bodyStr);
      proxyReq.end();
    });
  } catch (err) {
    console.error('[Feishu Vercel Error]', err.message);
    res.status(502).json({ code: -1, msg: '飞书代理连接失败: ' + err.message });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '1mb' } } };
