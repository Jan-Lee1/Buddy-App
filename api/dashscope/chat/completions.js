/**
 * Vercel Serverless: DashScope AI Chat 代理
 * POST /api/dashscope/chat/completions
 */

const https = require('https');

const DASHSCOPE_HOST = 'dashscope.aliyuncs.com';
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';

/* Get API Key (env var first, then X-DashScope-Key header) */
function getApiKey(req) {
  if (DASHSCOPE_API_KEY) return DASHSCOPE_API_KEY;
  return (req.headers['x-dashscope-key'] || req.headers['X-DashScope-Key'] || '').trim();
}

function safeSend(res, status, data) {
  if (res.headersSent) {
    console.warn('[DashScope Vercel] 响应已发送，跳过重复写入');
    return;
  }
  res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-DashScope-Key');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    safeSend(res, 405, { error: { message: '仅支持 POST' } });
    return;
  }

  const apiKey = getApiKey(req);
  if (!apiKey) {
    safeSend(res, 500, { error: { message: '服务端未配置 DASHSCOPE_API_KEY（环境变量和请求头均缺失）' } });
    return;
  }

  if (!req.body || typeof req.body !== 'object') {
    safeSend(res, 400, { error: { message: '请求体不能为空' } });
    return;
  }

  try {
    const body = JSON.stringify(req.body);

    await new Promise((resolve, reject) => {
      const proxyReq = https.request({
        hostname: DASHSCOPE_HOST,
        port: 443,
        path: '/compatible-mode/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'Content-Length': String(Buffer.byteLength(body)),
        },
        timeout: 55000,
      }, (proxyRes) => {
        let data = '';
        proxyRes.on('data', (chunk) => { data += chunk; });
        proxyRes.on('end', () => {
          console.log(`[DashScope Vercel] ${proxyRes.statusCode} (${data.length} bytes)`);
          res.status(proxyRes.statusCode || 200);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(data);
          resolve();
        });
      });

      proxyReq.on('error', (err) => {
        console.error('[DashScope Vercel] 连接错误:', err.message);
        reject(err);
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        reject(new Error('DashScope API 请求超时'));
      });

      proxyReq.write(body);
      proxyReq.end();
    });
  } catch (err) {
    console.error('[DashScope Vercel] 代理失败:', err.message);
    safeSend(res, 502, { error: { message: 'DashScope 代理失败: ' + err.message } });
  }
};
