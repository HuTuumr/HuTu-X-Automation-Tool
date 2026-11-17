/* HuTu助手 — content script
 * 每条推文下面注入一个 AI 按钮：
 *   点 AI      → 右侧面板显示原帖文字 + 生成的草稿（可重新生成）
 *   点「回复」 → 定位到该推文、打开回复框、填入草稿、自动点发送
 */
(() => {
  if (window.__xrcLoaded) return;
  window.__xrcLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const ART_SEL = 'article[data-testid="tweet"]';

  const S = { busy: false, current: null };
  const CARE_RE =
    /癌|肿瘤|化疗|放疗|手术|住院|确诊|复发|病危|重病|去世|走了|离世|过世|葬礼|自杀|抑郁|残疾|流产|家暴|车祸|地震|洪水|火灾|痊愈|康复/i;

  /* ================= UI ================= */

  const ui = {};

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'xrc-host';
    host.style.cssText = 'position:fixed;z-index:2147483000;right:16px;bottom:16px;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('panel.css');
    root.appendChild(link);

    const wrap = document.createElement('div');
    wrap.className = 'xrc-panel';
    wrap.innerHTML = `
      <div class="xrc-head">
        <span class="xrc-dot"></span>
        <span class="xrc-title">HuTu助手</span>
        <button class="xrc-icon" data-act="copy" title="复制草稿">⧉</button>
        <button class="xrc-icon" data-act="min" title="收起">–</button>
      </div>
      <div class="xrc-body" data-el="body">
        <div class="xrc-tweet" data-el="tweet">点推文下面的 <b>AI</b> 按钮开始</div>
        <textarea class="xrc-draft" data-el="draft" rows="3" placeholder="草稿会出现在这里，可以手改"></textarea>
        <div class="xrc-cands" data-el="cands"></div>
        <div class="xrc-actions">
          <button class="xrc-btn" data-act="regen">重新生成</button>
          <button class="xrc-btn primary" data-act="send">回复</button>
        </div>
        <div class="xrc-status" data-el="status">就绪</div>
      </div>
    `;
    root.appendChild(wrap);

    const $ = (sel) => wrap.querySelector(sel);
    ui.wrap = wrap;
    ui.tweet = $('[data-el="tweet"]');
    ui.draft = $('[data-el="draft"]');
    ui.cands = $('[data-el="cands"]');
    ui.status = $('[data-el="status"]');

    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'min') {
        ui.wrap.classList.toggle('min');
      } else if (act === 'copy') {
        const t = ui.draft.value.trim();
        if (t) {
          navigator.clipboard
            .writeText(t)
            .then(() => setStatus('已复制'))
            .catch(() => setStatus('复制失败，请手动选中', true));
        }
      } else if (act === 'regen') {
        regenerate();
      } else if (act === 'send') {
        sendReply();
      }
    });
  }

  function setStatus(text, isError = false) {
    ui.status.textContent = text;
    ui.status.classList.toggle('err', !!isError);
  }

  /* ================= 候选列表 ================= */

  function clearCandidates() {
    ui.cands.innerHTML = '';
  }

  function selectCandidate(idx) {
    const btns = [...ui.cands.querySelectorAll('.xrc-cand')];
    const btn = btns[idx];
    if (!btn) return;
    for (const b of btns) b.classList.toggle('active', b === btn);
    ui.draft.value = btn.getAttribute('data-text') || '';
    setStatus(`已选第 ${idx + 1} 条，可以手改，也可以点「回复」直接发`);
  }

  function renderCandidates(list, activeIdx = 0) {
    clearCandidates();
    if (!Array.isArray(list) || list.length < 2) return;
    list.forEach((text, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'xrc-cand' + (i === activeIdx ? ' active' : '');
      b.setAttribute('data-text', text);
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(i + 1);
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = text;
      b.appendChild(n);
      b.appendChild(t);
      b.addEventListener('click', () => selectCandidate(i));
      ui.cands.appendChild(b);
    });
  }

  /* ================= 输入框 ================= */

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 10 && r.bottom > 0 && r.top < window.innerHeight + 80;
  }

  function editableOf(box) {
    if (!box) return null;
    if (box.isContentEditable) return box;
    return box.querySelector('[contenteditable="true"]');
  }

  function visibleDialogEditor() {
    const modals = [...document.querySelectorAll('[aria-modal="true"], [role="dialog"]')].filter(isVisible);
    for (let i = modals.length - 1; i >= 0; i--) {
      const e =
        editableOf(modals[i].querySelector('[data-testid^="tweetTextarea_"]')) ||
        modals[i].querySelector('[contenteditable="true"][role="textbox"]');
      if (e && isVisible(e)) return e;
    }
    return null;
  }

  async function waitFor(fn, timeout = 8000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  async function openReplyEditor(art) {
    const before = new Set(document.querySelectorAll('[contenteditable="true"]'));
    const replyBtn = art.querySelector('[data-testid="reply"]');
    if (!replyBtn) throw new Error('找不到回复按钮');
    replyBtn.click();

    const fresh = await waitFor(() => {
      for (const el of document.querySelectorAll('[contenteditable="true"]')) {
        if (!before.has(el) && isVisible(el)) return el;
      }
      return null;
    }, 6000, 40);
    if (fresh) return fresh;
    return waitFor(() => visibleDialogEditor(), 6000, 40);
  }

  function normalizeText(s) {
    return String(s || '').replace(/[\s\u3000]+/g, '');
  }

  async function clearEditor(editor) {
    try {
      editor.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false);
      // 等它真的空了就走，不再固定睡 150ms
      await waitFor(() => (normalizeText(editor.innerText) ? null : true), 200, 30);
    } catch (_) {
      /* ignore */
    }
  }

  function deleteFrom(editor, offset) {
    try {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let acc = 0;
      let node;
      let startNode = null;
      let startOff = 0;
      while ((node = walker.nextNode())) {
        const len = node.nodeValue.length;
        if (acc + len > offset) {
          startNode = node;
          startOff = offset - acc;
          break;
        }
        acc += len;
      }
      if (!startNode) return false;
      const range = document.createRange();
      range.setStart(startNode, startOff);
      range.setEnd(editor, editor.childNodes.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function fillEditor(editor, text) {
    const want = normalizeText(text);
    const rawLen = String(text).replace(/\s+$/, '').length;
    const diag = [];
    const check = () => normalizeText(editor.innerText);
    const waitText = (ms) => waitFor(() => (check() === want ? true : null), ms, 30);

    // 弹框重新渲染会换掉节点，遇到就跟着换最新的那个
    if (!editor.isConnected) {
      const again = visibleDialogEditor();
      if (again) editor = again;
    }

    // 已经聚焦就别再点一遍、也别干等，直接写
    if (document.activeElement !== editor) {
      try {
        editor.click();
      } catch (_) {
        /* ignore */
      }
      editor.focus();
    }
    diag.push('focus:' + (document.activeElement === editor ? 'ok' : 'no'));

    await clearEditor(editor);
    try {
      document.execCommand('insertText', false, text);
    } catch (_) {
      /* ignore */
    }
    if (await waitText(240)) return { ok: true, diag };

    let got = check();
    diag.push('exec:' + got.length);
    // X 偶尔会自动补全，把多出来的尾巴删掉
    if (got.length > want.length && got.startsWith(want)) {
      deleteFrom(editor, rawLen);
      if (await waitText(240)) return { ok: true, diag, trimmed: true };
    }

    // 兜底一：粘贴
    await clearEditor(editor);
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      editor.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      );
    } catch (_) {
      /* ignore */
    }
    if (await waitText(280)) {
      diag.push('paste');
      return { ok: true, diag };
    }

    // 兜底二：beforeinput
    await clearEditor(editor);
    editor.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      })
    );
    if (await waitText(280)) {
      diag.push('bi');
      return { ok: true, diag };
    }

    await clearEditor(editor);
    return { ok: false, diag };
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }

  function isDisabled(btn) {
    return !btn || btn.disabled === true || btn.getAttribute('aria-disabled') === 'true';
  }

  function sendButtonFor(editor) {
    const scope = editor.closest('[aria-modal="true"], [role="dialog"]') || document;
    const b =
      scope.querySelector('[data-testid="tweetButton"]') ||
      scope.querySelector('[data-testid="tweetButtonInline"]');
    return b && !isDisabled(b) ? b : null;
  }

  /* ================= 抓取 ================= */

  function extract(art) {
    const nameLink = art.querySelector('[data-testid="User-Name"] a[href*="/status/"]');
    const link = nameLink || art.querySelector('a[href*="/status/"]');
    if (!link) return null;
    const m = (link.getAttribute('href') || '').match(/\/([A-Za-z0-9_]{1,20})\/status\/(\d+)/);
    if (!m) return null;
    if (art.querySelector('[data-testid="placementTracking"]')) return null;

    const textEl = art.querySelector('[data-testid="tweetText"]');
    let text = (textEl ? textEl.innerText : '').trim();
    if (!text) {
      // 纯图片帖：用图片的 alt 文字兜底
      const img = art.querySelector('[data-testid="tweetPhoto"] img[alt]');
      if (img) text = (img.getAttribute('alt') || '').trim();
    }
    if (!text) return null;

    return { id: m[2], handle: m[1].toLowerCase(), text };
  }

  function findArticle(id) {
    for (const a of document.querySelectorAll(`a[href*="/status/${id}"]`)) {
      const art = a.closest(ART_SEL);
      if (art) return art;
    }
    return null;
  }

  /* ================= 注入按钮 ================= */

  function injectButton(art) {
    const group = art.querySelector('[role="group"]');
    if (!group) return;
    // 按按钮本身判断：X 重绘操作栏会把它抹掉，抹掉就补回来
    if (group.querySelector('.xrc-ai-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xrc-ai-btn';
    btn.textContent = 'AI';
    btn.title = '生成回复草稿';
    btn.style.cssText = [
      'margin-left:12px',
      'padding:2px 9px',
      'border:1px solid #536471',
      'border-radius:999px',
      'background:transparent',
      'color:#1d9bf0',
      'font:600 11px/1.5 -apple-system,"Segoe UI","PingFang SC",sans-serif',
      'cursor:pointer',
      'vertical-align:middle',
    ].join(';');

    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(29,155,240,0.12)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'transparent';
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openFor(art, btn);
    });
    for (const ev of ['mousedown', 'pointerdown', 'touchstart']) {
      btn.addEventListener(ev, (e) => e.stopPropagation());
    }

    group.appendChild(btn);
  }

  function injectAll() {
    for (const art of document.querySelectorAll(ART_SEL)) {
      if (extract(art)) injectButton(art);
    }
  }

  /* ================= 主流程 ================= */

  /* 扩展被"重新加载"过（改代码/更新版本）之后，页面里跑的仍然是旧脚本，
     它的 chrome.runtime 已经作废，任何消息都会抛 Extension context invalidated。
     这种情况只能刷新页面；这里顺手帮用户刷一次，别让他看到一串英文报错。 */
  async function sendToBackground(msg, retried = false) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      const text = String((e && e.message) || e);
      if (/Extension context invalidated|Cannot access a chrome|message port closed/i.test(text)) {
        const err = new Error('扩展刚更新过，页面里还是旧脚本，正在刷新页面…');
        err.needsReload = true;
        throw err;
      }
      // 后台 Service Worker 刚被系统挂起，等它起来再发一次
      if (!retried && /Receiving end does not exist|Could not establish connection/i.test(text)) {
        await sleep(300);
        return sendToBackground(msg, true);
      }
      throw e;
    }
  }

  async function generateDraft(tweet) {
    const t0 = Date.now();
    const r = await sendToBackground({
      type: 'generate',
      tweet: { handle: tweet.handle, text: tweet.text },
    });
    if (!r?.ok) throw new Error(r?.error || '生成失败');
    // clientMs 是从点击到拿到结果的总时间（含消息往返），比 r.ms 更接近你实际等的
    return { ...r, clientMs: Date.now() - t0 };
  }

  /* 需要刷新页面时给个明确提示，并自动刷一次 */
  function handleNeedsReload(e) {
    if (!e || !e.needsReload) return false;
    setStatus(e.message, true);
    setTimeout(() => {
      try {
        location.reload();
      } catch (_) {
        /* ignore */
      }
    }, 900);
    return true;
  }

  /* 把返回结果铺进面板：草稿框放最好那条，下面列出全部候选 */
  function applyResult(r) {
    const list = Array.isArray(r?.candidates) ? r.candidates.filter(Boolean) : [];
    const pick = Number.isInteger(r?.pick) && r.pick >= 0 && r.pick < list.length ? r.pick : 0;
    const text = String(r?.text || list[0] || '');
    ui.draft.value = text;
    renderCandidates(list.length > 1 ? list : [], pick);
    return list.length;
  }

  function doneStatus(tweet, count, ms) {
    const time = typeof ms === 'number' && ms > 0 ? ` · ${(ms / 1000).toFixed(2)}s` : '';
    if (CARE_RE.test(tweet.text)) {
      return `⚠ 涉及疾病/生死/灾难，已强制温和语气。发之前自己再看一眼${time}`;
    }
    if (count > 1) return `已生成 ${count} 条，点任意一条换进草稿框；都不满意点「重新生成」${time}`;
    return `草稿就绪。不满意点「重新生成」，满意点「回复」直接发出${time}`;
  }

  async function openFor(art, btn) {
    if (S.busy) return setStatus('还在处理上一条，稍等');

    const tweet = extract(art);
    if (!tweet) return setStatus('这条读不到文字，换一条', true);

    S.busy = true;
    const label = btn.textContent;
    btn.textContent = '…';
    btn.disabled = true;

    try {
      S.current = tweet;
      ui.tweet.textContent = `@${tweet.handle}：${tweet.text}`;
      ui.draft.value = '';
      clearCandidates();
      setStatus('生成中…');
      const r = await generateDraft(tweet);
      const count = applyResult(r);
      setStatus(doneStatus(tweet, count, r.clientMs || r.ms));
    } catch (e) {
      if (!handleNeedsReload(e)) setStatus('生成失败：' + e.message, true);
    } finally {
      btn.textContent = label;
      btn.disabled = false;
      S.busy = false;
    }
  }

  async function regenerate() {
    if (S.busy) return setStatus('还在处理，稍等');
    if (!S.current) return setStatus('先点一条推文的 AI 按钮', true);

    S.busy = true;
    try {
      clearCandidates();
      setStatus('重新生成中…');
      const r = await generateDraft(S.current);
      const count = applyResult(r);
      setStatus(count > 1 ? `又换了一批（${count} 条），点一条换进草稿框` : doneStatus(S.current, count, r.clientMs || r.ms));
    } catch (e) {
      if (!handleNeedsReload(e)) setStatus('重新生成失败：' + e.message, true);
    } finally {
      S.busy = false;
    }
  }

  async function sendReply() {
    if (S.busy) return setStatus('还在处理，稍等');
    if (!S.current) return setStatus('先点一条推文的 AI 按钮', true);

    const text = ui.draft.value.trim();
    if (!text) return setStatus('草稿为空', true);

    const c = S.current;
    S.busy = true;
    let editor = null;

    try {
      const art = findArticle(c.id);
      if (!art) throw new Error('这条推文已经不在页面上，滚回去再点一次 AI');

      // 已经在屏幕里就不滚动，省掉原来那 1 秒多的干等
      if (!inViewport(art)) {
        setStatus('定位推文…');
        art.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }

      // 上一个回复框还开着：先关掉，并且等它真的关掉
      if (visibleDialogEditor()) {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })
        );
        await waitFor(() => (visibleDialogEditor() ? null : true), 700, 40);
      }

      setStatus('打开回复框…');
      editor = await openReplyEditor(art);
      if (!editor) throw new Error('回复框没弹出来');

      // 等 X 把光标放进去（通常几十毫秒），最多等 400ms，不再固定睡 0.5–0.9 秒
      await waitFor(() => (document.activeElement === editor ? true : null), 400, 30);
      if (!editor.isConnected) {
        const again = visibleDialogEditor();
        if (again) editor = again;
      }

      setStatus('写入草稿…');
      const w = await fillEditor(editor, text);
      if (!w.ok) {
        try {
          await navigator.clipboard.writeText(text);
        } catch (_) {
          /* ignore */
        }
        throw new Error(`写入失败[${w.diag.join(' ')}]，草稿已复制`);
      }

      setStatus('发送中…');
      let sendBtn = await waitFor(() => sendButtonFor(editor), 4000, 30);
      if (!sendBtn) {
        // 字有可能被页面清掉、或者输入框被重新渲染换掉了，重取节点再写一次
        const again = visibleDialogEditor();
        if (again) editor = again;
        await fillEditor(editor, text);
        sendBtn = await waitFor(() => sendButtonFor(editor), 2500, 30);
      }
      if (!sendBtn) throw new Error('发送按钮一直是灰色');
      sendBtn.click();

      const closed = () => !(editor.isConnected && isVisible(editor));
      let ok = await waitFor(() => (closed() ? true : null), 6000, 60);
      if (!ok) {
        const again = sendButtonFor(editor);
        if (again) {
          again.click();
          ok = await waitFor(() => (closed() ? true : null), 4000, 60);
        }
      }
      if (!ok) {
        const toast = [...document.querySelectorAll('[data-testid="toast"]')]
          .map((t) => t.innerText.trim())
          .filter(Boolean)
          .join(' / ');
        throw new Error('点了发送但回复框没关' + (toast ? `：${toast}` : ''));
      }

      setStatus('已发送 ✓');
    } catch (e) {
      try {
        if (editor && editor.isConnected && editor.innerText.trim()) await clearEditor(editor);
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })
        );
      } catch (_) {
        /* ignore */
      }
      setStatus('失败：' + e.message, true);
    } finally {
      S.busy = false;
    }
  }

  /* ================= 启动 ================= */

  function init() {
    buildUI();
    injectAll();

    // 模型边生成边回传：先把第一条实时显示出来，三条都到齐再列候选
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== 'gen-progress' || typeof msg.text !== 'string') return;
      if (!S.busy) return;
      const firstLine = String(msg.text).split('\n').find((l) => l.trim()) || '';
      ui.draft.value = firstLine
        .replace(/^\s*(?:[1-9１-９①②③])\s*[.、)．:：]\s*/, '')
        .replace(/[。，、；]/g, '')
        .trim();
    });

    const mo = new MutationObserver(() => {
      clearTimeout(init.__t);
      init.__t = setTimeout(injectAll, 250);
    });
    mo.observe(document.body, { childList: true, subtree: true });

    setStatus('就绪：点推文下面的 AI');
  }

  init();
})();
