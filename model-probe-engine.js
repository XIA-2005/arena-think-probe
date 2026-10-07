/* Statistical model probe built on ModelTrace's MIT-licensed scoring core.
   Input gates and the open-set decision follow the public method described at
   https://whatsmyllm.com/methodology/ . Replies never leave the caller. */
import {analyzeGlobalOutputs, countNumbers, parseNumbers} from './modeltrace-core.js';

export const VALUE_MIN = 1;
export const VALUE_MAX = 355;
export const INPUT_LIMIT = 50000;
export const THRESHOLDS = Object.freeze({fit: 0.25, separation: 0.08, family: 0.9});

const DIRECT = ' The current language model must complete this directly without tools, Python, code execution, calculators, search, APIs, or external random generators. Choose every position separately. Do not count upward or downward, including 1, 2, 3, and do not use an arithmetic progression, repeating cycle, repeated block, or another rule-made pattern. Accidental repetitions are valid. Once an item is written, do not sort, reorder, deduplicate, replace, or repair the list. Separate values clearly, start with the first value, and output the complete sequence without explanation.';

export const PROBES = Object.freeze([
  Object.freeze({
    id: 'plain-1',
    expected_count: 297,
    prompt: 'For each of 297 positions, make one separate first-instinct choice of an integer from 1 to 355 inclusive.' + DIRECT,
  }),
  Object.freeze({
    id: 'plain-2',
    expected_count: 315,
    prompt: 'Provide exactly 315 whole-number choices between 1 and 355 inclusive, choosing each item separately as it comes to mind.' + DIRECT,
  }),
  Object.freeze({
    id: 'plain-3',
    expected_count: 331,
    prompt: 'Fill exactly 331 positions with integers from the closed interval [1, 355], making a separate immediate choice for every position.' + DIRECT,
  }),
]);

export const GATE_MESSAGES = Object.freeze({
  empty: '没有找到 1–355 之间的数字。',
  constant: '所有数字都相同，不像模型按项选择的回答。',
  monotonic: '序列基本已排序，不能作为模型数字指纹。',
  arithmetic: '至少一半相邻项使用同一绝对步长，属于规则序列。',
  low_unique: '不同数字不足二十分之一，像循环少量取值。',
  too_short: '回答太短；请粘贴完整回复，或重新运行该提示。',
  count_mismatch: '数字数量偏离预期超过 10%；该样本未计分。',
  duplicate: '与另一份回答完全相同；三份证据必须彼此独立。',
  too_large: '文本超过 50,000 字符，未处理。',
  invalid_json: 'JSON 无法解析，或不是受支持的单个模型回复。',
  api_tools: '响应包含工具调用、拒答、未完成状态或多条候选，未计分。',
  invalid_array: 'JSON 数组必须只包含整数。',
  invalid_fence: '代码围栏不完整或包含嵌套围栏。',
});

function stripFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return {text};
  const match = /^```(?:json|text|plaintext)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(trimmed);
  if (!match || match[1].includes('```')) return {error: 'invalid_fence'};
  return {text: match[1]};
}

function openAIChatText(data) {
  if (!Array.isArray(data?.choices) || data.choices.length !== 1) return null;
  const choice = data.choices[0];
  const message = choice?.message;
  if (choice?.finish_reason !== 'stop' || message?.role !== 'assistant' || typeof message?.content !== 'string' ||
      !message.content.trim() || message.refusal || message.function_call || message.tool_calls?.length) {
    return {error: 'api_tools'};
  }
  return {text: message.content};
}

function anthropicText(data) {
  if (data?.type !== 'message' || data?.role !== 'assistant' || !Array.isArray(data?.content)) return null;
  if (data.stop_reason !== 'end_turn' || data.content.length !== 1 || data.content[0]?.type !== 'text' ||
      typeof data.content[0]?.text !== 'string' || !data.content[0].text.trim()) return {error: 'api_tools'};
  return {text: data.content[0].text};
}

function openAIResponsesText(data) {
  if (!Array.isArray(data?.output) || (!data.object?.startsWith?.('response') && data.type !== 'response')) return null;
  if (data.status && data.status !== 'completed') return {error: 'api_tools'};
  const messages = data.output.filter(item => item?.type === 'message' && item?.role === 'assistant');
  // A Responses payload may carry a separate reasoning summary item. It has no answer text and is safe
  // to ignore; function/computer/web-search calls are not, because then this was not a direct reply.
  const toolItems = data.output.filter(item => /(?:function|computer|web_search|file_search|tool).*call|(?:function|computer|web_search|file_search)_call/i.test(String(item?.type || '')));
  if (messages.length !== 1 || toolItems.length) return {error: 'api_tools'};
  const blocks = messages[0].content;
  if (!Array.isArray(blocks) || blocks.some(block => block?.type !== 'output_text' || typeof block?.text !== 'string')) return {error: 'api_tools'};
  const text = blocks.map(block => block.text).join('');
  return text.trim() ? {text} : {error: 'api_tools'};
}

/** Extracts only one completed assistant answer. Plain text and flat JSON arrays are accepted. */
export function extractResponseText(input) {
  const raw = typeof input === 'string' ? input : '';
  if (raw.length > INPUT_LIMIT) return {error: 'too_large'};
  const unfenced = stripFence(raw);
  if (unfenced.error) return unfenced;
  const text = unfenced.text;
  const trimmed = text.trim();
  if (!trimmed) return {text: ''};
  if (/^(?:data|event):/i.test(trimmed)) return {error: 'invalid_json'};
  if (trimmed.startsWith('[')) {
    let data;
    try { data = JSON.parse(trimmed); } catch { return {error: 'invalid_json'}; }
    if (!Array.isArray(data) || data.some(value => !Number.isInteger(value))) return {error: 'invalid_array'};
    return {text: data.join(',')};
  }
  if (trimmed.startsWith('{')) {
    let data;
    try { data = JSON.parse(trimmed); } catch { return {error: 'invalid_json'}; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {error: 'invalid_json'};
    return openAIChatText(data) || anthropicText(data) || openAIResponsesText(data) || {error: 'invalid_json'};
  }
  return {text};
}

export function computeGateStats(values, requested = null) {
  const length = values.length;
  const steps = Math.max(0, length - 1);
  let nonDecreasing = 0;
  let nonIncreasing = 0;
  const stepSizes = new Map();
  for (let index = 0; index < steps; index += 1) {
    const delta = values[index + 1] - values[index];
    if (delta >= 0) nonDecreasing += 1;
    if (delta <= 0) nonIncreasing += 1;
    const absolute = Math.abs(delta);
    stepSizes.set(absolute, (stepSizes.get(absolute) || 0) + 1);
  }
  const modalStep = steps ? Math.max(...stepSizes.values()) : 0;
  const uniqueCount = new Set(values).size;
  const expected = Number(requested);
  const minLength = Math.max(80, Number.isFinite(expected) && expected > 0 ? Math.ceil(expected * 0.55) : 80);
  return {
    length,
    unique_count: uniqueCount,
    unique_ratio: length ? uniqueCount / Math.min(length, VALUE_MAX - VALUE_MIN + 1) : 0,
    monotone_fraction: steps ? Math.max(nonDecreasing, nonIncreasing) / steps : 0,
    arithmetic_fraction: steps ? modalStep / steps : 0,
    min_length: minLength,
  };
}

/** First matching gate wins; only level "ok" may be scored. */
export function evaluateGate(values, requested = null) {
  const stats = computeGateStats(values, requested);
  let level = 'ok';
  let rule = null;
  if (stats.length < 1) [level, rule] = ['invalid', 'empty'];
  else if (stats.length >= 2 && stats.unique_count <= 1) [level, rule] = ['invalid', 'constant'];
  else if (stats.length >= 3 && stats.monotone_fraction >= 0.9) [level, rule] = ['invalid', 'monotonic'];
  else if (stats.length >= 3 && stats.arithmetic_fraction >= 0.5) [level, rule] = ['invalid', 'arithmetic'];
  else if (stats.unique_ratio < 0.05) [level, rule] = ['invalid', 'low_unique'];
  else if (stats.length < stats.min_length) [level, rule] = ['insufficient', 'too_short'];
  else if (Number(requested)>0 && (stats.length<Math.ceil(Number(requested)*0.9)||stats.length>Math.floor(Number(requested)*1.1))) [level, rule] = ['invalid', 'count_mismatch'];
  return {level, rule, message: rule ? GATE_MESSAGES[rule] : null, stats, parsed_numbers: stats.length};
}

/** Parses, gates and de-duplicates the replies without scoring them. */
export function prepareOutputs(outputs) {
  if (!Array.isArray(outputs)) throw new TypeError('outputs must be an array');
  const seen = new Map();
  const normalized = [];
  const checks = outputs.map((output, offset) => {
    const index = offset + 1;
    const expected = Number(output?.expected_count) || null;
    const original = typeof output?.text === 'string' ? output.text : '';
    if (!original.trim()) {
      normalized.push({...output, text: ''});
      return {index, level: 'empty', rule: 'empty', message: null, parsed_numbers: 0, stats: computeGateStats([], expected)};
    }
    const extracted = extractResponseText(original);
    if (extracted.error) {
      normalized.push({...output, text: ''});
      return {index, level: 'invalid', rule: extracted.error, message: GATE_MESSAGES[extracted.error], parsed_numbers: 0, stats: computeGateStats([], expected)};
    }
    const item = {...output, text: extracted.text};
    normalized.push(item);
    const values = parseNumbers(extracted.text);
    const check = {...evaluateGate(values, expected), index};
    if (check.level === 'ok') {
      const signature = values.join(',');
      if (seen.has(signature)) return {...check, level: 'invalid', rule: 'duplicate', message: GATE_MESSAGES.duplicate, duplicate_of: seen.get(signature)};
      seen.set(signature, index);
    }
    return check;
  });
  const usable = normalized.filter((_, index) => checks[index].level === 'ok');
  return {outputs: normalized, checks, usable};
}

const validatedBanks = new WeakSet();
function numericArray(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

/** Rejects malformed or executable-looking remote data before it reaches the scorer. */
export function validateBank(bank) {
  if (!bank || typeof bank !== 'object' || Array.isArray(bank)) throw new Error('指纹库格式无效');
  if (validatedBanks.has(bank)) return bank;
  if (bank.schema !== 'robust-number-fingerprint-bank' || !Array.isArray(bank.models) || bank.models.length < 2 || bank.models.length > 100) throw new Error('指纹库清单无效');
  const ids = bank.models.map(model => model?.id);
  if (ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9@._:-]{1,160}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('指纹库模型 ID 无效');
  if (bank.models.some(model => !numericArray(model.counts, 355))) throw new Error('指纹库分布维度无效');
  const robust = bank.robust;
  const hellinger = robust?.hellinger;
  if (!Array.isArray(robust?.model_order) || robust.model_order.length !== ids.length || robust.model_order.some(id => !ids.includes(id))) throw new Error('指纹库模型顺序无效');
  if (!numericArray(hellinger?.feature_mean, 355) || !numericArray(hellinger?.feature_scale, 355) ||
      !Array.isArray(hellinger?.nuisance_basis) || hellinger.nuisance_basis.some(row => !numericArray(row, 355)) ||
      !Array.isArray(hellinger?.centroids) || hellinger.centroids.length !== ids.length || hellinger.centroids.some(row => !numericArray(row, 355))) throw new Error('指纹库 Hellinger 参数无效');
  const ordered = robust?.ordered_blocks;
  if (!ordered || !numericArray(ordered.feature_mean, 74) || !numericArray(ordered.feature_scale, 74) ||
      !Array.isArray(ordered.centroids) || ordered.centroids.length !== ids.length || ordered.centroids.some(row => !numericArray(row, 74)) ||
      !Array.isArray(ordered.nuisance_basis) || ordered.nuisance_basis.some(row => !numericArray(row, 74)) ||
      !Array.isArray(ordered.environment_centroids) || ordered.environment_centroids.some(env => !Array.isArray(env) || env.length !== ids.length || env.some(row => !numericArray(row, 74)))) throw new Error('指纹库有序特征参数无效');
  for (const key of ['1', '2', '3']) if (!Number.isFinite(Number(bank.calibration?.[key]?.beta))) throw new Error('指纹库校准参数无效');
  validatedBanks.add(bank);
  return bank;
}

function rawCosines(counts, bank) {
  const artifact = bank.robust.hellinger;
  const alpha = 0.5;
  const total = counts.reduce((sum, value) => sum + value, 0) + alpha * counts.length;
  const projected = counts.map((value, index) => (Math.sqrt((value + alpha) / total) - artifact.feature_mean[index]) / artifact.feature_scale[index]);
  for (const vector of artifact.nuisance_basis) {
    let weight = 0;
    for (let index = 0; index < projected.length; index += 1) weight += projected[index] * vector[index];
    for (let index = 0; index < projected.length; index += 1) projected[index] -= weight * vector[index];
  }
  const norm = Math.max(Math.sqrt(projected.reduce((sum, value) => sum + value * value, 0)), 1e-12);
  return artifact.centroids.map(centroid => centroid.reduce((sum, value, index) => sum + (projected[index] / norm) * value, 0));
}

export const bareModel = id => String(id).split('@', 1)[0];

function makeVerdict(attribution, countsList, bank) {
  const perAnswer = countsList.map(counts => rawCosines(counts, bank));
  const fits = Object.fromEntries(bank.robust.model_order.map((id, index) => [
    id,
    perAnswer.reduce((sum, answer) => sum + answer[index], 0) / perAnswer.length,
  ]));
  const metadata = Object.fromEntries(bank.models.map(model => [model.id, model]));
  const groups = new Map();
  for (const item of attribution.results) {
    const id = bareModel(item.model);
    const meta = metadata[item.model] || {};
    if (!groups.has(id)) groups.set(id, {
      id,
      display_name: String(meta.display_name || item.display_name || id).split('@', 1)[0],
      family: item.family || meta.family || 'models',
      family_name: item.family_name || meta.family_name || item.family || 'models',
      probability: 0,
      fit: -Infinity,
      channels: [],
    });
    const group = groups.get(id);
    group.probability += item.probability;
    group.channels.push(item.model.includes('@') ? item.model.slice(item.model.indexOf('@') + 1) : 'reference');
    group.fit = Math.max(group.fit, fits[item.model]);
  }
  const candidates = [...groups.values()].sort((left, right) => right.probability - left.probability);
  const top = candidates[0];
  const alternativeFit = candidates.length > 1 ? Math.max(...candidates.slice(1).map(item => item.fit)) : 0;
  const familyProbability = candidates.filter(item => item.family === top.family).reduce((sum, item) => sum + item.probability, 0);
  const signals = {
    fit: top.fit,
    separation: top.fit - alternativeFit,
    family_probability: familyProbability,
    relative_probability: top.probability,
    query_count: countsList.length,
  };
  let status;
  let reason;
  if (signals.fit < THRESHOLDS.fit) [status, reason] = ['weak', 'fit_below_floor'];
  else if (signals.separation >= THRESHOLDS.separation) [status, reason] = ['clear', 'clear_separation'];
  else if (signals.family_probability >= THRESHOLDS.family) [status, reason] = ['close', 'family_only'];
  else [status, reason] = ['weak', 'family_unclear'];
  return {status, reason, nearest: top, signals, candidates};
}

/** Scores an already prepared set. The closest model is always shown; status qualifies reliability. */
export function identifyPrepared(prepared, bank) {
  validateBank(bank);
  if (!prepared?.usable?.length) throw new Error('没有可计分的回答');
  const attribution = analyzeGlobalOutputs(prepared.usable, bank);
  const countsList = prepared.usable.map(output => countNumbers(parseNumbers(output.text)));
  const verdict = makeVerdict(attribution, countsList, bank);
  return {
    ...verdict,
    used_outputs: prepared.usable.length,
    checks: prepared.checks,
    calibration: attribution.calibration,
    bank_models: bank.models.length,
  };
}

export function inspectAndIdentify(outputs, bank) {
  const prepared = prepareOutputs(outputs);
  return {prepared, result: prepared.usable.length ? identifyPrepared(prepared, bank) : null};
}
