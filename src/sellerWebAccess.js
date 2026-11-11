const { createHmac } = require('node:crypto');
const { isIP } = require('node:net');

function createSellerWebAccess(env, fetchBudget = fetch) {
  if (env.VERCEL !== '1') return null;
  const { QASPIK_WEB_ORIGIN, QASPIK_LIMITER_SECRET, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = env;
  if (!QASPIK_LIMITER_SECRET || !/^[a-f0-9]{64}$/.test(QASPIK_LIMITER_SECRET) || !SUPABASE_PUBLISHABLE_KEY) {
    return null;
  }

  let origin;
  let database;
  try {
    origin = new URL(QASPIK_WEB_ORIGIN);
    database = new URL(SUPABASE_URL);
  } catch {
    return null;
  }
  if (origin.protocol !== 'https:' || origin.origin !== QASPIK_WEB_ORIGIN ||
    database.protocol !== 'https:' || database.origin !== SUPABASE_URL ||
    !/^[a-z0-9]+\.supabase\.co$/.test(database.hostname)) {
    return null;
  }

  const rpc = new URL('/rest/v1/rpc/qaspik_consume_seller_budget', database);
  return {
    host: origin.host,
    origin: origin.origin,
    async reserve(ip, cost) {
      if (!isIP(ip)) return null;
      try {
        const result = await fetchBudget(rpc, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(2500),
          headers: {
            apikey: SUPABASE_PUBLISHABLE_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            p_secret: QASPIK_LIMITER_SECRET,
            p_client: createHmac('sha256', QASPIK_LIMITER_SECRET).update(ip).digest('hex'),
            p_cost: cost
          })
        });
        if (!result.ok) return null;
        const allowed = await result.json();
        return typeof allowed === 'boolean' ? allowed : null;
      } catch {
        return null;
      }
    }
  };
}

module.exports = { createSellerWebAccess };
