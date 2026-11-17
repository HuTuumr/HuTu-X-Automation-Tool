const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: 'lm-studio',
  model: 'qwen3-4b',
  temperature: 0.9,
  maxTokens: 48,
  v: 3,
  persona: '普通 X 用户，语气自然、有自己的观点，偶尔幽默，不讨好任何人。',
  myHandle: '',
  includeForYou: true,
  minTextLen: 12,
  maxPerAuthorPerDay: 2,
  autoGen: true,
  autoScroll: true,
  pickOrder: 'top',
};

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
let defaultRules = '';

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

async function load() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  $('baseUrl').value = s.baseUrl;
  $('apiKey').value = s.apiKey;
  $('persona').value = s.persona;
  $('myHandle').value = s.myHandle;
  $('temperature').value = s.temperature;
  $('maxTokens').value = s.maxTokens;

  try {
    const r = await chrome.runtime.sendMessage({ type: 'getDefaultRules' });
    defaultRules = r?.rules || '';
  } catch (_) {
    defaultRules = '';
  }
  $('rulesText').value = s.rulesText || defaultRules;

  const sel = $('model');
  sel.innerHTML = '';
  const opt = document.createElement('option');
  opt.value = s.model;
  opt.textContent = s.model || '（先测试连接）';
  sel.appendChild(opt);
}

function collect() {
  return {
    baseUrl: $('baseUrl').value.trim() || DEFAULTS.baseUrl,
    apiKey: $('apiKey').value.trim() || 'lm-studio',
    model: $('model').value || DEFAULTS.model,
    temperature: Number($('temperature').value) || DEFAULTS.temperature,
    maxTokens: Number($('maxTokens').value) || DEFAULTS.maxTokens,
    v: 3,
    persona: $('persona').value.trim() || DEFAULTS.persona,
    rulesText: $('rulesText').value.trim() === defaultRules ? '' : $('rulesText').value.trim(),
    myHandle: $('myHandle').value.trim().replace(/^@/, ''),
    minTextLen: DEFAULTS.minTextLen,
    maxPerAuthorPerDay: DEFAULTS.maxPerAuthorPerDay,
  };
}

async function save() {
  const s = collect();
  await chrome.storage.local.set({ settings: s });
  $('saveStatus').textContent = '已保存 ' + new Date().toLocaleTimeString();
  setTimeout(() => ($('saveStatus').textContent = ''), 3000);
  return s;
}

async function test() {
  setStatus('连接中…');
  const s = collect();
  await chrome.storage.local.set({ settings: s });
  try {
    const r = await chrome.runtime.sendMessage({ type: 'probe' });
    if (!r?.ok) throw new Error(r?.error || '未知错误');
    const sel = $('model');
    const cur = sel.value;
    sel.innerHTML = '';
    if (!r.ids.length) {
      const o = document.createElement('option');
      o.value = cur;
      o.textContent = cur + '（服务在线但没有已加载模型）';
      sel.appendChild(o);
      setStatus('服务在线，但还没加载模型：去 LM Studio 里 load 一个', 'err');
      return;
    }
    for (const id of r.ids) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id;
      sel.appendChild(o);
    }
    sel.value = r.ids.includes(cur) ? cur : r.ids[0];
    setStatus(`连接成功，发现 ${r.ids.length} 个模型`, 'ok');
  } catch (e) {
    setStatus('失败：' + e.message, 'err');
  }
}

$('save').addEventListener('click', save);
$('resetRules').addEventListener('click', () => {
  $('rulesText').value = defaultRules;
  $('saveStatus').textContent = '已恢复默认，记得点保存';
});
$('test').addEventListener('click', test);
$('openX').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://x.com/home' });
});

load();
