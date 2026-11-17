/* HuTu助手 — background service worker
 * 职责：调用本地 OpenAI 兼容接口生成草稿、记录配额与去重历史、探测模型列表。
 */

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: 'lm-studio',
  model: 'qwen3-4b',
  temperature: 0.9,
  maxTokens: 48,
  v: 3,
  persona: '普通 X 用户，语气自然、有自己的观点，偶尔幽默，不讨好任何人。',
  rulesText: '',
  myHandle: '',
  includeForYou: true,
  minTextLen: 12,
  maxPerAuthorPerDay: 2,
  autoGen: true,
  autoScroll: true,
  pickOrder: 'top',
};

const EMPTY_STATE = () => ({
  dayKey: '',
  sent: 0,
  hourKey: '',
  hourSent: 0,
  lastSentAt: 0,
  history: [],   // {id, hash, text, author, ts}
  authorDay: {}, // {dateKey: {handle: count}}
});

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function hourKey(d = new Date()) {
  return `${todayKey(d)}T${String(d.getHours()).padStart(2, '0')}`;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  delete s.minGapSec;
  delete s.dailyCap;
  delete s.hourlyCap;
  return s;
}

async function getState() {
  const { state } = await chrome.storage.local.get('state');
  const s = { ...EMPTY_STATE(), ...(state || {}) };
  if (!Array.isArray(s.history)) s.history = [];
  if (!s.authorDay || typeof s.authorDay !== 'object') s.authorDay = {};
  return s;
}

async function saveState(state) {
  await chrome.storage.local.set({ state });
  return state;
}

/* 自动清理：超过 30 天的记录直接删，最多留 500 条（后台每次唤醒时跑一次） */
(async function pruneHistory() {
  try {
    const state = await getState();
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    const kept = state.history.filter((h) => (h.ts || 0) >= cutoff).slice(-500);
    if (kept.length !== state.history.length) {
      state.history = kept;
      await saveState(state);
    }
  } catch (_) {
    /* ignore */
  }
})();

/* ---------- 文本归一化与相似度去重 ---------- */

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、,.!?~～:：;；"'“”‘’()（）\[\]【】<>《》\-—_]/g, '');
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function isTooSimilar(text, history) {
  const n = normalize(text);
  if (!n) return true;
  for (const h of history.slice(-300)) {
    const hn = h.hash || normalize(h.text || '');
    if (!hn) continue;
    if (hn === n) return true;
    if (Math.abs(hn.length - n.length) <= 8 && similarity(hn, n) > 0.72) return true;
  }
  return false;
}

/* ---------- 提示词 ---------- */

/* ---------- 评论规则 ---------- */

/* 每次随机换一种切入方式，避免所有评论一个句式 */
const ANGLES = [
  '认同，并补一句自己的看法',
  '反驳或质疑',
  '追问一个具体细节',
  '补充一个别人没提到的点',
  '调侃一下',
  '表示惊讶',
];

let lastAngle = null;

function pickAngle() {
  const pool = ANGLES.filter((a) => a !== lastAngle);
  const a = pool[Math.floor(Math.random() * pool.length)] || ANGLES[0];
  lastAngle = a;
  return a;
}

/* 涉及疾病 / 生死 / 灾难 / 亲人的帖子，禁止调侃 */
const CARE_RE =
  /癌|肿瘤|化疗|放疗|手术|住院|确诊|复发|病危|重病|去世|走了|离世|过世|葬礼|自杀|抑郁|残疾|流产|家暴|车祸|地震|洪水|火灾|痊愈|康复/i;

function isCareContext(text) {
  return CARE_RE.test(String(text || ''));
}

const PROFANITY = ['妈的', '他妈', '傻逼', '尼玛', '操你', '去死', '贱人', '婊', '滚蛋', '狗东西'];
const SNARK = ['笑话', '活该', '难怪', '怕不是', '就这', '呵呵', '笑死', '装什么', '演'];
const CLICHES = [
  '值得注意的是',
  '总而言之',
  '不得不说',
  '这意味着',
  '深度分析',
  '总的来说',
  '值得深思',
  '综上所述',
];

function hitAny(text, list) {
  const t = String(text || '');
  return list.some((w) => t.includes(w));
}

const DEFAULT_RULES = `你是一个真实的 X 平台用户，正在浏览帖子并参与讨论。

根据原帖内容，生成一条自然、真实的中文评论。

评论规则：
1. 字数控制在 7-20 字，每次随机变化，不要固定长度。
2. 必须紧扣原帖内容，像真人看完帖子后随口发表看法。
3. 可以认同、反驳、质疑、提问、补充观点，也可以表达惊讶或调侃。
4. 不要复述原帖，不要空洞地表达支持。
5. 语言口语化，简洁自然，允许不完整句子，像真人聊天。
6. 不要使用AI惯用表达，例如：值得注意的是、总而言之、不得不说、这意味着、深度分析。
7. 不要每次都用相同句式，不要刻意总结或升华。
8. 不要滥用感叹号、表情符号和问号。
9. 根据原帖语气调整评论风格，严肃内容认真回应，轻松内容可以幽默。
10. 如果原帖没有值得评论的内容，就提出一个自然且相关的问题。
11. 不要使用句号、逗号、顿号、分号，整条连着说完；只写一句话，超过 20 字就把后半句砍掉。

输出要求：
只输出一条评论，不要解释，不要加引号，不要输出其他内容。`;

function buildMessages(tweet, settings, angle, strict, care) {
  const persona = (settings.persona || DEFAULTS.persona).trim();
  const rules = String(settings.rulesText || '').trim() || DEFAULT_RULES;

  const system = [rules];

  if (persona) {
    system.push('', `【评论者的日常语气】${persona}`);
  }

  if (care) {
    system.push(
      '',
      '【特别约束】原帖涉及疾病、生死、灾难或亲人。只写一句真诚、有分寸、善意的话；禁止调侃、质疑、阴阳怪气。'
    );
  }

  system.push('', `这次的切入方式：${angle}`);

  // 有些模型（Gemma 4）会先写一段 Thinking Process 再给正文，这里直接堵住
  system.push('', '直接写评论，第一个字就是评论的第一个字；不要输出思考过程，不要分析，不要解释。');

  if (strict) {
    system.push('', '【额外要求】必须点到原帖里出现过的一个具体词、数字或细节，否则算失败。');
  }

  system.push('', '/no_think');

  const user = [
    `原帖作者：@${tweet.handle || 'unknown'}`,
    '原帖内容：',
    '"""',
    String(tweet.text || '').slice(0, 1200),
    '"""',
  ].join('\n');

  return [
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: user },
  ];
}

/* ---------- 输出清洗 ---------- */

function cleanReply(raw) {
  let t = String(raw || '');
  t = t.replace(/<\|?think\|?>[\s\S]*?<\/?\|?think\|?>/gi, '');
  t = t.replace(/^```[\s\S]*?\n|```$/g, '');
  t = t.replace(/^\s*(回复|回答|Reply)\s*[:：]\s*/i, '');
  t = t.replace(/\r/g, '');
  t = t.replace(/\n+/g, ' ').trim();
  t = t.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
  if (t.length > 200) {
    const cut = t.slice(0, 200);
    const m = cut.match(/^[\s\S]*[。！？.!?]/);
    t = (m ? m[0] : cut).trim();
  }
  return t;
}

/* 和推文是否有具体交集：回复里任意两个字在原文里出现过 */
function overlaps(tweetText, reply) {
  const a = normalize(String(tweetText || ''));
  const b = normalize(String(reply || ''));
  if (a.length < 8 || b.length < 4) return true;
  for (let i = 0; i + 2 <= b.length; i++) {
    if (a.includes(b.slice(i, i + 2))) return true;
  }
  return false;
}

// 收敛标点：连续的感叹号/问号只留一个；句号逗号顿号分号一律不要，中文之间不留空格
function sanitize(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/([！!])[！!]+/g, '$1')
    .replace(/([？?])[？?]+/g, '$1')
    .replace(/[。，、；,;]/g, '')
    .replace(/(?<=[\u4e00-\u9fff！？）】」』])[ ]+/g, '')
    .replace(/[ ]+(?=[\u4e00-\u9fff！？；（【「『])/g, '')
    .trim();
}

function countOf(text, re) {
  return (String(text || '').match(re) || []).length;
}

// 问号和感叹号各只留第一个，后面的改成逗号，句尾多余的逗号去掉（规则 8）
function limitPunct(text) {
  let q = 0;
  let e = 0;
  const out = String(text || '').replace(/[？?！!]/g, (m) => {
    if (m === '？' || m === '?') {
      q += 1;
      return q === 1 ? '？' : '，';
    }
    e += 1;
    return e === 1 ? '！' : '，';
  });
  return out.replace(/[，,]+$/, '').replace(/。{2,}/g, '。').trim();
}

// 记录最近用过的开头，避免连着几条一个腔调
const recentOpenings = [];
const BAD_OPENINGS = ['笑死', '草', '家人们', '确实', '说真的'];

function rememberOpening(text) {
  recentOpenings.push(String(text).slice(0, 4));
  if (recentOpenings.length > 8) recentOpenings.shift();
}

function badOpening(text) {
  const t = String(text || '').trimStart();
  return BAD_OPENINGS.some((w) => t.startsWith(w));
}

/* ---------- 接口调用 ---------- */

async function chat(settings, messages, { temperature, maxTokens, onDelta, stop } = {}) {
  const base = String(settings.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const streaming = typeof onDelta === 'function';
  const body = {
    model: settings.model,
    messages,
    temperature: temperature ?? settings.temperature,
    // 一条评论 7-20 字，96 token 够；thinking 模型也不至于卡在这里
    max_tokens: maxTokens ?? Math.min(settings.maxTokens ?? 96, 96),
    top_p: 0.9,
    min_p: 0.05, // 掐掉低概率胡字，量化模型错别字会少一些
    presence_penalty: 0.3,
    frequency_penalty: 0.25,
    // 默认不发 stop：有的模型（Gemma 4）开头会先吐一个换行，stop 会立刻把整条掐空
    stop: stop || undefined,
    stream: streaming,
  };

  let res;
  const controller = new AbortController();
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey || 'lm-studio'}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(
      `连不上本地服务 ${url}。确认 LM Studio 的 Developer → Start Server 已打开、端口一致。原始错误：${e.message}`
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`模型返回 ${res.status}：${text.slice(0, 300)}`);
  }

  if (!streaming) {
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    let content = msg.content;
    if (Array.isArray(content)) content = content.map((c) => c?.text || '').join('');
    if (!content && msg.reasoning_content) content = msg.reasoning_content;
    return String(content || '');
  }

  /* 流式：边生成边把已出的字推给面板，首字到了就能看见 */
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  let lastPush = 0;
  let thinkChars = 0;
  let cutEarly = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch (_) {
          continue;
        }
        const delta = json.choices?.[0]?.delta || {};

        // 模型开始"想"了：一个字正文都没有就先烧思考，直接掐断换法重来，别等它烧完 token
        if (delta.reasoning_content) {
          thinkChars += delta.reasoning_content.length;
          if (!out && thinkChars >= 24) {
            cutEarly = true;
            try {
              controller.abort();
            } catch (_) {
              /* ignore */
            }
            break;
          }
        }

        const piece = delta.content || '';
        if (!piece) continue;
        out += piece;
        const now = Date.now();
        if (now - lastPush > 40) {
          lastPush = now;
          try {
            onDelta(out);
          } catch (_) {
            /* 面板可能已经关了，忽略 */
          }
        }
      }
      if (cutEarly) break;
    }
  } catch (_) {
    /* 主动 abort 或连接被掐断，走下面统一处理 */
  }

  if (cutEarly) return '';
  if (out) {
    try {
      onDelta(out);
    } catch (_) {
      /* ignore */
    }
  }
  return out;
}

/* 明显没写完的输出：太短，或者停在「那/就/但」这种半截词上 */
function looksBroken(text) {
  const t = String(text || '').trim();
  if ([...t].length < 5) return true;
  return /(那|就|而|但|和|与|以及|并且|而且)$/.test(t);
}

/* 只取模型输出的第一行：不带 stop 时它可能写好几行，评论只要第一句 */
function firstLine(raw) {
  const line =
    String(raw || '')
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s && !/^```/.test(s)) || '';
  return limitPunct(sanitize(cleanReply(line)));
}

/* 兜底用的一句话提示：有些模型（Gemma 4 E4B）看到长规则会先"想"一大段，
   96 token 全花在思考上，正文一个字都不剩；这种短提示 + 明确禁止思考能把它掰回来 */
const COMPACT_RULES = `直接回答 不要思考 不要分析 不要列步骤
你是 X 上的普通用户 看到帖子就随手回一句 7-20 字的中文评论
口语 具体 不解释 不总结 不用句号和逗号 不加引号 不加编号
只输出这一句评论`;

function buildCompactMessages(tweet, care) {
  const system = [COMPACT_RULES];
  if (care) system.push('', '原帖涉及疾病 生死 灾难 只说善意的话 禁止调侃');
  const user = `原帖作者：@${tweet.handle || 'unknown'}\n原帖内容：\n"""\n${String(
    tweet.text || ''
  ).slice(0, 1200)}\n"""`;
  return [
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: user },
  ];
}

/* 一条就够：模型给什么就显示什么，不再偷偷重跑把上一条冲掉。
   只有"空输出/明显写断"才算真失败：第二轮换一句短提示把模型拉回正题，第三轮再试一次；
   全程失败才报错。写得长、写得不满意，你自己点「重新生成」。 */
async function generate(tweet, onDelta) {
  const t0 = Date.now();
  const settings = await getSettings();
  const care = isCareContext(tweet?.text);
  const base = settings.temperature || 0.9;

  const tries = [
    { messages: () => buildMessages(tweet, settings, pickAngle(), false, care), temperature: base },
    { messages: () => buildCompactMessages(tweet, care), temperature: 0.8 },
    { messages: () => buildCompactMessages(tweet, care), temperature: 0.95 },
  ];

  for (let i = 0; i < tries.length; i++) {
    const plan = tries[i];
    const raw = await chat(settings, plan.messages(), {
      temperature: Math.min(1.1, plan.temperature),
      onDelta: onDelta ? (text) => onDelta(text, i + 1) : undefined,
    });
    const text = firstLine(raw);
    if (!text || looksBroken(text)) continue; // 空输出/断句才换法再试，正常内容一律照原样显示
    rememberOpening(text);
    return { text, attempts: i + 1, ms: Date.now() - t0 };
  }

  throw new Error(
    '模型连续三次只"想"不写（思考占满了 token）。在 LM Studio 里把这个模型的思考关掉，或者换回上一个模型再点「重新生成」'
  );
}

async function probe() {
  const settings = await getSettings();
  const base = String(settings.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${settings.apiKey || 'lm-studio'}` };

  let res;
  try {
    res = await fetch(`${base}/models`, { headers });
  } catch (e) {
    throw new Error(`连不上 ${base}/models：${e.message}`);
  }
  if (!res.ok) throw new Error(`/models 返回 ${res.status}`);
  const data = await res.json();
  const ids = (data?.data || []).map((m) => m.id).filter(Boolean);
  return { ids, base };
}

/* ---------- 配额 ---------- */

async function commitSend({ id, text, author }) {
  const state = await getState();
  const settings = await getSettings();
  const now = Date.now();

  const dk = todayKey();
  if (state.dayKey !== dk) {
    state.dayKey = dk;
    state.sent = 0;
    state.authorDay = {};
  }
  const hk = hourKey();
  if (state.hourKey !== hk) {
    state.hourKey = hk;
    state.hourSent = 0;
  }

  // 无任何冷却/上限：直接记录
  state.sent += 1;
  state.hourSent += 1;
  state.lastSentAt = now;

  const dayBucket = state.authorDay[dk] || (state.authorDay[dk] = {});
  if (author) dayBucket[author] = (dayBucket[author] || 0) + 1;

  state.history.push({
    id,
    text,
    hash: normalize(text),
    author,
    ts: now,
  });
  if (state.history.length > 500) state.history = state.history.slice(-500);

  await saveState(state);
  return { ok: true, state: publicState(state) };
}

function publicState(state) {
  return {
    sent: state.dayKey === todayKey() ? state.sent : 0,
    hourSent: state.hourKey === hourKey() ? state.hourSent : 0,
    historyIds: state.history.map((h) => h.id),
    authorToday: (state.authorDay[todayKey()] || {}),
  };
}

/* ---------- 消息路由 ---------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'probe':
          sendResponse({ ok: true, ...(await probe()) });
          break;
        case 'getDefaultRules':
          sendResponse({ ok: true, rules: DEFAULT_RULES });
          break;
        case 'generate': {
          const tabId = _sender?.tab?.id;
          const onDelta =
            tabId == null
              ? undefined
              : (text, attempt) => {
                  chrome.tabs
                    .sendMessage(tabId, { type: 'gen-progress', text, attempt })
                    .catch(() => {});
                };
          sendResponse({ ok: true, ...(await generate(msg.tweet, onDelta)) });
          break;
        }
        case 'commit': {
          const r = await commitSend(msg);
          sendResponse(r.ok ? { ok: true, state: r.state } : { ok: false, error: r.reason });
          break;
        }
        case 'getState': {
          const settings = await getSettings();
          sendResponse({ ok: true, state: publicState(await getState()), settings });
          break;
        }
        case 'checkSend':
          sendResponse({ ok: true, reasons: [] });
          break;
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('settings', ({ settings }) => {
    if (!settings) chrome.storage.local.set({ settings: DEFAULTS });
  });
});
