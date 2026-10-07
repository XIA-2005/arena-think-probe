/* Arena 每日额度读取（GET https://arena.ai/api/me/pulse，同源 Cookie）。
   端点和字段语义来自 Arena Trace Inspector 2.3.2 的 billing.js（本机副本由「沐介之9.20改」维护）：
   2026-09-20 起旧端点 /api/billing/balance 已下线，新端点返回 {pulse: 剩余百分比, refreshedAt: 恢复时间}。
   pulse 是百分比而不是 credits，因此这里不做任何 USD 换算，也不猜「总量」。
   纯函数 + 一个带缓存的读取器；结果只存在于内存，不写入任何存储。 */

export const BALANCE_URL = 'https://arena.ai/api/me/pulse';
export const BALANCE_MIN_INTERVAL_MS = 60000;
export const BALANCE_TIMEOUT_MS = 10000;

// 百分比：有限且非负即可。不硬卡上界 100 —— 奖励额度可能让 pulse 超过 100。
const pctOf = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0) ? value : null;

// 白名单解析：未知字段直接丢弃；格式不符返回 null（等于「没有额度可谈」）。
export function parseBalance(body, receivedAt = new Date().toISOString()) {
  let data = body;
  if (typeof data === 'string') { if (data.length > 4096) return null; try { data = JSON.parse(data); } catch { return null; } }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const pulse = pctOf(data.pulse);
  if (pulse === null) return null;
  const refreshedAt = typeof data.refreshedAt === 'string' && data.refreshedAt.length <= 40 && Number.isFinite(Date.parse(data.refreshedAt)) ? data.refreshedAt : null;
  return { pulse, refreshedAt, receivedAt };
}

export const formatPulse = value => (typeof value === 'number' && Number.isFinite(value) ? (Math.round(value * 10) / 10) + '%' : '—');

const stamp = iso => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  return (date.getMonth() + 1) + '-' + date.getDate() + ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
};

// tone 供 UI 上色：good >= 50%，warn >= 20%，low 更低。
export function formatBalance(balance) {
  if (!balance) return { value: '未提供', note: '未读取', pct: null, tone: 'none', rows: [] };
  const pct = pctOf(balance.pulse);
  const tone = pct === null ? 'none' : pct >= 50 ? 'good' : pct >= 20 ? 'warn' : 'low';
  const value = pct === null ? '未提供' : formatPulse(pct);
  const rows = [['剩余', value], ['下次额度重置', stamp(balance.refreshedAt)], ['读取', stamp(balance.receivedAt) + (typeof balance.latencyMs === 'number' ? ' (' + balance.latencyMs + 'ms)' : '')]];
  return { value, note: '每日额度剩余' + (balance.refreshedAt ? ' · 下次额度重置于 ' + stamp(balance.refreshedAt) : ''), pct, tone, rows };
}

export function createBalanceReader({ fetch: doFetch, now = () => Date.now(), minIntervalMs = BALANCE_MIN_INTERVAL_MS, timeoutMs = BALANCE_TIMEOUT_MS } = {}) {
  let cache = null, lastAt = 0, inflight = null, lastError = null;
  async function read({ force = false } = {}) {
    if (inflight) return inflight;
    if (!force && cache && now() - lastAt < minIntervalMs) return { balance: cache, cached: true, error: lastError };
    inflight = (async () => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const t0 = now();
        const res = await doFetch(BALANCE_URL, { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: abort.signal });
        lastAt = now(); const latencyMs = Math.max(0, lastAt - t0);
        // 403 表示路由本身被拒绝（arena.ai 对未知路由一律 403），不是登录状态问题。
        if (res.status === 401) { lastError = '未登录（HTTP 401）'; return { balance: cache, cached: !!cache, error: lastError }; }
        if (res.status === 403) { lastError = '额度接口被拒绝（HTTP 403）：/api/me/pulse 可能已失效，平台多半又换端点了'; return { balance: cache, cached: !!cache, error: lastError }; }
        if (res.status === 429) { lastError = '额度接口限流（HTTP 429），稍后再试'; return { balance: cache, cached: !!cache, error: lastError }; }
        if (!res.ok) { lastError = '额度接口返回 HTTP ' + res.status; return { balance: cache, cached: !!cache, error: lastError }; }
        const parsed = parseBalance(await res.text());
        if (!parsed) { lastError = '额度响应格式不符合预期'; return { balance: cache, cached: !!cache, error: lastError }; }
        cache = { ...parsed, latencyMs }; lastError = null;
        return { balance: cache, cached: false, error: null };
      } catch (error) {
        lastAt = now(); lastError = '额度读取失败：' + (error?.message || '网络错误');
        return { balance: cache, cached: !!cache, error: lastError };
      } finally { clearTimeout(timer); inflight = null; }
    })();
    return inflight;
  }
  return { read, peek: () => ({ balance: cache, cached: true, error: lastError }), clear: () => { cache = null; lastAt = 0; lastError = null; } };
}
