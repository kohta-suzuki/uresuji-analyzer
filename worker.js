/**
 * 売れ筋アナライザー用 eBay APIプロキシ (Cloudflare Worker)
 *
 * 役割: GitHub Pages上のアプリから呼ばれ、eBay Browse APIを中継する。
 * APIキー(シークレット)はWorkerの環境変数にのみ保存し、公開リポジトリには置かない。
 *
 * デプロイ手順:
 * 1. Cloudflareダッシュボード → Workers & Pages → Create Worker
 * 2. このコードを貼り付けて Deploy
 * 3. Settings → Variables and Secrets で以下の2つを「Secret」として追加:
 *      EBAY_CLIENT_ID     = eBay開発者ポータルの App ID (Client ID)
 *      EBAY_CLIENT_SECRET = 同 Cert ID (Client Secret)
 * 4. WorkerのURL (https://xxxx.workers.dev) をアプリの設定画面に貼る
 */

const ALLOWED_ORIGINS = [
  'https://kohta-suzuki.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

const EBAY_OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_BROWSE_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

// アプリケーショントークンをメモリ上でキャッシュ(Workerインスタンス生存中)
let cachedToken = null; // { token, expiresAt }

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

async function getAppToken(env) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }
  const basic = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const res = await fetch(EBAY_OAUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`,
    },
    body: 'grant_type=client_credentials&scope=' +
      encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`eBay token error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in ?? 7200) * 1000,
  };
  return cachedToken.token;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json({ error: 'GET only' }, 405, cors);
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, hasKeys: Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) }, 200, cors);
    }

    if (url.pathname === '/search') {
      try {
        const q = url.searchParams.get('q') || '';
        const marketplace = url.searchParams.get('marketplace') || 'EBAY_US';
        const limit = Math.min(Number(url.searchParams.get('limit') || 200), 200);
        const offset = Math.min(Number(url.searchParams.get('offset') || 0), 9800);
        const sort = url.searchParams.get('sort') || '';       // 例: newlyListed, price
        const filter = url.searchParams.get('filter') || '';   // 例: buyingOptions:{FIXED_PRICE},itemLocationCountry:JP
        const categoryIds = url.searchParams.get('category_ids') || '';

        if (!q && !categoryIds) {
          return json({ error: 'q または category_ids が必要です' }, 400, cors);
        }

        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (categoryIds) params.set('category_ids', categoryIds);
        params.set('limit', String(limit));
        params.set('offset', String(offset));
        if (sort) params.set('sort', sort);
        if (filter) params.set('filter', filter);
        params.set('fieldgroups', 'EXTENDED'); // itemLocation等を含める

        const token = await getAppToken(env);
        const res = await fetch(`${EBAY_BROWSE_URL}?${params}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': marketplace,
            'Accept-Encoding': 'gzip',
          },
        });
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      } catch (e) {
        return json({ error: String(e.message || e) }, 502, cors);
      }
    }

    return json({ error: 'not found' }, 404, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
