import {identifyPrepared, prepareOutputs} from './model-probe-engine.js';
import {loadProbeBank} from './model-probe-bank.js';
import {createBalanceReader} from './billing.js';

const EXPECTED = [297, 315, 331];
const NAMES = Object.freeze({
  'gpt-5.4':'GPT-5.4','gpt-5.5':'GPT-5.5','gpt-5.6-sol':'GPT-5.6 Sol','gpt-5.6-terra':'GPT-5.6 Terra','gpt-5.6-luna':'GPT-5.6 Luna','gpt-6-astra':'GPT-6 Astra','gpt-6-sol':'GPT-6 Sol','gpt-6-luna':'GPT-6 Luna',
  'claude-haiku-4-5-20251001':'Claude Haiku 4.5','claude-sonnet-4-6':'Claude Sonnet 4.6','claude-sonnet-5':'Claude Sonnet 5','claude-sonnet-5-5':'Claude Sonnet 5.5','claude-opus-4-6':'Claude Opus 4.6','claude-opus-4-7':'Claude Opus 4.7','claude-opus-4-8':'Claude Opus 4.8','claude-opus-5':'Claude Opus 5','claude-opus-5-5':'Claude Opus 5.5','claude-fable-5-1':'Claude Fable 5.1',
  'kimi-k2.6':'Kimi K2.6','gemini-3.8-flash':'Gemini 3.8 Flash','deepseek-v4-pro-0813':'DeepSeek V4 Pro 0813','qwen3.8-max-0902':'Qwen3.8 Max 0902',
});

// 每日额度：内存缓存至少 60 秒；Service Worker 被回收后缓存消失，下次读取会重新请求。
const balance = createBalanceReader({fetch: (...args) => fetch(...args)});

function isAgentUrl(value) {
  try { const url = new URL(value); return url.origin === 'https://arena.ai' && /^\/(?:agent|work)(?:\/|$)/.test(url.pathname); }
  catch { return false; }
}

function isExtensionPage(value) {
  return typeof value === 'string' && value.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

function cleanOutputs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw Error('探针数量无效');
  return value.map((item, index) => {
    const expected = Number(item?.expected_count);
    const text = typeof item?.text === 'string' ? item.text : '';
    if (!EXPECTED.includes(expected) || text.length < 1 || text.length > 12000 || !/^[\d,\s]+$/.test(text)) throw Error('自动捕获的数字序列无效');
    return {text, expected_count: expected, challenge_id: `plain-${EXPECTED.indexOf(expected) + 1}`};
  });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;

  // 额度查询：只接受扩展页面（工具栏弹窗）或 arena.ai Agent 页顶层框架的请求。
  if (message?.type === 'AMP_BALANCE') {
    (async () => {
      const fromExtensionPage = !sender.tab && isExtensionPage(sender.url);
      if (!fromExtensionPage && (sender.frameId !== 0 || !isAgentUrl(sender.url))) throw Error('额度请求来源无效');
      return balance.read({force: message.force === true});
    })().then(reply, error => reply({balance: null, cached: false, error: error?.message || '额度读取失败'}));
    return true;
  }

  if (message?.type !== 'AMP_SCORE') return;
  (async () => {
    if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !isAgentUrl(sender.url) || !isAgentUrl(message.pageUrl)) throw Error('评分请求来源无效');
    const outputs = cleanOutputs(message.outputs);
    if(new Set(outputs.map(x=>x.expected_count)).size!==outputs.length)throw Error('探针重复');
    const prepared = prepareOutputs(outputs);
    if (!prepared.usable.length) return {checks: prepared.checks, result: null};
    const loaded = await loadProbeBank();
    const result = identifyPrepared(prepared, loaded.bank);
    const nearest = result.nearest;
    const probeResults = outputs.map(output => {
      const one = prepareOutputs([output]);
      if (!one.usable.length) return {expected_count:output.expected_count,status:'invalid'};
      const score = identifyPrepared(one, loaded.bank);
      return {expected_count:output.expected_count,status:score.status,id:score.nearest.id,
        display_name:NAMES[score.nearest.id]||score.nearest.display_name||score.nearest.id,
        fit:score.signals.fit,separation:score.signals.separation};
    });
    const probeConflict = new Set(probeResults.filter(p=>p.status==='clear').map(p=>p.id)).size>1;
    return {
      checks: prepared.checks,
      result: {
        status: result.status,
        reason: result.reason,
        nearest: {
          id: nearest.id,
          display_name: NAMES[nearest.id] || nearest.display_name || nearest.id,
          family: nearest.family,
          family_name: nearest.family_name,
        },
        signals: result.signals,
        used_outputs: result.used_outputs,
        probe_results: probeResults,
        probe_conflict: probeConflict,
        bank_models: result.bank_models,
        bank_source: loaded.info.source,
        bank_sha256: loaded.info.sha256,
        checked_at: new Date().toISOString(),
      },
    };
  })().then(reply, error => reply({error: error?.message || '模型指纹评分失败'}));
  return true;
});
