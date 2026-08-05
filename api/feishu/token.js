/**
 * Vercel Serverless: 飞书应用 Token 端点
 * POST /api/feishu/token
 * 使用服务端环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET 获取 tenant_access_token
 * 如环境变量未配置，返回错误让前端走透传模式
 */

const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const APP_ID = process.env.FEISHU_APP_ID || '';
  const APP_SECRET = process.env.FEISHU_APP_SECRET || '';

  if (!APP_ID || !APP_SECRET) {
    console.log('[Feishu Token Vercel] 未配置环境变量，返回 500');
    res.status(500).json({
      code: -1,
      msg: '服务端未配置 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量'
    });
    return;
  }

  try {
    const postData = JSON.stringify({
      app_id: APP_ID,
      app_secret: APP_SECRET
    });

    const result = await new Promise((resolve, reject) => {
      const feishuReq = https.request({
        hostname: 'open.feishu.cn',
        port: 443,
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(Buffer.byteLength(postData)),
        },
        timeout: 10000,
      }, (feishuRes) => {
        let data = '';
        feishuRes.on('data', (c) => { data += c; });
        feishuRes.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve({ code: json.code, data });
          } catch (e) {
            resolve({ code: -1, data: '{}' });
          }
        });
      });

      feishuReq.on('error', (e) => reject(new Error('飞书 API 连接失败: ' + e.message)));
      feishuReq.on('timeout', () => { feishuReq.destroy(); reject(new Error('飞书 API 请求超时')); });
      feishuReq.write(postData);
      feishuReq.end();
    });

    console.log(`[Feishu Token Vercel] code=${result.code}`);

    if (result.code === 0) {
      res.status(200).send(result.data);
    } else {
      console.error('[Feishu Token Vercel] 飞书返回错误:', result.data);
      res.status(500).json({ code: result.code || -1, msg: '飞书 API 返回错误' });
    }
  } catch (err) {
    console.error('[Feishu Token Vercel] 异常:', err.message);
    res.status(500).json({ code: -1, msg: '获取飞书 Token 失败: ' + err.message });
  }
};
