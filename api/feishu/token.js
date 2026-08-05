/**
 * Vercel Serverless: 飞书 Tenant Access Token
 * POST /api/feishu/token
 * 使用服务端环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET 获取 Token
 * 凭据不暴露给前端（前端无需在 localStorage 中存储 App Secret）
 */

const https = require('https');

const FEISHU_HOST = 'open.feishu.cn';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: '仅支持 POST' } });
    return;
  }

  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    res.status(500).json({
      code: -1,
      msg: '服务端未配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量',
    });
    return;
  }

  try {
    const postData = JSON.stringify({
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET,
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: FEISHU_HOST,
        port: 443,
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Content-Length': String(Buffer.byteLength(postData)),
        },
        timeout: 10000,
      };

      const proxyReq = https.request(options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', (chunk) => { data += chunk; });
        proxyRes.on('end', () => {
          try {
            const json = JSON.parse(data);
            console.log(`[FeishuToken Vercel] code=${json.code}, msg=${json.msg}`);
            res.status(proxyRes.statusCode);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(data);
            resolve();
          } catch (e) {
            reject(new Error('Token 响应解析失败'));
          }
        });
      });

      proxyReq.on('error', (err) => reject(new Error('飞书连接失败: ' + err.message)));
      proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('飞书 Token 获取超时')); });

      proxyReq.write(postData);
      proxyReq.end();
    });
  } catch (err) {
    console.error('[FeishuToken Vercel Error]', err.message);
    res.status(502).json({ code: -1, msg: err.message });
  }
};
