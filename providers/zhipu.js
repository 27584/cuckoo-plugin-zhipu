/**
 * 智谱清言（chatglm.cn）Provider —— 适配 Cuckoo Code 0.8.x
 *
 * 本版修复的关键问题（历次症状：不解析模型回复 / 永远显示思考中）：
 *
 * 1) 【致命】原 hook 在 handleFrame 里调用 scheduleFinish(st)，但该函数**从未定义**。
 *    finish 帧到达时抛 ReferenceError → 被 fetch pump 的 .catch(){} 静默吞掉 →
 *    pump 链断裂 → 永远到不了 r.done → finishStream 永不执行 →
 *    一条 'cuckoo-ai-response' 都发不出去（= 不解析回复），
 *    而 'cuckoo-ai-stream' 早已推送思考内容（= 永远思考中）。
 *    本版改为具名 scheduleFinish + handleFrame 逐帧 try-catch + pump catch 兜底派发。
 *
 * 2) 正文提取过于依赖 2026-09 逆向出的旧格式（content[].type === 'text'）。
 *    实机日志统计：58 个 think 帧、'text' 类型 0 次、tool_calls 仅 finish。
 *    本版按「类型分类」提取：think 类 / tool 类 / 其余一律视为正文，
 *    并在首次遇到新 item 类型时打印诊断，便于按真实帧格式继续收敛。
 *
 * 3) 结束判定放宽：event==='finish'、status 终态、tool_calls.name==='finish'
 *    三种信号任一命中即派发完成事件（不再要求正文非空）。
 *
 * DOM 结论（沿用实测）：
 * - 输入框：textarea.scroll-display-none
 * - 发送按钮：div.enter（非 button，内含 .enter-icon-container，空态含 empty class）
 * - 会话 URL：/main/alltoolsdetail?lang=zh&cid=<sessionId>；首页：chatglm.cn 下无 cid
 * - 智谱免疫合成事件，发送必须走主进程 sendInputEvent 注入原生 Enter
 */
module.exports = {
  id: 'zhipu',
  name: '智谱清言',
  homeUrl: 'https://chatglm.cn/',
  sessionUrlBase: 'https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=',

  // 回复获取走网络拦截模式（主世界 hook）
  useIntercept: true,

  // 输入框选择器（findInput 自定义实现优先，此处作兜底）
  inputSelectors: ['textarea.scroll-display-none', 'textarea'],

  isElementVisible(el) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // 查找可见的聊天输入框（智谱 textarea 无 placeholder，按结构与可见性定位）
  findInput() {
    const candidates = [
      'textarea.scroll-display-none',
      'textarea',
      'div[contenteditable="true"]',
      '[role="textbox"]',
    ];
    for (const sel of candidates) {
      let el = null;
      try { el = document.querySelector(sel); } catch (_) { el = null; }
      if (!el) continue;
      try {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      } catch (_) { /* 环境无 window 时信任存在性 */ }
      return el;
    }
    return null;
  },

  // 查找发送按钮（div.enter，非 button）
  // 注：智谱免疫合成点击，该按钮仅作语义返回；实际发送走 triggerSend 原生 Enter
  findSendButton() {
    const enter = document.querySelector('.enter');
    if (!enter) return null;
    const icon = document.querySelector('.enter-icon-container');
    if (icon && /empty/.test(icon.className)) return null; // 空态不可发送
    return enter;
  },

  /**
   * 站点原生发送触发：智谱只响应真实输入（isTrusted=true），合成事件全部免疫。
   * 经主进程 webContents.sendInputEvent 注入原生 Enter（焦点在输入框时等效真实按键）。
   * @param {Element} input 输入框元素
   * @returns {Promise<boolean>} 是否已处理（true 阻止通用发送逻辑继续）
   */
  async triggerSend(input) {
    try {
      if (window.electronAPI && typeof window.electronAPI.sendEnterToChat === 'function') {
        await window.electronAPI.sendEnterToChat();
        console.log('[Cuckoo Code] 智谱：已请求原生 Enter 发送（sendInputEvent）');
        return true;
      }
    } catch (_) { /* IPC 失败时回退通用逻辑 */ }
    return false;
  },

  // 提取当前用户信息文本（未登录显示"访客_xxx"）
  extractUserInfo() {
    const selectors = ['.user-name', '[class*="userName"]', '[class*="user-name"]'];
    for (const sel of selectors) {
      let el = null;
      try { el = document.querySelector(sel); } catch (_) { el = null; }
      if (el && el.textContent && el.textContent.trim()) return el.textContent.trim();
    }
    return '';
  },

  // 首页判断正则（chatglm.cn 下无 cid 参数；对话页带 cid=xxx）
  homeUrlPattern: /^https:\/\/chatglm\.cn\/?(#|\?lang=[^&]*)?$/i,

  // 从 URL 提取会话 ID（仅 chatglm.cn 的 cid 参数）
  extractSessionId(url) {
    if (!url) return null;
    const m = String(url).match(/[?&]cid=([a-f0-9-]+)/i);
    return m ? m[1] : null;
  },

  // 判断 URL 是否属于本平台
  matchesUrl(url) {
    if (!url) return false;
    try {
      const host = new URL(url).hostname;
      return /(^|\.)chatglm\.cn$/i.test(host);
    } catch (_) {
      return false;
    }
  },

  // ========== 侧栏「对话」列表：智谱自定义抓取 ==========
  /**
   * 智谱侧栏是 Vue SPA（Element UI），会话项为 div+点击，DOM 里没有 cid
   * （实机诊断：anchors=3 cidAttrEls=0，DOM 扫描这条路走不通）。
   *
   * 首选数据源：hook 拦截的会话列表接口响应（window.__cuckooZhipuSessions__），
   * 由 getHookSource 注入的探针在页面请求列表接口时自动缓存——标题与 cid 都是
   * 智谱自己的 API 数据，最真实。
   *
   * 兜底：DOM 三策略扫描（锚点带 cid → data 属性带 cid → 侧栏容器挖 cid），
   * 以防未来智谱把 cid 渲染进 DOM。
   *
   * 该函数会被 toString 序列化后注入主世界，必须自包含。
   * 返回 [{ title, href, active }]，href 统一拼成会话 URL 供点击导航。
   */
  getSessionListFn() {
    return function zhipuSessionList(doc, win, base) {
      try {
        var out = [];
        var seen = {};
        var CID_RE = /[?&#]cid=([a-f0-9-]{8,})/i;
        var MAX = 100;
        var CURRENT = (win.location && win.location.search || '').match(CID_RE);

        function titleOf(el) {
          var t = String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
          return t.slice(0, 80);
        }
        function isActive(el) {
          try {
            var cls = (typeof el.className === 'string') ? el.className : '';
            if (/active|selected|current|checked/i.test(cls)) return true;
            if (el.getAttribute && el.getAttribute('aria-current') === 'page') return true;
          } catch (e) { /* ignore */ }
          return false;
        }
        function push(cid, title, active) {
          if (!cid || !title) return;
          if (seen[cid]) return;
          seen[cid] = 1;
          out.push({
            title: title,
            href: 'https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=' + cid,
            active: !!active || (String(cid) === String(CURRENT && CURRENT[1])),
          });
        }

        // 诊断：抓不到时把 DOM 线索打进日志（zhipu.log）。
        // shell 每 ~500ms 轮询本函数，因此每 30s 最多打一次，避免刷屏。
        var lastDiagAt = 0;
        function diag() {
          var now = Date.now();
          if (now - lastDiagAt < 30000) return;
          lastDiagAt = now;
          try {
            // 聚焦「最近对话」标题所在容器的完整子树 —— 会话项就渲染在它下面
            var focus = '';
            var marks = doc.querySelectorAll('[class*="recent"],[class*="history"],li,div');
            for (var f = 0; f < marks.length; f++) {
              var ft = String((marks[f].innerText || marks[f].textContent) || '').trim();
              if (ft === '最近对话' || /^(最近对话|历史会话|Recent)$/.test(ft)) {
                var box = marks[f].parentElement || marks[f];
                focus = String(box.outerHTML || '').replace(/\s+/g, ' ').slice(0, 2200);
                break;
              }
            }
            if (focus) { console.log('[zhipu-sessions][dom-focus] ' + focus); return; }
            // 找不到标题标记时退回侧栏容器采样
            var sidebars = doc.querySelectorAll('aside,nav,[class*="sidebar"],[class*="sider"],[class*="history"],[class*="conversation"],[class*="chat-list"],[class*="session"]');
            var sample = '';
            for (var i = 0; i < sidebars.length && sample.length < 1400; i++) {
              var h = String(sidebars[i].outerHTML || '').replace(/\s+/g, ' ');
              if (h) sample += '[c' + i + '] ' + h.slice(0, 700) + ' || ';
            }
            console.log('[zhipu-sessions] 未抓到会话 | anchors=' + doc.querySelectorAll('a[href]').length + ' apiCache=' + (!!win.__cuckooZhipuSessions__));
            console.log('[zhipu-sessions][dom] ' + sample.slice(0, 1800));
          } catch (e) { /* ignore */ }
        }
        // 统一出口：空结果时打诊断
        function done() {
          if (!out.length) diag();
          return out.slice(0, MAX);
        }

        // ---- 策略 -1（主动重放）：页面内直接 fetch 实证列表接口 ----
        // 页面带登录 cookie 与 WAF 动态参数（hook 记录在 __cuckooZhipuListUrl__）。
        // 本函数被序列化注入主世界执行，**不能引用闭包外的 rememberListJson**
        // （上一版正是在这里抛 ReferenceError 被吞，缓存永远写不进），
        // 故解析逻辑内联自足。
        var replayUrl = win.__cuckooZhipuListUrl__ || '/chatglm/mainchat-api/conversation/recent_list';
        if (!win.__cuckooZhipuSessions__ && !win.__cuckooZhipuReplaying__) {
          win.__cuckooZhipuReplaying__ = true;
          try {
            win.fetch(replayUrl, { credentials: 'include' }).then(function (resp) {
              try { return resp.text(); } catch (e) { return ''; }
            }).then(function (txt) {
              win.__cuckooZhipuReplaying__ = false;
              if (!txt) return;
              try {
                var data = JSON.parse(txt);
                // 实机结构：result.conversation_list[].{conversation_id,title}
                var arr = data && data.result && Array.isArray(data.result.conversation_list)
                  ? data.result.conversation_list
                  : (Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : null));
                if (!arr) return;
                var list = [];
                for (var i = 0; i < arr.length; i++) {
                  var c = arr[i] || {};
                  var cid = c.conversation_id || c.conversationId || c.id;
                  var title = c.title || c.name || '';
                  if (!cid || !title) continue;
                  list.push({ cid: String(cid), title: String(title).slice(0, 80), updated_at: '' });
                }
                if (list.length) win.__cuckooZhipuSessions__ = { at: Date.now(), key: 'replay', list: list };
              } catch (e) { /* ignore */ }
            }).catch(function () { win.__cuckooZhipuReplaying__ = false; });
          } catch (e) { win.__cuckooZhipuReplaying__ = false; }
        }

        // ---- 策略 0（首选）：hook 缓存的列表接口数据 ----
        var cache = win.__cuckooZhipuSessions__;
        if (cache && Array.isArray(cache.list) && cache.list.length) {
          for (var s = 0; s < cache.list.length && out.length < MAX; s++) {
            var it0 = cache.list[s];
            push(it0.cid, it0.title, false);
          }
          if (out.length) {
            console.log('[zhipu-sessions] 来自列表接口: ' + out.length + ' 条 (缓存于 ' + new Date(cache.at).toISOString() + ')');
            return done();
          }
        }

        // ---- 策略 1：带 cid 的锚点 ----
        var anchors = doc.querySelectorAll('a[href]');
        for (var i = 0; i < anchors.length && out.length < MAX; i++) {
          var a = anchors[i];
          // 兼容：a.href 在浏览器里是绝对 URL，但部分环境/模拟下只有属性值
          var href = a.href || (a.getAttribute && a.getAttribute('href')) || '';
          if (!href) continue;
          var m1 = String(href).match(CID_RE);
          if (!m1) continue;
          push(m1[1], titleOf(a), isActive(a));
        }
        if (out.length) return done();

        // ---- 策略 2：任意元素属性里带 cid（SPA 常见）----
        var all = doc.querySelectorAll('[data-cid],[data-id],[data-conversation-id],[data-conv-id],[data-chat-id],[data-session-id],[data-key]');
        for (var j = 0; j < all.length && out.length < MAX; j++) {
          var el = all[j];
          var attrs = el.attributes || [];
          var cid2 = null;
          for (var q = 0; q < attrs.length; q++) {
            var m2 = String(attrs[q].value || '').match(CID_RE);
            if (m2) { cid2 = m2[1]; break; }
          }
          if (!cid2) continue;
          push(cid2, titleOf(el), isActive(el));
        }
        if (out.length) return done();

        // ---- 策略 3：兜底 —— 侧栏容器内逐项挖 cid ----
        var sidebars = doc.querySelectorAll('aside,nav,[class*="sidebar"],[class*="sider"],[class*="history"],[class*="conversation"],[class*="chat-list"],[class*="session"]');
        for (var k = 0; k < sidebars.length && out.length < MAX; k++) {
          var items = sidebars[k].querySelectorAll('li,a,[role="button"],[role="listitem"],div[class]');
          for (var n = 0; n < items.length && out.length < MAX; n++) {
            var it = items[n];
            var t = titleOf(it);
            if (!t) continue;
            var node = it;
            var cid3 = null;
            for (var d = 0; d <= 4 && node && node.getAttribute; d++) {
              var at = node.attributes || [];
              for (var w = 0; w < at.length; w++) {
                var m3 = String(at[w].value || '').match(CID_RE);
                if (m3) { cid3 = m3[1]; break; }
              }
              if (cid3) break;
              node = node.parentElement;
            }
            if (cid3) push(cid3, t, isActive(it));
          }
        }
        return done();
      } catch (e) { return []; }
    };
  },

  // ========== harness 附件上传：上传入口探测 ==========
  /**
   * 返回「上传入口探测函数」的源码字符串，供核心 CDP 上传通道调用
   * （见 src/app/ipc/cdp-attach.ts：探测坐标 → CDP 真实点击 → 拦截文件选择框 → 注入文件）。
   *
   * 为什么必须由 provider 提供：通用探测要求元素的 class/aria/title 命中
   * attach/upload/file/image 等关键词，而智谱的上传键是纯图标元素（Element UI），
   * 类名不含这些词 → 通用探测返回 no-candidate → 上传直接失败。
   *
   * 源码在主世界执行，必须自包含；返回 { found, x, y }（视口坐标）。
   * 无论成败都把输入区元素清单打进页面控制台（zhipu.log），便于按真实 DOM 收敛。
   */
  getAttachProbeSource() {
    return '(' + function zhipuAttachProbe(doc, win, fileInfo) {
      try {
        var vh = win.innerHeight || 800;
        var vw = win.innerWidth || 1200;
        var isImage = !!(fileInfo && /^image\//i.test(fileInfo.mime || ''));
        var hits = [];

        function visible(el) {
          var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          if (!r || r.width === 0 || r.height === 0) return null;
          if (r.left < 0 || r.top < 0 || r.left > vw || r.top > vh) return null;
          return r;
        }
        function centerOf(el) {
          var r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        function own(el) {
          try { return !!(el.closest && el.closest('[class*="cuckoo-"]')); } catch (e) { return false; }
        }
        function pick(el, tag) {
          var c = centerOf(el);
          console.log('[zhipu-attach] 命中: ' + tag + ' @' + c.x + ',' + c.y);
          return { found: true, x: c.x, y: c.y, tag: tag, candidates: hits };
        }

        // ---- 第 1 优先：两步流程的第二步 —— 工具菜单已打开，点「本地文件选择」----
        // （实机菜单项文本，见 2026-10-01 截图：云知识库选择 / 本地文件选择）
        var MENU_TEXT = /^(本地文件选择|上传本地文件|选择本地文件|本地文件)$/;
        var nodes = doc.querySelectorAll('div,span,li,p,a,button');
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (own(n)) continue;
          var rn = visible(n);
          if (!rn) continue;
          var t = String(n.textContent || '').replace(/\s+/g, '').trim();
          if (!t || t.length > 12) continue;
          if (MENU_TEXT.test(t)) {
            hits.push('menu:' + t);
            return pick(n, 'menu:' + t);
          }
        }

        // ---- 第 2 优先：图片 → 图片上传键（实机类名 .upload-image-btn-container）----
        var imgBtn = null;
        try {
          imgBtn = doc.querySelector('.upload-image-btn-container, .upload-image-wrap, [class*="upload-image"]');
        } catch (e) { /* ignore */ }
        var imgRect = imgBtn ? visible(imgBtn) : null;
        if (imgRect) hits.push('image-btn@' + Math.round(imgRect.left) + ',' + Math.round(imgRect.top));
        if (isImage && imgBtn && imgRect && !own(imgBtn)) {
          return pick(imgBtn, 'upload-image');
        }

        // ---- 第 3 优先：非图片 → 工具键（点击弹出菜单，下一轮命中「本地文件选择」）----
        // 实机：与图片键同一行、位于其右侧的 .el-tooltip__trigger
        var tools = [];
        try {
          var tgs = doc.querySelectorAll('.el-tooltip__trigger');
          for (var j = 0; j < tgs.length; j++) {
            var tg = tgs[j];
            if (own(tg)) continue;
            var rt = visible(tg);
            if (!rt) continue;
            if (rt.top < vh * 0.8) continue;          // 只看输入区工具栏（排除消息操作条）
            tools.push({ el: tg, rect: rt });
          }
        } catch (e) { /* ignore */ }
        tools.sort(function (a, b) { return a.rect.left - b.rect.left; });
        for (var k = 0; k < tools.length; k++) {
          hits.push('tool@' + Math.round(tools[k].rect.left) + ',' + Math.round(tools[k].rect.top));
        }
        if (tools.length) {
          // 图片键右侧的那个即工具键；找不到图片键时取第二个
          var target = null;
          if (imgRect) {
            for (var m = 0; m < tools.length; m++) {
              if (tools[m].rect.left > imgRect.left + 5) { target = tools[m]; break; }
            }
          }
          if (!target) target = tools[tools.length > 1 ? 1 : 0];
          return pick(target.el, 'tools-trigger');
        }

        // ---- 兜底：输入区小图标打分（保持原有启发式）----
        var KEY = /(attach|upload|paperclip|file|image|图片|文件|上传|附件|相册)/i;
        var scored = [];
        var cands = doc.querySelectorAll('button,[role="button"],span,div,i,svg,label');
        for (var q = 0; q < cands.length; q++) {
          var el = cands[q];
          if (own(el)) continue;
          var r = visible(el);
          if (!r) continue;
          if (r.top < vh * 0.55) continue;
          if (r.width > 90 || r.height > 90) continue;
          var cls = (typeof el.className === 'string') ? el.className : '';
          if (/cuckoo/i.test(cls)) continue;
          var sig = cls + ' ' + ((el.getAttribute && el.getAttribute('aria-label')) || '') + ' ' + ((el.getAttribute && el.getAttribute('title')) || '');
          var score = 0;
          if (KEY.test(sig)) score += 100;
          if (/icon|btn|tool|operate|action|item/i.test(cls)) score += 10;
          try { if (el.querySelector && el.querySelector('svg,i,img')) score += 8; } catch (e) { /* ignore */ }
          if (r.left < vw * 0.5) score += 10;
          if (r.top > vh * 0.8) score += 6;
          if (/enter|send|submit/i.test(cls)) score -= 60;
          if (score > 0) scored.push({ score: score, el: el, rect: r, sig: (el.tagName + '.' + cls).slice(0, 60) });
        }
        scored.sort(function (a, b) { return b.score - a.score; });
        console.log('[zhipu-attach] 兜底候选(前10): ' + scored.slice(0, 10).map(function (s) {
          return s.score + '@' + Math.round(s.rect.left) + ',' + Math.round(s.rect.top) + ' ' + s.sig;
        }).join(' || '));
        if (!scored.length) return { found: false, reason: 'no-candidate', candidates: hits };
        return pick(scored[0].el, 'scored:' + scored[0].sig);
      } catch (e) {
        return { found: false, reason: 'error:' + (e && e.message) };
      }
    }.toString() + ')';
  },

  // ========== harness「暂停」：停止生成 ==========
  /**
   * 智谱的停止按钮定位。核心内置的启发式（attachStopFn）是为 DeepSeek 设计系统写的
   * （ds-button--primary / svg rect 判定），智谱是 Element UI，发送键是 div.enter
   * 而非 <button>，连候选都进不去 → 定位失败 → 只发了 Escape → 生成不停。
   *
   * 本函数在 AI 页面主世界执行（由 harness-stop 经 executeJavaScript 注入），必须自包含。
   * 返回 { found, x, y } 视口坐标，由主进程用 CDP 派发真实点击。
   *
   * 同时调用 hook 暴露的 __cuckooZhipuAbort__ 立即收尾在途回合：
   * 即使站点按钮没点到（DOM 改版等），harness 界面也能立刻停住。
   */
  getStopFn() {
    return function zhipuStopLocator(doc, win) {
      var out = { found: false, cands: [], sig: '', aborted: 0, streaming: false, api: 'none' };
      try {
        // 必须在本地收尾之前读取流状态（收尾会复位 __cuckooZhipuStreaming__）
        var wasStreaming = !!win.__cuckooZhipuStreaming__;
        out.streaming = wasStreaming;

        // ---- 首选：直接调站点停止接口 ----
        // 实机实证（zhipu.log 2026-10-01）：POST /chatglm/mainchat-api/stream/stop_stream -> 200
        // 与 deepseek hook 拦截 stop_stream 的机制同源。直接调接口比点 DOM 可靠：
        // 不依赖按钮结构/坐标，也不会误点消息正文（旧版 [class*="stop"] 曾命中
        // .markdown-body.stop_margin_bottom 而点错元素）。
        try {
          var cidM = ((win.location && win.location.search) || '').match(/[?&]cid=([a-f0-9-]+)/i);
          var payload = JSON.stringify({ conversation_id: cidM ? cidM[1] : '' });
          win.fetch('/chatglm/mainchat-api/stream/stop_stream', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          }).then(function (r) {
            console.log('[zhipu-stop] stop_stream -> ' + (r && r.status));
          }).catch(function (e) {
            console.log('[zhipu-stop] stop_stream 异常: ' + (e && e.message));
          });
          out.api = 'sent';
        } catch (e) {
          out.api = 'error:' + (e && e.message);
        }

        // ---- 本地收尾：界面立即停住（不依赖接口是否成功）----
        try {
          if (typeof win.__cuckooZhipuAbort__ === 'function') out.aborted = win.__cuckooZhipuAbort__();
        } catch (e) { /* ignore */ }

        // ---- DOM 兜底：只认高置信度停止按钮；无生成在途时一律不点 ----
        if (!wasStreaming) {
          console.log('[zhipu-stop] 无生成在途：已调停止接口(api=' + out.api + ') 中止=' + out.aborted + '，不做 DOM 点击');
          return out;
        }
        var vh = win.innerHeight || 800;
        var vw = win.innerWidth || 1200;
        function rectOf(el) {
          try {
            var r = el.getBoundingClientRect();
            if (!r || r.width === 0 || r.height === 0) return null;
            if (r.left < 0 || r.top < 0 || r.left > vw || r.top > vh) return null;
            return r;
          } catch (e) { return null; }
        }
        function own(el) {
          try { return !!(el.closest && el.closest('[class*="cuckoo-"]')); } catch (e) { return false; }
        }
        var picks = [];
        // 高置信度 1：智谱发送键 div.enter 在生成时切换为停止键（含方块图标）
        try {
          var enter = doc.querySelector('.enter');
          if (enter && !own(enter)) {
            var er = rectOf(enter);
            if (er) {
              var hasRect = false;
              try { hasRect = !!(enter.querySelector && enter.querySelector('svg rect')); } catch (e) { /* ignore */ }
              picks.push({
                el: enter, rect: er, score: hasRect ? 220 : 120,
                sig: 'enter' + (hasRect ? '(rect=方块=停止)' : '(无方块图标)'),
              });
            }
          }
        } catch (e) { /* ignore */ }
        // 高置信度 2：严格词边界匹配停止语义（修掉 flex-x-center / stop_margin_bottom 这类子串误命中）
        var all = doc.querySelectorAll('button,[role="button"],div,span,i,a');
        var WORD = /(^|[\s_-])(stop|pause|abort|interrupt)([\s_-]|$)|停止|中止|中断/;
        for (var i = 0; i < all.length && i < 3000; i++) {
          var el = all[i];
          if (own(el)) continue;
          var cls = (typeof el.className === 'string') ? el.className : '';
          var aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
          var title = (el.getAttribute && el.getAttribute('title')) || '';
          var txt = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 10);
          var blob = cls + ' ' + aria + ' ' + title + ' ' + txt;
          if (!WORD.test(blob)) continue;
          var rr = rectOf(el);
          if (!rr) continue;
          if (rr.top < vh * 0.5) continue;             // 停止键在输入区，不在正文区
          if (rr.width > 120 || rr.height > 80) continue;
          picks.push({ el: el, rect: rr, score: 200, sig: 'kw:' + (el.tagName + '.' + cls).slice(0, 50) + '|' + txt });
        }
        picks.sort(function (a, b) { return b.score - a.score; });
        out.cands = picks.slice(0, 8).map(function (p) {
          return p.score + '@' + Math.round(p.rect.left) + ',' + Math.round(p.rect.top) + ' ' + p.sig;
        });
        var pick = picks.length ? picks[0] : null;
        if (pick) {
          out.found = true;
          out.x = Math.round(pick.rect.left + pick.rect.width / 2);
          out.y = Math.round(pick.rect.top + pick.rect.height / 2);
          out.sig = pick.sig;
        }
        console.log('[zhipu-stop] streaming=' + wasStreaming + ' api=' + out.api + ' 中止=' + out.aborted +
          ' 命中=' + (out.found ? out.sig : '无') + ' 候选: ' + out.cands.join(' || '));
        return out;
      } catch (e) {
        return { found: false, error: String(e && e.message), cands: out.cands, aborted: out.aborted, api: out.api };
      }
    };
  },

  // ========== 网络拦截模式：主世界注入 hook ==========
  /**
   * 返回在主世界执行的拦截器源码（必须在页面脚本执行前注入，才能覆盖 fetch / XHR）。
   * 必须自包含：函数体只使用浏览器全局（window/document/URL/CustomEvent/TextDecoder 等）。
   * 拦截 chatglm.cn 的 assistant/stream SSE，解析回复文本并派发：
   *   window 'cuckoo-ai-stream'   { detail: { think, text, finished: false } }  实时增量
   *   window 'cuckoo-ai-response' { detail: { text, finished: true, status } }   回合完成
   */
  getHookSource() {
    return '(' + function zhipuHookInstaller() {
      var MARKER = '__cuckooZhipuHookInstalled__';
      if (window[MARKER]) return;
      window[MARKER] = true;

      function log() {
        try {
          console.log.apply(console, ['[zhipu-hook]'].concat(Array.prototype.slice.call(arguments)));
        } catch (e) { /* ignore */ }
      }

      // 回合完成事件（观察者依据 detail.finished 决定是否解析工具调用）
      function dispatch(text, tokenUsage, status) {
        try {
          window.dispatchEvent(new CustomEvent('cuckoo-ai-response', {
            detail: {
              text: text || '',
              finished: true,
              status: status || 'finished',
              tokenUsage: tokenUsage || null,
            },
          }));
        } catch (e) { /* ignore */ }
      }

      // 流式增量事件（供纯净模式实时渲染；节流 ~80ms）
      // 关键：finished=true 时必须绕过节流强制派发 —— 否则末帧（携带正文与完成标志）
      // 会被紧邻的 think 帧节流吞掉，导致 harness 思考标签停在"思考中…"、流式光标不消失。
      // （对齐内置 deepseek hook 的同名实现）
      var lastStreamAt = 0;
      function dispatchStream(think, text, finished) {
        var now = Date.now();
        if (!finished && now - lastStreamAt < 80) return;
        lastStreamAt = now;
        try {
          window.dispatchEvent(new CustomEvent('cuckoo-ai-stream', {
            detail: { think: think || '', text: text || '', finished: !!finished },
          }));
        } catch (e) { /* ignore */ }
      }

      // 是否智谱聊天流式接口（兼容 /chatglm/backend-api/assistant/stream 与 v1 变体）
      function isStreamUrl(url) {
        if (!url) return false;
        try {
          var u = new URL(url, document.baseURI);
          return /(^|\.)chatglm\.cn$/i.test(u.hostname) && /assistant\/stream/i.test(u.pathname);
        } catch (e) {
          return /assistant\/stream/i.test(String(url));
        }
      }

      // ---------- 附件上传状态（供 harness 判断"附件就绪再发送"）----------
      // 实机实证：上传走 POST /chatglm/productivity-api/file/chat_upload。
      // harness 注入文件后若立即发送，附件尚未与消息绑定 → 站点报"发送内容不能为空"。
      // 这里把上传请求的生命周期暴露到 window，由 CDP 通道轮询后决定何时发送。
      function isUploadUrl(url) {
        try {
          var u = new URL(url, document.baseURI);
          return /(^|\.)chatglm\.cn$/i.test(u.hostname) && /chat_upload|file\/upload|upload_file/i.test(u.pathname);
        } catch (e) {
          return /chat_upload/i.test(String(url));
        }
      }
      function markUpload(state, status) {
        try {
          window.__cuckooZhipuUpload__ = { at: Date.now(), state: state, status: (status == null ? null : status) };
          log('[zhipu-upload] ' + state + (status == null ? '' : ' -> ' + status));
        } catch (e) { /* ignore */ }
      }

      // ---------- 网络记录器（诊断）：记录 chatglm 各接口调用与状态 ----------
      // 用途：定位附件上传——上传请求是否发出、返回什么状态。
      // 按 "方法 路径 状态" 去重，最多 60 条，避免刷屏。
      var netSeen = {};
      function logNet(method, url, status) {
        try {
          var u = new URL(url, document.baseURI);
          if (!/(^|\.)chatglm\.cn$/i.test(u.hostname)) return;
          var key = String(method || 'GET').toUpperCase() + ' ' + u.pathname + ' -> ' + status;
          if (netSeen[key]) return;
          netSeen[key] = 1;
          if (Object.keys(netSeen).length > 60) return;
          console.log('[zhipu-net] ' + key);
        } catch (e) { /* ignore */ }
      }

      // ---------- 会话列表 API 探针 ----------
      // 智谱侧栏是 Vue SPA，会话项是 div+点击，DOM 里没有 cid（实机诊断证实）。
      // 实机实证的列表接口与响应结构（zhipu.log 2026-10-01）：
      //   GET /chatglm/mainchat-api/conversation/recent_list
      //   {"status":0,"message":"success","result":{"has_more":true,
      //     "conversation_list":[{"conversation_id":"...","title":"...","assistant_id":"..."}]}}
      // 仅认这个端点（recommendation/list 是推荐问题接口，字符串数组，不是会话）。
      var LIST_URL_RE = /mainchat-api\/conversation\/recent_list/i;
      var seenListUrls = {};
      function tapListApi(url) {
        try {
          var u = new URL(url, document.baseURI);
          if (!/(^|\.)chatglm\.cn$/i.test(u.hostname)) return null;
          if (!LIST_URL_RE.test(u.pathname)) return null;
          var key = u.pathname;
          // 记录完整 URL（含 WAF 动态参数，每次刷新取最新），供主动重放
          try { window.__cuckooZhipuListUrl__ = u.href; } catch (e) { /* ignore */ }
          if (seenListUrls[key]) return key;
          seenListUrls[key] = 1;
          console.log('[zhipu-sessions] 发现列表接口: ' + u.pathname);
          return key;
        } catch (e) { return null; }
      }
      // 列表 JSON 解析 —— 按实机实证结构（见 tapListApi 注释）精确解析，
      // 同时兼容平铺变体（顶层数组 / result 数组 / data.list 等）以防智谱改版。
      function findListArray(data, depth) {
        if (!data || depth > 3) return null;
        if (Array.isArray(data)) return data;
        if (Array.isArray(data.conversation_list)) return data.conversation_list;
        if (Array.isArray(data.list)) return data.list;
        if (Array.isArray(data.items)) return data.items;
        if (Array.isArray(data.result)) return data.result;
        if (data.data) return findListArray(data.data, depth + 1);
        if (data.result && typeof data.result === 'object') return findListArray(data.result, depth + 1);
        return null;
      }
      var dumpedStructure = {};
      // 取 XHR 响应文本：responseType=json 等场景下访问 responseText 会抛异常，改走 response
      function xhrText(xhr) {
        try {
          if (!xhr.responseType || xhr.responseType === 'text') return xhr.responseText || '';
          if (xhr.responseType === 'json') return JSON.stringify(xhr.response || '');
          return String(xhr.response || '');
        } catch (e) { return ''; }
      }
      function rememberListJson(key, text) {
        try {
          var data = JSON.parse(text);
          var arr = findListArray(data, 0);
          if (!Array.isArray(arr)) {
            // 结构未知：每种接口只 dump 一次，拿到真实结构后精修字段
            if (!dumpedStructure[key]) {
              dumpedStructure[key] = 1;
              console.log('[zhipu-sessions][' + key + '] 响应结构未识别: ' + String(text).slice(0, 1500));
            }
            return;
          }
          var sessions = [];
          for (var i = 0; i < arr.length; i++) {
            var it = arr[i] || {};
            var cid = it.conversation_id || it.conversationId || it.id || it.chat_id || it.cid || (it.conversation && it.conversation.id);
            var title = it.title || it.name || it.description || it.summary || '';
            if (!cid || !title) continue;
            sessions.push({ cid: String(cid), title: String(title).slice(0, 80), updated_at: it.update_time || it.updateTime || it.updated_at || '' });
          }
          if (!sessions.length) {
            if (!dumpedStructure[key]) {
              dumpedStructure[key] = 1;
              console.log('[zhipu-sessions][' + key + '] 数组 ' + arr.length + ' 项但无可识别字段, 首项: ' + JSON.stringify(arr[0] || {}).slice(0, 800));
            }
            return;
          }
          window.__cuckooZhipuSessions__ = { at: Date.now(), key: key, list: sessions };
          console.log('[zhipu-sessions] 列表已缓存: ' + sessions.length + ' 条 (key=' + key + ')');
        } catch (e) { /* 非 JSON 或结构不符，忽略 */ }
      }

      // ---------- SSE 帧解码 ----------
      function createFrameDecoder() {
        var buffer = '', scanFrom = 0;
        return {
          push: function (text) {
            buffer += text;
            var frames = [], re = /\r?\n\r?\n/g, offset = 0, m;
            re.lastIndex = scanFrom;
            while ((m = re.exec(buffer)) !== null) {
              frames.push(buffer.slice(offset, m.index));
              offset = m.index + m[0].length;
            }
            buffer = buffer.slice(offset);
            scanFrom = Math.max(0, buffer.length - 3);
            return frames;
          },
          finish: function () {
            var frames = [];
            if (buffer) frames.push(buffer);
            buffer = ''; scanFrom = 0;
            return frames;
          },
        };
      }

      function parseBlock(block) {
        if (!block || !block.trim()) return null;
        var data = null;
        var lines = block.split(/\r\n|\r|\n/);
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('data:') === 0) {
            var d = line.slice(5).trim();
            data = data == null ? d : data + '\n' + d;
          }
        }
        if (data == null) return null;
        try { return JSON.parse(data); } catch (e) { return null; }
      }

      // ---------- 内容分类与提取 ----------
      function lowerType(it) {
        return String((it && it.type) || '').toLowerCase();
      }
      // 思考类：think / reasoning / analysis 等
      function isThinkType(t) {
        return t.indexOf('think') !== -1 || t.indexOf('reason') !== -1 || t.indexOf('analysis') !== -1;
      }
      // 工具调用类
      function isToolType(t) {
        return t.indexOf('tool_call') !== -1 || t.indexOf('function_call') !== -1;
      }
      function pickString(it, fields) {
        for (var i = 0; i < fields.length; i++) {
          var v = it[fields[i]];
          if (typeof v === 'string' && v) return v;
        }
        return '';
      }
      // 思考文本字段（智谱实测：{ type:'think', think:'...' }）
      function thinkText(it) {
        return pickString(it, ['think', 'think_text', 'reasoning_content', 'thinking_content', 'reasoning']);
      }
      // 正文字段（宽容：text / content / value / message / answer / output）
      function bodyText(it) {
        return pickString(it, ['text', 'content', 'value', 'message', 'answer', 'output']);
      }

      // 智能累加：同时兼容"增量帧"与"全量帧"。
      // 关键：智谱实测为**增量帧**（每帧只含新片段，如 "The" / " user" / " wants"），
      // 因此默认按增量追加；仅当新片段明显是"以旧内容开头的更长全量"时才替换。
      // 判定放宽为 len(frag) > len(prev) 才可能是全量，避免把增量误判成全量而丢失内容。
      function smartAppend(prev, frag) {
        if (!frag) return prev || '';
        if (!prev) return frag;
        if (frag === prev) return prev;
        // 全量帧：新片段比旧内容更长，且以旧内容开头
        if (frag.length > prev.length && frag.indexOf(prev) === 0) return frag;
        // 重复片段（服务端重发）：忽略
        var n = frag.length;
        if (n && prev.slice(-n) === frag) return prev;
        // 其余一律视为增量片段
        return prev + frag;
      }

      // 诊断：每种 item 类型只打印一次（便于按真实帧格式继续收敛，不刷屏）
      var diagTypes = {};
      function diagItem(t, it) {
        if (diagTypes[t]) return;
        diagTypes[t] = 1;
        try { log('[diag-item] type=' + t + ' :: ' + JSON.stringify(it).slice(0, 800)); } catch (e) { /* ignore */ }
      }

      // 帧序列全量记录（诊断用）：每帧一行，含类型/长度/前 60 字，便于定位正文所在字段。
      // 上限 400 帧，避免长会话刷爆日志。
      var frameSeq = 0;
      function diagFrame(obj) {
        if (frameSeq >= 400) return;
        frameSeq++;
        try {
          var parts = obj && obj.parts;
          var desc = [];
          if (Array.isArray(parts)) {
            for (var i = 0; i < parts.length; i++) {
              var p = parts[i];
              if (!p || !Array.isArray(p.content)) continue;
              for (var j = 0; j < p.content.length; j++) {
                var it = p.content[j];
                if (!it || typeof it !== 'object') continue;
                var t = String(it.type || '?');
                var body = pickString(it, ['text', 'content', 'value', 'message', 'answer', 'output']);
                var th = pickString(it, ['think', 'think_text', 'reasoning_content', 'thinking_content', 'reasoning']);
                var show = (it.meta_data && it.meta_data.show_type) || '';
                desc.push(t + '(text:' + body.length + '/think:' + th.length + (show ? '/' + show : '') + ')');
              }
            }
          }
          var status = obj.status ? (' status=' + obj.status) : '';
          var ev = obj.event ? (' event=' + obj.event) : '';
          log('[frame#' + frameSeq + ']' + status + ev + ' parts=[' + desc.join(', ') + ']');
        } catch (e) { /* ignore */ }
      }

      // ---------- 帧处理 ----------
      /**
       * 结束信号只做标记，**不立即派发**。
       * 实机帧序列（决定性证据）：
       *   frame#22 think(294) → frame#23 tool_calls(name:finish) → frame#24~36 text 帧
       * 即智谱的 finish 是"思考结束、开始输出正文"的信号，正文在它**之后**才持续推送。
       * 若在 finish 后立即派发，后续正文帧会被 st.dispatched 丢弃 → 正文被截断。
       */
      function markFinished(st) {
        if (st.dispatched) return;
        st.finished = true;
        touchQuiet(st);   // 靠"帧静默"决定真正的结束时机
      }

      var QUIET_FINISH_MS = 2000;
      /**
       * 结束信号后的「帧静默」判定：每收到一帧就重置，连续 QUIET_FINISH_MS 无新帧才收尾。
       *
       * **必须在收到结束信号之后才启用**：模型首个 token 之前的思考延迟实机可达 1~5s
       * （历史日志 frame#1→frame#2 相隔 936ms），若无条件启用会把正常思考误判为回合结束，
       * 直接派发空回复——实机故障日志：
       *   frame#1 status=init parts=[] → 1500ms 静默 → 回合结束：正文=0 思考=0
       * 未收到结束信号时，收尾交给「流自然结束」与 15s 无数据兜底。
       */
      function touchQuiet(st) {
        if (st.dispatched || !st.finished) return;
        if (st.quietTimer) clearTimeout(st.quietTimer);
        st.quietTimer = setTimeout(function () {
          st.quietTimer = null;
          if (!st.dispatched) {
            log('结束信号后静默 ' + QUIET_FINISH_MS + 'ms，回合结束');
            finishStream(st);
          }
        }, QUIET_FINISH_MS);
      }

      function finishStream(st) {
        if (st.dispatched) return;
        if (st.quietTimer) { clearTimeout(st.quietTimer); st.quietTimer = null; }
        if (st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
        st.dispatched = true;
        var i = ACTIVE.indexOf(st);
        if (i >= 0) ACTIVE.splice(i, 1);
        if (!ACTIVE.length) { try { window.__cuckooZhipuStreaming__ = false; } catch (e) { /* ignore */ } }
        log('回合' + (st.aborted ? '中止' : '结束') + '：正文=' + (st.text || '').length + ' 思考=' + (st.think || '').length);
        // 先补一帧 finished 流式事件（绕过 80ms 节流）：
        // harness 据此收尾思考块、摘掉流式光标、恢复生成态。
        // 对齐内置 deepseek hook：完成帧必须无条件派发。
        dispatchStream(st.think, st.text, true);
        dispatch(st.text, null, st.aborted ? 'stopped' : 'finished');
      }

      /**
       * 生成中的回合状态登记表。
       * harness「暂停」→ 主进程 harness-stop → provider.getStopFn（页面主世界执行）
       * → 调用 __cuckooZhipuAbort__ → 立即收尾所有在途回合。
       * 这样即使站点停止按钮定位失败，界面也能立刻停住（服务端由点击停止按钮终止）。
       */
      var ACTIVE = [];
      function trackState(st) {
        ACTIVE.push(st);
        try { window.__cuckooZhipuStreaming__ = true; } catch (e) { /* ignore */ }
        return st;
      }
      // 供 provider.getStopFn 调用：本地中止所有在途流（不依赖 DOM）
      try {
        window.__cuckooZhipuAbort__ = function () {
          var n = 0;
          var copy = ACTIVE.slice();
          for (var i = 0; i < copy.length; i++) {
            copy[i].aborted = true;
            finishStream(copy[i]);
            n++;
          }
          log('本地中止：已收尾 ' + n + ' 个在途回合');
          return n;
        };
      } catch (e) { /* ignore */ }

      /**
       * 静默兜底：收到任意数据就重置计时器；连续 IDLE_FINISH_MS 无数据即视为回合结束。
       * 治的是"智谱侧断流/不发 finish 帧"——实机日志出现过 network error 导致
       * 正文=0 思考=12427 却迟迟不结束的情况（对齐 deepseek hook 的空闲自检思路）。
       */
      var IDLE_FINISH_MS = 15000;
      function touchIdle(st) {
        if (st.dispatched) return;
        if (st.idleTimer) clearTimeout(st.idleTimer);
        st.idleTimer = setTimeout(function () {
          st.idleTimer = null;
          if (!st.dispatched) {
            log('静默 ' + IDLE_FINISH_MS + 'ms 无数据，按回合结束处理');
            finishStream(st);
          }
        }, IDLE_FINISH_MS);
      }

      function handleFrame(block, st) {
        if (st.dispatched) return;
        var obj = parseBlock(block);
        if (!obj || typeof obj !== 'object') return;
        diagFrame(obj);   // 诊断：记录帧序列（定位正文所在字段）
        touchQuiet(st);   // 每帧都重置"帧静默"计时 —— 真正的结束时机由它决定

        // 结束信号 1：显式 finish 事件（仅标记，不派发）
        if (obj.event === 'finish') { markFinished(st); return; }

        // 结束信号 2：顶层 status 终态（仅标记，不派发）
        var status = String(obj.status || '').toLowerCase();
        if (status === 'finish' || status === 'finished' || status === 'completed' || status === 'done') {
          markFinished(st);
          // 不 return：该帧可能同时携带内容
        }

        var parts = obj.parts;
        if (!Array.isArray(parts)) return;

        var changed = false;
        var sawFinishTool = false;
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i];
          if (!p || !Array.isArray(p.content)) continue;
          for (var j = 0; j < p.content.length; j++) {
            var it = p.content[j];
            if (!it || typeof it !== 'object') continue;
            var t = lowerType(it);
            diagItem(t, it);

            // 工具调用：只关心 finish 结束信号
            if (isToolType(t)) {
              try {
                var tc = it.tool_calls || it.function_call || it;
                var nm = String((tc && tc.name) || '').toLowerCase();
                if (nm === 'finish' || nm === 'stop' || nm === 'end') sawFinishTool = true;
              } catch (e) { /* ignore */ }
              continue;
            }

            // 思考内容
            if (isThinkType(t)) {
              var tk = thinkText(it);
              if (tk) { st.think = smartAppend(st.think, tk); changed = true; }
              continue;
            }

            // 其余一律视为正文（不再硬编码 type === 'text'）
            var bt = bodyText(it);
            if (bt) { st.text = smartAppend(st.text, bt); changed = true; }
          }
        }

        if (changed) dispatchStream(st.think, st.text, false);

        // 结束信号 3：tool_calls.name === 'finish'（仅标记，正文可能仍在后面推送）
        if (sawFinishTool) markFinished(st);
      }

      // ---------- fetch 拦截 ----------
      var origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function (input, init) {
          var url = (typeof input === 'string') ? input : ((input && input.url) || '');
          // 会话列表接口：克隆响应缓存，不影响原请求
          var listKey = tapListApi(url);
          if (listKey) {
            try {
              origFetch.apply(this, arguments).then(function (resp) {
                try { return resp.clone().text(); } catch (e) { return ''; }
              }).then(function (txt) { if (txt) rememberListJson(listKey, txt); }).catch(function () {});
            } catch (e) { /* ignore */ }
          }
          if (!isStreamUrl(url)) {
            // 非流式请求：记录方法/路径/状态（诊断上传等接口），不改动原语义
            try {
              var method = (init && init.method) || (input && input.method) || 'GET';
              var isUp = isUploadUrl(url);
              if (isUp) markUpload('start');
              var pr = origFetch.apply(this, arguments);
              if (pr && typeof pr.then === 'function') {
                pr.then(function (resp) {
                  logNet(method, url, resp && resp.status);
                  if (isUp) markUpload(resp && resp.ok ? 'ok' : 'fail', resp && resp.status);
                  return resp;
                }).catch(function (e) {
                  logNet(method, url, 'ERR:' + (e && e.message));
                  if (isUp) markUpload('error');
                });
              }
              return pr;
            } catch (e) { /* 记录失败不影响原请求 */ }
            return origFetch.apply(this, arguments);
          }
          try {
            var p = origFetch.apply(this, arguments);
            p.then(function (resp) {
              try {
                if (!resp || !resp.body) return;
                var reader = resp.clone().body.getReader();
                var dec = new TextDecoder();
                var decoder = createFrameDecoder();
                var st = trackState({ text: '', think: '', finished: false, dispatched: false, aborted: false, quietTimer: null, idleTimer: null });
                touchIdle(st);
                function pump() {
                  return reader.read().then(function (r) {
                    if (r.done) {
                      var tail = decoder.finish();
                      for (var i = 0; i < tail.length; i++) {
                        try { handleFrame(tail[i], st); } catch (e) { log('handleFrame 异常: ' + (e && e.message)); }
                      }
                      finishStream(st);   // 流自然结束
                      return;
                    }
                    touchIdle(st);        // 有数据到达 → 重置静默兜底
                    var frames = decoder.push(dec.decode(r.value, { stream: true }));
                    for (var k = 0; k < frames.length; k++) {
                      // 单帧异常不得中断整条 pump 链（原版正是在这里静默断流）
                      try { handleFrame(frames[k], st); } catch (e) { log('handleFrame 异常: ' + (e && e.message)); }
                    }
                    return pump();
                  }).catch(function (err) {
                    log('流读取异常，兜底派发: ' + (err && err.message));
                    finishStream(st);
                  });
                }
                pump();
              } catch (e) { /* ignore */ }
            }).catch(function () { /* ignore */ });
            return p;
          } catch (e) { /* fallthrough */ }
          return origFetch.apply(this, arguments);
        };
      }

      // ---------- XHR 拦截（兜底，兼容旧版请求方式） ----------
      try {
        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__zhipuUrl = url;
          this.__zhipuMethod = method;
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
          var xhr = this;
          // 非流式请求：记录方法/路径/状态（诊断上传等接口）
          if (!isStreamUrl(xhr.__zhipuUrl)) {
            try {
              var isUpX = isUploadUrl(xhr.__zhipuUrl);
              if (isUpX) markUpload('start');
              xhr.addEventListener('readystatechange', function () {
                try {
                  if (xhr.readyState === 4) {
                    logNet(xhr.__zhipuMethod, xhr.__zhipuUrl, xhr.status);
                    if (isUpX) markUpload(xhr.status >= 200 && xhr.status < 300 ? 'ok' : 'fail', xhr.status);
                  }
                } catch (e) { /* ignore */ }
              });
            } catch (e) { /* ignore */ }
          }
          // 会话列表接口：readyState=4 时读响应缓存
          var listKey = tapListApi(xhr.__zhipuUrl);
          if (listKey) {
            xhr.addEventListener('readystatechange', function () {
              try {
                if (xhr.readyState === 4) {
                  var txt = xhrText(xhr);
                  if (txt) rememberListJson(listKey, txt);
                }
              } catch (e) { /* ignore */ }
            });
          }
          if (isStreamUrl(xhr.__zhipuUrl)) {
            var st = trackState({ text: '', think: '', finished: false, dispatched: false, aborted: false, quietTimer: null, idleTimer: null, offset: 0, decoder: null });
            touchIdle(st);
            xhr.addEventListener('readystatechange', function () {
              try {
                if (xhr.readyState < 3) return;
                var t = xhr.responseText || '';
                var chunk = t.slice(st.offset);
                st.offset = t.length;
                if (chunk) {
                  touchIdle(st);
                  if (!st.decoder) st.decoder = createFrameDecoder();
                  var frames = st.decoder.push(chunk);
                  for (var i = 0; i < frames.length; i++) {
                    try { handleFrame(frames[i], st); } catch (e) { log('handleFrame 异常: ' + (e && e.message)); }
                  }
                }
                if (xhr.readyState === 4) {
                  if (st.decoder) {
                    var tail = st.decoder.finish();
                    for (var k = 0; k < tail.length; k++) {
                      try { handleFrame(tail[k], st); } catch (e) { log('handleFrame 异常: ' + (e && e.message)); }
                    }
                  }
                  finishStream(st);
                }
              } catch (e) { /* ignore */ }
            });
          }
          return origSend.apply(this, arguments);
        };
      } catch (e) { /* ignore */ }

      log('已安装（拦截 assistant/stream SSE）');
    }.toString() + ')();';
  },
};

// ========== 渲染进程自注入（兜底） ==========
// bridge/entry.ts 会对 useIntercept 的 provider 调用 getHookSource() 注入；
// 此处再自行注入一次作为兜底（hook 内有 MARKER 防重，不会重复安装）。
(function () {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return; // 主进程/校验环境
    if (typeof require !== 'function') return;
    var electron = require('electron');
    if (!electron || !electron.webFrame || typeof electron.webFrame.executeJavaScript !== 'function') return;
    electron.webFrame.executeJavaScript(module.exports.getHookSource())
      .then(function () {
        console.log('[Cuckoo Code] 智谱：主世界拦截器已自行注入');
      })
      .catch(function (err) {
        console.error('[Cuckoo Code] 智谱：主世界拦截器注入失败', err && err.message);
      });
  } catch (e) { /* 非 preload 环境静默跳过 */ }
})();
