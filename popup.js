const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: 'lm-studio',
  model: 'qwen3-4b',
};

const $ = (id) => document.getElementById(id);

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = kind;
}

async function load() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  $('base').textContent = s.baseUrl;
  $('model').textContent = s.model;

  // 检查后台 service worker 是否活着
  try {
    const r = await Promise.race([
      chrome.runtime.sendMessage({ type: 'getState' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('后台无响应')), 3000)),
    ]);
    if (r?.ok) {
      $('sw').textContent = '正常';
      $('sw').style.color = '#00ba7c';
    } else {
      $('sw').textContent = '异常：' + (r?.error || '未知');
      $('sw').style.color = '#f4212e';
    }
  } catch (e) {
    $('sw').textContent = '未启动';
    $('sw').style.color = '#f4212e';
  }
}

async function test() {
  setStatus('连接中…');
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  const base = String(s.baseUrl).replace(/\/+$/, '');

  // 关键：直接在弹窗里 fetch，不经过 service worker，后台挂了也能测
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${s.apiKey || 'lm-studio'}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ids = (data?.data || []).map((m) => m.id).filter(Boolean);
    if (!ids.length) {
      setStatus('服务在线，但没有已加载的模型。回 LM Studio 加载 qwen3-4b。', 'err');
      return;
    }
    // 把第一个聊天模型写回设置
    const cur = ids.includes(s.model) ? s.model : ids[0];
    await chrome.storage.local.set({ settings: { ...s, model: cur } });
    $('model').textContent = cur;
    setStatus(`连接成功：${ids.join(', ')}`, 'ok');
  } catch (e) {
    setStatus(
      `失败：${e.message}\n${
        /Failed to fetch/i.test(e.message)
          ? '→ 服务没起。本机：LM Studio → Model Server → Start Server；云端：检查接口地址和 API Key。'
          : '→ 检查端口和模型名。'
      }`,
      'err'
    );
  }
}

$('test').addEventListener('click', test);
$('open').addEventListener('click', () => chrome.runtime.openOptionsPage());
load();
