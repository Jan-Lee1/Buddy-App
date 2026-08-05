/**
 * Vercel Serverless: DashScope AI Chat 代理
 * POST /api/dashscope/chat/completions
 */

const https = require('https');

const DASHSCOPE_HOST = 'dashscope.aliyuncs.com';
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: '仅支持 POST' } });
    return;
  }

  if (!DASHSCOPE_API_KEY) {
    res.status(500).json({ error: { message: '服务端未配置 DASHSCOPE_API_KEY' } });
    return;
  }

  try {
    const body = JSON.stringify(req.body);

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: DASHSCOPE_HOST,
        port: 443,
        path: '/compatible-mode/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + DASHSCOPE_API_KEY,
          'Content-Length': String(Buffer.byteLength(body)),
        },
        timeout: 60000,
      };

      const proxyReq = https.request(options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', (chunk) => { data += chunk; });
        proxyRes.on('end', () => {
          console.log(`[DashScope] Response ${proxyRes.statusCode}`);
          res.status(proxyRes.statusCode);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(data);
          resolve();
        });
      });

      proxyReq.on('error', (err) => {
        reject(err);
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        reject(new Error('DashScope 连接超时'));
      });

      proxyReq.write(body);
      proxyReq.end();
    });
  } catch (err) {
    console.error('[DashScope Error]', err.message);
    res.status(502).json({ error: { message: 'DashScope 代理连接失败: ' + err.message } });
  }
};
