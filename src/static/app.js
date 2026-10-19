/* ============================================================
   AkiBurger Voice · 合成台 前端逻辑
   后端接口约定（详见 README）：
     GET  /api/health     -> {"status":"ok","engine_up":bool}
     GET  /api/voices     -> [{"name","path","char"}]
     POST /api/synthesize {"text","lang","voice","tone"}
                          -> {"ok":true,"audio_url","segments","elapsed_ms","text","lang","tone","created_at"}
     GET  /api/history    -> [同上若干条]
     POST /api/tone       {"text"} -> {"tone","confidence"}   （可选接口，没有就走本地规则）
   ============================================================ */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // 图标统一走 index.html 里的 SVG symbol，避免在 JS 里写字符图标
  function iconHtml(name, cls) {
    return '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  function setIcon(el, name) {
    if (el) el.innerHTML = iconHtml(name);
  }


  // ---------- 状态 ----------
  const state = {
    lang: 'ja',               // 输出语言
    inputLang: 'zh',          // 我输入的语言（默认中文：中文进、日文出）
    tone: 'auto',
    voices: [],
    currentAudioUrl: null,
    engineUp: false,
    currentAudio: null,       // 当前正在播放的音频（全局只响一个）
    abResults: [],            // 最近两次合成结果（A/B 对比）
    qcFilter: 'all',
    annFilter: 'all',
    datasetSnapshot: '',      // 上次的数据指纹，变了就清空质检/标注结果
    currentHistoryUrl: null,
    temperature: 0.9,         // 音质微调：越低越稳
    seed: -1,                 // -1 = 每次随机
    inFlight: false,          // 合成请求进行中（防重复点击 / Ctrl+Enter / 换种子重合成）
  };

  // ---------- 元素 ----------
  const els = {
    voiceSelect: $('voiceSelect'),
    engineBadge: $('engineBadge'),
    engineDown: $('engineDown'),
    engineDownDesc: $('engineDownDesc'),
    retryBtn: $('retryBtn'),
    previewBtn: $('previewBtn'),
    renameModelBtn: $('renameModelBtn'),
    langBtns: [...document.querySelectorAll('.lang-btn')],
    inLangBtns: [...document.querySelectorAll('.in-lang-btn')],
    langNote: $('langNote'),
    translatedBox: $('translatedBox'),
    translatedText: $('translatedText'),
    textInput: $('textInput'),
    charCount: $('charCount'),
    durationEst: $('durationEst'),
    clearBtn: $('clearBtn'),
    toneDetected: $('toneDetected'),
    toneDetectedName: $('toneDetectedName'),
    toneDetectedConf: $('toneDetectedConf'),
    toneBtns: [...document.querySelectorAll('.tone-btn')],
    synthBtn: $('synthBtn'),
    synthProgress: $('synthProgress'),
    progressText: $('progressText'),
    resultSection: $('resultSection'),
    resultAudio: $('resultAudio'),
    resultMeta: $('resultMeta'),
    downloadLink: $('downloadLink'),
    retrySynthBtn: $('retrySynthBtn'),
    errorBox: $('errorBox'),
    errorTitle: $('errorTitle'),
    errorDesc: $('errorDesc'),
    historyList: $('historyList'),
    historyEmpty: $('historyEmpty'),
    clearHistoryBtn: $('clearHistoryBtn'),
    footEngine: $('footEngine'),
    savePresetBtn: $('savePresetBtn'),
    presetList: $('presetList'),
    presetEmpty: $('presetEmpty'),
    batchToggleBtn: $('batchToggleBtn'),
    batchPanel: $('batchPanel'),
    batchInput: $('batchInput'),
    batchCount: $('batchCount'),
    batchDefaultTone: $('batchDefaultTone'),
    batchStartBtn: $('batchStartBtn'),
    batchStopBtn: $('batchStopBtn'),
    batchResults: $('batchResults'),
    // 音质微调
    advToggleBtn: $('advToggleBtn'),
    advPanel: $('advPanel'),
    tempRange: $('tempRange'),
    tempValue: $('tempValue'),
    seedInput: $('seedInput'),
    rerollBtn: $('rerollBtn'),
    // 训练
    trainBadge: $('trainBadge'),
    trainData: $('trainData'),
    fromScratch: $('fromScratch'),
    epochsS2: $('epochsS2'),
    epochsS1: $('epochsS1'),
    trainStartBtn: $('trainStartBtn'),
    trainStopBtn: $('trainStopBtn'),
    trainProgress: $('trainProgress'),
    trainStage: $('trainStage'),
    trainBar: $('trainBar'),
    trainMeta: $('trainMeta'),
    trainLog: $('trainLog'),
    batchS2: $('batchS2'),
    batchS1: $('batchS1'),
    // 训练素材
    sourcePath: $('sourcePath'),
    scanBtn: $('scanBtn'),
    scanResult: $('scanResult'),
    importBtn: $('importBtn'),
    prepareBtn: $('prepareBtn'),
    dataBadge: $('dataBadge'),
    dataJob: $('dataJob'),
    dataJobStage: $('dataJobStage'),
    dataJobBar: $('dataJobBar'),
    dataJobLog: $('dataJobLog'),
    // 素材页
    browseBtn: $('browseBtn'),
    browseHint: $('browseHint'),
    materialStats: $('materialStats'),
    materialSearch: $('materialSearch'),
    materialCount: $('materialCount'),
    materialList: $('materialList'),
    materialRefreshBtn: $('materialRefreshBtn'),
    materialClearBtn: $('materialClearBtn'),
    materialRestoreBtn: $('materialRestoreBtn'),
    // 质检页
    qcRunBtn: $('qcRunBtn'),
    qcClearBtn: $('qcClearBtn'),
    qcSummary: $('qcSummary'),
    qcFilter: $('qcFilter'),
    qcList: $('qcList'),
    // 标注页
    annStats: $('annStats'),
    annList: $('annList'),
    annFilter: $('annFilter'),
    annRefreshBtn: $('annRefreshBtn'),
    annClearBtn: $('annClearBtn'),
    // 训练高级参数
    saveEveryS2: $('saveEveryS2'),
    saveEveryS1: $('saveEveryS1'),
    lrS2: $('lrS2'),
    lrS1: $('lrS1'),
    autoEval: $('autoEval'),
    // 评测对象
    evalTarget: $('evalTarget'),
    evalConclusion: $('evalConclusion'),
    evalFilter: document.getElementById('evalFilter'),
    // 评测
    evalBtn: $('evalBtn'),
    evalProgress: $('evalProgress'),
    evalProgressText: $('evalProgressText'),
    evalResult: $('evalResult'),
    evalScore: $('evalScore'),
    evalLevel: $('evalLevel'),
    evalModel: $('evalModel'),
    evalLangs: $('evalLangs'),
    evalDetails: $('evalDetails'),
    evalHistory: $('evalHistory'),
    evalHistoryEmpty: $('evalHistoryEmpty'),
  };

  // ---------- 页面切换（左侧导航）----------
  const VIEW_NAMES = ['synth', 'train', 'eval', 'material', 'qc', 'annotation'];
  const VIEW_TITLES = {
    synth: '语音合成', train: '训练模型', eval: '评测打分',
    material: '素材', qc: '质检', annotation: '标注',
  };

  function navButtons() {
    return document.querySelectorAll('.side-nav-item[data-view], .flow-step[data-view]');
  }

  function switchView(name) {
    if (!VIEW_NAMES.includes(name)) name = 'synth';
    state.view = name;
    hideError();
    VIEW_NAMES.forEach((v) => {
      const el = document.getElementById('view-' + v);
      if (el) el.classList.toggle('hidden', v !== name);
    });
    navButtons().forEach((b) => {
      const on = b.dataset.view === name;
      b.classList.toggle('current', on);
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    // 顶栏页面标题
    const title = VIEW_TITLES[name] || '语音合成';
    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle) pageTitle.textContent = title;
    try {
      history.replaceState(null, '', '#' + name);
    } catch (e) {
      /* file:// 下可能不支持，忽略 */
    }
    if (name === 'train') {
      loadTrainData();
      refreshTrainStatus();
      updateDataStatus();
      resumeDataJob();
    }
    if (name === 'material') { loadMaterials(); updateDataStatus(); resumeDataJob(); }
    if (name === 'qc') { loadQcReport(); }
    if (name === 'annotation') { loadAnnotations(); }
    if (name === 'eval') {
      loadEvalTarget();
      loadEvalHistory();
    }
    try { document.title = title + ' · AkiBurger Voice'; } catch (e) { /* 忽略 */ }
    // 内容区滚动复位（新布局里滚动容器是 #contentScroll，不再是 window）
    const scrollBox = document.getElementById('contentScroll');
    try {
      if (scrollBox) scrollBox.scrollTo({ top: 0, behavior: 'smooth' });
      else window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (scrollBox) scrollBox.scrollTop = 0; else window.scrollTo(0, 0);
    }
  }

  // ---------- 工具 ----------
  async function api(path, options) {
    const res = await fetch(path, options);
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try {
        const body = await res.json();
        if (body && (body.message || body.detail)) {
          if (typeof body.detail === 'string') {
            msg = body.detail;
          } else if (Array.isArray(body.detail) && body.detail.length) {
            // FastAPI 422：detail 是数组，取第一条的 msg（比 "HTTP 422" 有用）
            const first = body.detail[0] || {};
            msg = String(first.msg || body.message || msg);
            const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : '';
            if (field && msg.indexOf(String(field)) < 0) msg = field + '：' + msg;
          } else {
            msg = body.message || msg;
          }
        }
      } catch (e) { /* 非 JSON 响应 */ }
      throw new Error(msg);
    }
    return res.json();
  }

  // 下载文件名用的时间戳：voice_20261018_2150.wav
  function downloadStamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  // 引擎未就绪提示：区分「后端连不上」和「后端在、引擎没起来」
  function renderEngineNotice(kind) {
    if (!els.engineDownDesc || !kind) return;
    let desc = '';
    if (kind === 'backend') {
      // fetch 本身失败 = 后端服务不可达
      desc = '界面已经打开了，但后端服务没连上。<br>' +
        '试试：先启动后端的 <code>app.py</code>（负责把请求转给声音引擎），再点下面的按钮重连。';
    } else if (kind === 'engine') {
      // 后端活着，但 /api/health 返回 engine_up=false
      desc = '后端服务已经连上了，但声音引擎还没就绪（可能还在加载模型）。<br>' +
        '等几秒再点下面的按钮重连；一直不行就看后端窗口的报错。';
    } else {
      // 后端有响应，但健康检查本身失败了
      desc = '后端有响应，但健康检查失败了。<br>看看后端窗口的报错，然后点下面的按钮重连。';
    }
    els.engineDownDesc.innerHTML =
      desc + ' <button type="button" class="linklike" id="retryBtn2">重试连接</button>';
    const btn = els.engineDownDesc.querySelector('#retryBtn2');
    if (btn) btn.addEventListener('click', boot);
  }

  // kind：'backend' = fetch 失败（后端不可达）；'engine' = 后端在但 engine_up=false；'http' = 健康检查报错
  // 顶栏/侧栏状态文字：保留图标，只换文字
  function setWithIconText(el, text) {
    if (!el) return;
    const inner = el.querySelector(':scope > span');
    if (inner) { inner.textContent = text; return; }
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3 && String(n.nodeValue).trim()) { n.nodeValue = text; return; }
    }
    el.appendChild(document.createTextNode(text));
  }

  function updateModelBadges() {
    const sel = els.voiceSelect;
    const opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    let name = opt ? String(opt.textContent || '').trim() : '';
    if (!name || name === '加载中…' || name === '暂无可用音色' || name === '未命名') name = '—';
    const top = document.getElementById('topModelBadge');
    const side = document.getElementById('sideModelName');
    if (top) setWithIconText(top, '模型 ' + name);
    if (side) side.textContent = name;
  }

  function updateTranslatorBadge(up) {
    const top = document.getElementById('translatorBadge');
    const side = document.getElementById('sideTranslator');
    if (top) setWithIconText(top, '翻译 ' + (up ? '可用' : '未连接'));
    if (side) setWithIconText(side, '翻译引擎 ' + (up ? '可用' : '未连接'));
  }

  function setEngineUp(up, kind) {
    state.engineUp = up;
    els.engineBadge.textContent = up ? '引擎就绪' : '引擎未就绪';
    els.engineBadge.className = 'badge ' + (up ? 'badge-ok' : 'badge-danger');
    els.footEngine.textContent = up ? '引擎在线' : '引擎未连接';
    els.engineDown.classList.toggle('hidden', up);
    if (!up && kind) renderEngineNotice(kind);
    els.synthBtn.disabled = !up;
    els.batchToggleBtn.disabled = !up;
    els.previewBtn.disabled = !up;
    if (els.evalBtn) els.evalBtn.disabled = !up;
  }

  // ---------- 启动流程：体检 -> 音色 -> 历史 ----------
  async function boot() {
    setEngineUp(false, null);
    try {
      const h = await api('/api/health');
      const up = Boolean(h && h.engine_up);
      setEngineUp(up, up ? null : 'engine');
      updateTranslatorBadge(Boolean(h && h.translator_up));
      // 历史不依赖引擎：引擎没就绪时也把上次的合成记录列出来
      await loadHistory();
      if (up) {
        await Promise.all([loadVoices(), loadEvalHistory()]);
      }
      // 训练面板不依赖引擎状态，始终加载
      loadTrainData();
      refreshTrainStatus();
    } catch (e) {
      // fetch 失败（后端没起 / file:// 打开）和 HTTP 错误分开提示
      const httpErr = /^HTTP \d+/.test(String((e && e.message) || e));
      setEngineUp(false, httpErr ? 'http' : 'backend');
    }
  }

  async function loadVoices() {
    try {
      const resp = await api('/api/voices');
      // 后端返回 {"voices": [...]}，兼容纯数组
      const list = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.voices) ? resp.voices : []);
      state.voices = list;
      els.voiceSelect.innerHTML = '';
      if (state.voices.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '暂无可用音色';
        els.voiceSelect.appendChild(opt);
        els.voiceSelect.disabled = true;
        return;
      }
      for (const v of state.voices) {
        const opt = document.createElement('option');
        // 模型条目用模型 id 作为 value（后端据此切换权重）；零样本才用参考音频路径
        opt.value = v.char === 'model' ? (v.name || v.path || '') : (v.path || v.name || '');
        opt.textContent = v.display || v.label || v.name || '未命名';
        if (v.file) opt.dataset.file = v.file;
        els.voiceSelect.appendChild(opt);
      }
      els.voiceSelect.disabled = false;
      if (els.renameModelBtn) els.renameModelBtn.disabled = false;
      updateModelBadges();
      // 记忆上次选择（localStorage 不可用时静默跳过，不能因此把音色列表判成加载失败）
      let last = '';
      try { last = localStorage.getItem('abv:voice') || ''; } catch (e) { last = ''; }
      if (last && state.voices.some((v) => (v.path || v.name || v.display) === last || (v.char === 'model' && v.name === last))) {
        els.voiceSelect.value = last;
      }
    } catch (e) {
      // 音色接口失败不致命，保留"加载中"并提示
      els.voiceSelect.innerHTML = '<option value="">加载失败，点合成时请检查后端</option>';
    }
  }

  async function loadHistory() {
    try {
      const resp = await api('/api/history');
      // 后端返回 {"history": [...]}，兼容纯数组
      const list = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.history) ? resp.history : []);
      renderHistory(list);
    } catch (e) {
      renderHistory([]);
    }
  }

  // ---------- 语言 ----------
  function setLang(lang) {
    state.lang = lang;
    els.langBtns.forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
    updateLangNote();
  }

  function setInputLang(lang) {
    state.inputLang = lang;
    els.inLangBtns.forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
    updateLangNote();
  }

  function updateLangNote() {
    if (!els.langNote) return;
    const names = { zh: '中文', ja: '日文', en: '英文' };
    if (state.inputLang === state.lang) {
      els.langNote.textContent = `输入和输出都是${names[state.lang]}，直接合成不翻译。`;
    } else {
      els.langNote.textContent =
        `输入${names[state.inputLang]} → 先用本地模型翻译成${names[state.lang]}，再用训练好的声音读出来。`;
    }
  }

  // ---------- 字数与时长估算 ----------
  function updateMeta() {
    const text = els.textInput.value;
    const chars = [...text].length; // 按 Unicode 字符数（中日文友好）
    els.charCount.textContent = chars + ' 字';
    const sec = Math.max(1, Math.round(chars / 5)); // 每秒约 5 字粗估
    els.durationEst.textContent = '预计约 ' + sec + ' 秒';
  }

  // ---------- 语气 ----------
  function setTone(tone) {
    state.tone = tone;
    els.toneBtns.forEach((b) => b.classList.toggle('active', b.dataset.tone === tone));
    // 手选后，自动判断横幅只作参考展示，不再强制同步
    // 兼容中文语气值：按钮上是中文名，后端 tone 传中文；'auto' 是自动判断的哨兵值
    if (tone === 'auto') state.tone = 'auto';
  }

  // 本地关键词兜底（后端 /api/tone 不可用时）
  const TONE_RULES = [
    { tone: '生气', re: /(可恶|混蛋|该死|闭嘴|滚|气死|愤怒|怒|ばか|馬鹿|くそ|黙れ|怒)/i },
    { tone: '悲伤', re: /(哭|难过|悲伤|伤心|对不起|抱歉|别走|再见|失去|泣|悲し|さよなら|ごめん)/i },
    { tone: '开心', re: /(哈哈|开心|高兴|太好了|真棒|喜欢|爱你|耶|楽しい|嬉しい|すごい|やった)/i },
    { tone: '惊讶', re: /(什么|竟然|天啊|居然|不会吧|真的假的|嘘|まさか|ええ|本当)/i },
    { tone: '害怕', re: /(害怕|恐怖|吓|不要过来|救命|怖い|助けて|やめて)/i },
  ];

  function guessToneLocal(text) {
    for (const r of TONE_RULES) {
      if (r.re.test(text)) return { tone: r.tone, confidence: '一般' };
    }
    return { tone: '平静', confidence: '一般' };
  }

  async function detectTone() {
    const text = els.textInput.value.trim();
    if (!text) {
      els.toneDetected.hidden = true;
      return;
    }
    try {
      const res = await api('/api/tone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res && res.tone) {
        els.toneDetected.hidden = false;
        els.toneDetectedName.textContent = res.tone;
        els.toneDetectedConf.textContent = '置信度 ' + (res.confidence || '一般');
        // 保留 auto 状态：只展示建议，真正判断交给后端合成时做
        return;
      }
      throw new Error('no tone');
    } catch (e) {
      const g = guessToneLocal(text);
      els.toneDetected.hidden = false;
      els.toneDetectedName.textContent = g.tone;
      els.toneDetectedConf.textContent = '置信度 ' + g.confidence + '（本地规则）';
      // 本地规则也只做展示，不改状态
    }
  }

  // ---------- 合成 ----------
  async function synthesize() {
    // 防重复：正在合成时再触发（连点 / Ctrl+Enter / 换种子）直接忽略
    if (state.inFlight) {
      showToast('正在合成中，请稍等…');
      return;
    }
    const text = els.textInput.value.trim();
    if (!text) {
      showError('还没输入台词', '在文本框里写点东西，再点合成。');
      els.textInput.focus();
      return;
    }
    const voice = els.voiceSelect.value;
    if (!voice) {
      showError('还没选音色', '声音引擎没有可用音色。等引擎就绪后，在下拉框里选一个。');
      return;
    }

    hideError();
    state.inFlight = true;
    els.synthBtn.disabled = true;
    els.synthBtn.querySelector('.btn-label').textContent = '合成中…';
    els.synthProgress.classList.remove('hidden');
    const translating = state.inputLang !== state.lang;
    els.progressText.textContent = translating
      ? '正在翻译并合成…'
      : '正在合成「' + text.slice(0, 20) + (text.length > 20 ? '…' : '') + '」';
    const t0 = performance.now();

    try {
      const res = await api('/api/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text, lang: state.lang, input_lang: state.inputLang, voice, tone: state.tone,
          seed: state.seed, temperature: state.temperature,
        }),
      });
      const elapsed = Math.round(performance.now() - t0);
      if (!res || !res.ok || !res.audio_url) throw new Error(res && res.message ? res.message : '后端没有返回音频');

      // 显示翻译结果（跨语言时），让用户能核对
      if (els.translatedBox && els.translatedText) {
        if (res.translated && res.translated_text) {
          els.translatedText.textContent = res.translated_text;
          els.translatedBox.hidden = false;
        } else {
          els.translatedBox.hidden = true;
        }
      }

      // 随机模式下，把这次实际用的种子显示出来，方便复现
      const seedUsed = res.seed_used !== undefined ? res.seed_used : res.seed;
      if (els.seedInput && seedUsed !== undefined && seedUsed !== -1) {
        els.seedInput.value = seedUsed;
      }

      state.currentAudioUrl = res.audio_url;
      els.resultAudio.src = res.audio_url;
      pushABResult(res.audio_url);      // 记录最近两次结果，供 A/B 对比
      loadWaveform(res.audio_url);      // 绘制波形
      els.downloadLink.href = res.audio_url;
      // 下载文件名带时间戳，避免每次都叫 full.wav
      els.downloadLink.download = 'voice_' + downloadStamp(new Date()) + '.wav';
      els.resultSection.classList.remove('hidden');

      const segs = Array.isArray(res.segments) ? res.segments.length : 0;
      els.resultMeta.textContent =
        (res.lang ? res.lang.toUpperCase() + ' · ' : '') +
        (res.tone ? res.tone + ' · ' : '') +
        (segs > 1 ? '文本分 ' + segs + ' 段 · ' : '') +
        '耗时 ' + (res.elapsed_ms != null ? (res.elapsed_ms / 1000).toFixed(1) : (elapsed / 1000).toFixed(1)) + ' 秒';

      loadHistory(); // 刷新历史
      // 新结果自动播放前，先停掉其它正在响的（历史/批量/试听），避免同时出声
      stopAll(els.resultAudio);
      setTimeout(() => els.resultAudio.play().catch(() => {}), 100);
    } catch (e) {
      showError('合成失败', String(e.message || e));
    } finally {
      state.inFlight = false;
      els.synthBtn.disabled = !state.engineUp;
      els.synthBtn.querySelector('.btn-label').textContent = '合成';
      els.synthProgress.classList.add('hidden');
    }
  }

  // ---------- 统一播放：任何时候只响一个 ----------
  // 历史行的高亮和播放图标，在别处播放时也要复位
  function clearHistoryPlaying() {
    if (!els.historyList) return;
    els.historyList.querySelectorAll('.history-item.playing').forEach((n) => {
      n.classList.remove('playing');
      const p = n.querySelector('.history-play');
      if (p) setIcon(p, 'play');
    });
  }

  // 停掉所有正在响的音频：动态 Audio（素材/质检/标注/评测/试听/历史）、
  // 结果播放器 #resultAudio、批量合成里的 <audio>
  // exclude：本次即将播放的元素，不停它（否则会把自己也按停）
  function stopAll(exclude) {
    if (state.currentAudio && state.currentAudio !== exclude) {
      try { state.currentAudio.pause(); } catch (e) { /* 忽略 */ }
      state.currentAudio = null;
    }
    if (els.resultAudio && els.resultAudio !== exclude) {
      try { els.resultAudio.pause(); } catch (e) { /* 忽略 */ }
    }
    document.querySelectorAll('#batchResults audio').forEach((a) => {
      if (a !== exclude) {
        try { a.pause(); } catch (e) { /* 忽略 */ }
      }
    });
    clearHistoryPlaying();
  }

  function playAudio(url) {
    if (!url) return;
    stopAll();
    const a = new Audio(url);
    state.currentAudio = a;
    a.addEventListener('ended', () => {
      if (state.currentAudio === a) state.currentAudio = null;
    });
    a.play().catch(() => {});
  }

  // ---------- 波形显示（结果区 #waveCanvas）----------
  let wavePeaks = null;
  let waveUrl = null;

  function cssColor(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  async function loadWaveform(url) {
    const canvas = document.getElementById('waveCanvas');
    if (!canvas || !url) return;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const audio = await ctx.decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      const bars = 180;
      const step = Math.max(1, Math.floor(ch.length / bars));
      const peaks = [];
      for (let i = 0; i < bars; i++) {
        let max = 0;
        const base = i * step;
        for (let j = 0; j < step; j++) {
          const v = Math.abs(ch[base + j] || 0);
          if (v > max) max = v;
        }
        peaks.push(max);
      }
      wavePeaks = peaks;
      waveUrl = url;
      if (ctx.close) ctx.close();
      drawWaveform(0);
    } catch (e) {
      // 波形是增强功能，失败静默
      wavePeaks = null;
      const canvas2 = document.getElementById('waveCanvas');
      if (canvas2) {
        const c2 = canvas2.getContext('2d');
        c2.clearRect(0, 0, canvas2.width, canvas2.height);
      }
    }
  }

  function drawWaveform(progress) {
    const canvas = document.getElementById('waveCanvas');
    if (!canvas || !wavePeaks) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 800;
    const cssH = canvas.clientHeight || 72;
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const cBase = cssColor('--primary', '#6366F1');
    const cPlayed = cssColor('--accent', '#F97316');
    const n = wavePeaks.length;
    const slot = cssW / n;
    const bw = Math.max(1.5, slot * 0.62);
    const mid = cssH / 2;
    for (let i = 0; i < n; i++) {
      const h = Math.max(2, wavePeaks[i] * cssH * 0.86);
      const x = i * slot + (slot - bw) / 2;
      ctx.fillStyle = (x / cssW) <= progress ? cPlayed : cBase;
      ctx.fillRect(x, mid - h / 2, bw, h);
    }
  }

  // ---------- A/B 对比（最近两次合成）----------
  function pushABResult(url) {
    if (!url) return;
    if (!Array.isArray(state.abResults)) state.abResults = [];
    const arr = state.abResults;
    if (arr[arr.length - 1] === url) return;
    arr.push(url);
    while (arr.length > 2) arr.shift();
    renderAB();
  }

  function renderAB() {
    const box = document.getElementById('abCompare');
    if (!box) return;
    const arr = Array.isArray(state.abResults) ? state.abResults : [];
    box.classList.toggle('hidden', arr.length < 2);
    const hint = document.getElementById('abHint');
    if (hint) hint.textContent = arr.length >= 2 ? '对比最近两次合成' : '';
    const a1 = document.getElementById('abAaBtn');
    const b1 = document.getElementById('abBbBtn');
    if (a1) a1.disabled = arr.length < 2;
    if (b1) b1.disabled = arr.length < 2;
  }

  function playAB(which) {
    const arr = Array.isArray(state.abResults) ? state.abResults : [];
    const url = which === 'A' ? arr[0] : arr[1];
    if (!url) return;
    playAudio(url);
    const hint = document.getElementById('abHint');
    if (hint) hint.textContent = '正在播放：' + which;
  }

  // ---------- 素材页 ----------
  function audioPlay(url) {
    playAudio(url);
  }

  let materialFiles = [];

  async function loadMaterials() {
    if (!els.materialStats) return;
    try {
      const d = await api('/api/material/list');
      materialFiles = d.files || [];
      els.materialStats.textContent =
        d.count > 0 ? `已导入 ${d.count} 段 · 总时长约 ${d.total_min} 分钟` : '还没有导入任何素材';
      renderMaterialList();
    } catch (e) {
      els.materialStats.textContent = '读取失败：' + (e.message || e);
    }
  }

  function renderMaterialList() {
    const query = ((els.materialSearch && els.materialSearch.value) || '').trim().toLowerCase();
    const files = query
      ? materialFiles.filter((f) => f.name.toLowerCase().includes(query))
      : materialFiles;
    els.materialList.innerHTML = '';
    if (els.materialCount) {
      els.materialCount.textContent = query
        ? `匹配 ${files.length} / 共 ${materialFiles.length} 段`
        : `共 ${materialFiles.length} 段`;
    }
    if (!files.length) {
      const empty = document.createElement('div');
      empty.className = 'eval-detail-empty';
      empty.textContent = query ? '没有匹配的文件名' : '还没有导入任何素材';
      els.materialList.appendChild(empty);
      return;
    }
    for (const f of files) {
        const row = document.createElement('div');
        row.className = 'material-row';
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'history-play';
        play.setAttribute('aria-label', '播放');
        setIcon(play, 'play');
        play.addEventListener('click', () => audioPlay('/api/material/audio?name=' + encodeURIComponent(f.name)));
        const name = document.createElement('span');
        name.className = 'material-name';
        name.textContent = f.name;
        const dur = document.createElement('span');
        dur.className = 'material-dur';
        dur.textContent = f.duration != null ? f.duration + 's' : '—';
        const del = document.createElement('button');
        del.className = 'btn-danger-link';
        del.textContent = '删除';
        del.addEventListener('click', () => deleteMaterial(f.name));
      row.append(play, name, dur, del);
      els.materialList.appendChild(row);
    }
  }

  async function deleteMaterial(name) {
    if (!window.confirm('删除这段素材？会移到回收站，可以点「↩ 恢复删除」找回。')) return;
    try {
      await api('/api/material/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      loadMaterials();
      updateDataStatus();
    } catch (e) {
      showError('删除失败', String(e.message || e));
    }
  }

  async function clearMaterials() {
    if (!window.confirm('清空所有已导入素材？\n素材会移到回收站（不是真删），之后可以点「↩ 恢复删除」找回。')) return;
    try {
      await api('/api/material/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      loadMaterials();
      updateDataStatus();
    } catch (e) {
      showError('清空失败', String(e.message || e));
    }
  }

  async function restoreMaterials() {
    try {
      const res = await api('/api/material/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch: '' }),
      });
      const extra = res.skipped ? `，跳过 ${res.skipped} 段（同名文件已存在）` : '';
      showToast('已恢复 ' + res.restored + ' 段素材' + extra);
      loadMaterials();
      updateDataStatus();
    } catch (e) {
      showError('恢复失败', String(e.message || e));
    }
  }

  // ---------- 质检页 ----------
  let qcLastReport = null;

  async function runQc() {
    els.qcRunBtn.disabled = true;
    els.qcSummary.textContent = '正在检查，请稍等…';
    try {
      const res = await api('/api/qc/run', { method: 'POST' });
      renderQcReport(res.report);
    } catch (e) {
      els.qcSummary.textContent = '检查失败：' + (e.message || e);
    } finally {
      els.qcRunBtn.disabled = false;
    }
  }

  async function loadQcReport() {
    try {
      const r = await api('/api/qc/report');
      if (r && r.summary) renderQcReport(r);
    } catch (e) {
      /* 没有报告就忽略 */
    }
  }

  function renderQcReport(r) {
    qcLastReport = r;
    const s = r.summary || {};
    els.qcSummary.textContent =
      `共 ${s.total || 0} 段：通过 ${s.pass || 0} · 警告 ${s.warn || 0} · 不合格 ${s.fail || 0}` +
      (r.duplicate_texts ? ` · 重复文本 ${r.duplicate_texts} 句` : '');
    if (els.qcFilter) els.qcFilter.hidden = false;
    renderQcList(state.qcFilter || 'all');
  }

  function renderQcList(filter) {
    if (!els.qcList) return;
    els.qcList.innerHTML = '';
    const items = ((qcLastReport && qcLastReport.items) || []).filter((it) =>
      filter === 'all' ? true : it.level === filter
    );
    if (els.qcFilter) {
      els.qcFilter.querySelectorAll('.filter-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.filter === filter);
      });
    }
    if (!items.length) {
      const ok = document.createElement('div');
      ok.className = 'eval-detail-empty';
      ok.textContent = filter === 'all' ? '很好：没有发现问题样本。' : '这一档没有样本。';
      els.qcList.appendChild(ok);
      return;
    }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'qc-row';
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'history-play';
      play.setAttribute('aria-label', '播放');
      setIcon(play, 'play');
      play.addEventListener('click', () => audioPlay('/api/material/audio?name=' + encodeURIComponent(it.name)));
      const lv = document.createElement('span');
      lv.className = 'lv-chip ' + (it.level === 'fail' ? 'lv-bad' : it.level === 'pass' ? 'lv-ok' : 'lv-mid');
      lv.textContent = it.level === 'fail' ? '不合格' : it.level === 'pass' ? '通过' : '警告';
      const name = document.createElement('span');
      name.className = 'qc-name';
      name.textContent = it.name;
      const reason = document.createElement('span');
      reason.className = 'qc-reason';
      reason.textContent = (it.reasons || []).join('；') || '—';
      row.append(play, lv, name, reason);
      els.qcList.appendChild(row);
    }
  }

  // ---------- 标注页 ----------
  let annLastData = null;

  async function loadAnnotations() {
    if (!els.annStats) return;
    try {
      const d = await api('/api/annotation/list');
      annLastData = d;
      const st = d.stats || {};
      els.annStats.textContent =
        `共 ${d.count} 条标注` +
        (st.empty ? ` · 缺文本 ${st.empty}` : '') +
        (st.short ? ` · 过短 ${st.short}` : '') +
        (st.long ? ` · 过长 ${st.long}` : '') +
        (st.missing_audio ? ` · 音频缺失 ${st.missing_audio}` : '');
      if (els.annFilter) els.annFilter.hidden = false;
      renderAnnotations(state.annFilter || 'all');
    } catch (e) {
      els.annStats.textContent = '读取失败：' + (e.message || e);
    }
  }

  function renderAnnotations(filter) {
    if (!els.annList || !annLastData) return;
    els.annList.innerHTML = '';
    if (els.annFilter) {
      els.annFilter.querySelectorAll('.filter-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.filter === filter);
      });
    }
    let entries = annLastData.entries || [];
    if (filter === 'short') entries = entries.filter((e) => e.text_len > 0 && e.text_len < 4);
    if (filter === 'long') entries = entries.filter((e) => e.text_len > 60);
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'eval-detail-empty';
      empty.textContent = '没有符合条件的条目。';
      els.annList.appendChild(empty);
      return;
    }
    for (const e of entries) {
      const row = document.createElement('div');
      row.className = 'ann-row';
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'history-play';
      play.setAttribute('aria-label', '播放');
      setIcon(play, 'play');
      play.addEventListener('click', () => audioPlay('/api/material/audio?name=' + encodeURIComponent(e.name)));
      const meta = document.createElement('div');
      meta.className = 'ann-meta';
      meta.textContent = e.name + (e.duration != null ? ` · ${e.duration}s` : '');
      const input = document.createElement('input');
      input.className = 'ann-input';
      input.type = 'text';
      input.value = e.text || '';
      const save = document.createElement('button');
      save.className = 'btn-secondary btn-sm';
      save.textContent = '保存';
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await api('/api/annotation/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wav: e.wav, text: input.value }),
          });
          save.textContent = '已保存';
          setTimeout(() => { save.textContent = '保存'; save.disabled = false; }, 1200);
          loadAnnotations();
        } catch (err) {
          showError('保存失败', String(err.message || err));
          save.disabled = false;
        }
      });
      row.append(play, meta, input, save);
      els.annList.appendChild(row);
    }
  }

  // ---------- 训练素材（提交音频）----------
  let dataJobTimer = null;

  async function updateDataStatus() {
    try {
      const d = await api('/api/data/status');
      const ready = d.clean_count > 0;
      state.dataReady = ready;
      if (els.dataBadge) {
        els.dataBadge.textContent = ready ? `就绪 ${d.clean_count} 条` : (d.wav_count > 0 ? `仅导入 ${d.wav_count} 段` : '未导入');
        els.dataBadge.className = 'badge ' + (ready ? 'badge-ok' : 'badge-warn');
      }
      if (els.prepareBtn) els.prepareBtn.disabled = d.wav_count === 0;
      if (els.trainStartBtn) els.trainStartBtn.disabled = !ready || !state.engineUp;
      if (els.scanResult) {
        els.scanResult.textContent = ready
          ? `当前训练数据：${d.wav_count} 段 wav，清洗后 ${d.clean_count} 条标注，可以训练。`
          : (d.wav_count > 0
              ? `已导入 ${d.wav_count} 段 wav，还没识别清洗 —— 点「② 识别 + 清洗」。`
              : '还没有训练数据。选一个音频文件夹，点「扫描」→「① 导入音频」→「② 识别 + 清洗」。');
      }
      // 数据变了（导入/删除/清洗）→ 旧的质检和标注结果就不作数了，自动清空
      const fingerprint = `${d.wav_count}/${d.clean_count}`;
      if (state.datasetSnapshot && state.datasetSnapshot !== fingerprint) {
        await clearQcResult(true);
        clearAnnResult(true);
      }
      state.datasetSnapshot = fingerprint;
    } catch (e) {
      /* 忽略 */
    }
  }

  // ---------- 结果清空（换模型/换数据时自动、也可手动）----------
  async function clearQcResult(silent) {
    qcLastReport = null;
    if (els.qcSummary) els.qcSummary.textContent = '还没检查过。点「开始质检」，几百段音频大约十几秒。';
    if (els.qcFilter) els.qcFilter.hidden = true;
    if (els.qcList) els.qcList.innerHTML = '';
    try {
      await api('/api/qc/report', { method: 'DELETE' });
    } catch (e) {
      /* 忽略 */
    }
    if (!silent) showToast('质检结果已清空');
  }

  function clearAnnResult(silent) {
    annLastData = null;
    if (els.annStats) els.annStats.textContent = '列表已清空，点「刷新」重新读取。';
    if (els.annFilter) els.annFilter.hidden = true;
    if (els.annList) els.annList.innerHTML = '';
    if (!silent) showToast('标注列表已清空');
  }

  function showToast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('show'), 1800);
  }

  async function browseFolder() {
    if (!els.browseBtn) return;
    const old = els.browseBtn.textContent;
    els.browseBtn.disabled = true;
    els.browseBtn.textContent = '等待选择…';
    if (els.browseHint) els.browseHint.textContent = '已打开文件夹选择窗口，请在弹出的窗口里选好文件夹。';
    try {
      const res = await api('/api/dialog/folder', { method: 'POST' });
      if (res && res.path) {
        els.sourcePath.value = res.path;
        if (els.browseHint) els.browseHint.textContent = '已选择：' + res.path;
        await scanSource();
      } else {
        if (els.browseHint) els.browseHint.textContent =
          res && res.busy ? '已经有一个选择框开着，先选完那个。' : '没有选择文件夹。';
      }
    } catch (e) {
      if (els.browseHint) els.browseHint.textContent = '打开选择框失败：' + (e.message || e);
    } finally {
      els.browseBtn.disabled = false;
      els.browseBtn.textContent = old;
    }
  }

  async function scanSource() {
    const path = (els.sourcePath && els.sourcePath.value || '').trim();
    if (!path) {
      showError('还没填路径', '把音频文件夹的路径粘贴进来（比如 C:\\Users\\123\\Desktop\\白2\\人声\\雪菜）。');
      return;
    }
    els.scanResult.textContent = '正在扫描…';
    try {
      const d = await api('/api/data/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      els.scanResult.textContent =
        `找到 ${d.file_count} 个音频文件 · 总时长约 ${d.total_min} 分钟 · 平均 ${d.avg_sec} 秒/段` +
        `（已导入 ${d.already_imported} 段）`;
    } catch (e) {
      els.scanResult.textContent = '扫描失败：' + (e.message || e);
    }
  }

  async function importAudio() {
    const path = (els.sourcePath && els.sourcePath.value || '').trim();
    if (!path) {
      showError('还没填路径', '先填音频文件夹路径。');
      return;
    }
    // 先扫一下，问用户时能说清楚要导入多少
    let count = 0;
    try {
      const d = await api('/api/data/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      count = d.file_count || 0;
      els.scanResult.textContent =
        `找到 ${d.file_count} 个音频文件 · 总时长约 ${d.total_min} 分钟（已导入 ${d.already_imported} 段）`;
    } catch (e) {
      /* 扫描失败也继续尝试导入 */
    }
    const ok = window.confirm(
      `导入这个文件夹里的全部音频？${count ? `（共 ${count} 个）` : ''}\n` +
      `会转成训练格式（wav 16k 单声道），已导入过的会自动跳过。\n` +
      `每 100 段大约 30 秒，可以关掉页面让它后台跑。`
    );
    if (!ok) return;
    els.importBtn.disabled = true;
    try {
      await api('/api/data/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, max_samples: 0 }),
      });
      els.dataJob.classList.remove('hidden');
      pollDataJob();
    } catch (e) {
      showError('导入失败', String(e.message || e));
      els.importBtn.disabled = false;
    }
  }

  async function prepareData() {
    const ok = window.confirm('开始识别 + 清洗？\n这一步比较久（几百段音频大约 10~30 分钟），可以关掉页面让它后台跑。');
    if (!ok) return;
    els.prepareBtn.disabled = true;
    try {
      await api('/api/data/prepare', { method: 'POST' });
      els.dataJob.classList.remove('hidden');
      pollDataJob();
    } catch (e) {
      showError('启动失败', String(e.message || e));
      els.prepareBtn.disabled = false;
    }
  }

  function setDataJobBusy(busy) {
    if (els.importBtn) els.importBtn.disabled = busy;
    if (els.prepareBtn) els.prepareBtn.disabled = busy;
    if (els.scanBtn) els.scanBtn.disabled = busy;
  }

  // 页面刷新/切页后如果任务还在跑，自动接上进度
  async function resumeDataJob() {
    try {
      const j = await api('/api/data/job');
      if (j && j.running) pollDataJob();
    } catch (e) { /* 忽略 */ }
  }

  async function pollDataJob() {
    if (dataJobTimer) clearTimeout(dataJobTimer);
    try {
      const j = await api('/api/data/job');
      if (j.kind) {
        els.dataJob.classList.remove('hidden');
        els.dataJobStage.textContent = j.message || '处理中…';
        const pct = j.total > 0 ? Math.round((j.done / j.total) * 100) : (j.running ? 8 : 100);
        els.dataJobBar.style.width = pct + '%';
        if (els.dataJobLog && j.log_tail) {
          els.dataJobLog.textContent = j.log_tail.join('\n');
          els.dataJobLog.scrollTop = els.dataJobLog.scrollHeight;
        }
      }
      setDataJobBusy(j.running);
      if (j.running) {
        dataJobTimer = setTimeout(pollDataJob, 2000);
      } else {
        setDataJobBusy(false);
        updateDataStatus();
        loadTrainData();
        if (state.view === 'material') loadMaterials();
      }
    } catch (e) {
      dataJobTimer = setTimeout(pollDataJob, 3000);
    }
  }

  // ---------- 训练 ----------
  let trainTimer = null;

  async function loadTrainData() {
    if (!els.trainData) return;
    try {
      const d = await api('/api/train/data');
      els.trainData.textContent = d.ready
        ? `数据就绪：${d.wav_count} 段音频 · 约 ${d.duration_min} 分钟 · 清洗后 ${d.clean_count} 条标注`
        : '训练数据还不齐（需要 wav 音频 + 清洗后的标注文件）';
    } catch (e) {
      els.trainData.textContent = '训练数据检查失败';
    }
  }

  function fmtDur(sec) {
    if (sec == null) return '—';
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
  }

  let trainStoppedByUser = false;

  async function refreshTrainStatus() {
    if (!els.trainBadge) return;
    try {
      const st = await api('/api/train/status');
      const running = st.running;
      const stopped = !running && st.success === false && trainStoppedByUser;
      els.trainBadge.textContent = running
        ? '训练中'
        : stopped
          ? '已停止'
          : (st.success === true ? '已完成' : (st.success === false ? '失败/已停' : '空闲'));
      els.trainBadge.className = 'badge ' + (running ? 'badge-warn' : (st.success === true ? 'badge-ok' : (st.success === false && !stopped ? 'badge-danger' : 'badge-neutral')));
      els.trainStartBtn.disabled = running || !state.engineUp || !state.dataReady;
      els.trainStopBtn.classList.toggle('hidden', !running);
      els.trainProgress.classList.toggle('hidden', !running && st.stage_index < 0 && !st.log_path);

      if (st.log_path) {
        els.trainStage.textContent = st.stage || '准备中';
        const total = st.total_stages || 7;
        const idx = Math.max(0, st.stage_index + 1);
        els.trainBar.style.width = Math.round((idx / total) * 100) + '%';
        els.trainMeta.textContent =
          `已用 ${fmtDur(st.elapsed_sec)}` +
          (st.epochs_s2 ? ` · 音色 ${st.epochs_s2} 轮 / 韵律 ${st.epochs_s1} 轮` : '');
        if (els.trainLog && st.log_tail) {
          els.trainLog.textContent = st.log_tail.join('\n');
          els.trainLog.scrollTop = els.trainLog.scrollHeight;
        }
      }
      // 训练中每 5 秒刷新；结束就不再轮询
      if (running) {
        if (!trainTimer) trainTimer = setInterval(refreshTrainStatus, 5000);
      } else if (trainTimer) {
        clearInterval(trainTimer);
        trainTimer = null;
        loadTrainData();
        loadVoices();
      }
    } catch (e) {
      /* 状态接口失败忽略 */
    }
  }

  async function startTraining() {
    const s2 = parseInt((els.epochsS2 && els.epochsS2.value) || '6', 10);
    const s1 = parseInt((els.epochsS1 && els.epochsS1.value) || '8', 10);
    const b2 = parseInt((els.batchS2 && els.batchS2.value) || '2', 10);
    const b1 = parseInt((els.batchS1 && els.batchS1.value) || '4', 10);
    // 默认从零训练：不加载上次训练到一半的权重，避免续训导致轮数不生效
    const fromScratch = !!(els.fromScratch && els.fromScratch.checked);
    const ok = window.confirm(
      `开始训练？\n音色模型 ${s2} 轮 + 韵律模型 ${s1} 轮，预计 ${Math.round(s2 * 2 + s1 * 0.6)} 分钟左右。\n` +
      '模式：' + (fromScratch ? '从零训练（用预训练底模重新开始）' : '在现有权重基础上继续训练') + '\n' +
      '开始训练时会先校验/重建预处理特征（文本、语义、hubert），数据有变动时旧特征会重算，可能要几分钟。\n' +
      `训练期间合成会变慢（显存被占用），建议先做完手头的合成。`
    );
    if (!ok) return;
    els.trainStartBtn.disabled = true;
    trainStoppedByUser = false;
    try {
      await api('/api/train/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          epochs_s2: s2, epochs_s1: s1, batch_s2: b2, batch_s1: b1,
          save_every_s2: parseInt((els.saveEveryS2 && els.saveEveryS2.value) || '2', 10),
          save_every_s1: parseInt((els.saveEveryS1 && els.saveEveryS1.value) || '4', 10),
          lr_s2: parseFloat((els.lrS2 && els.lrS2.value) || '0'),
          lr_s1: parseFloat((els.lrS1 && els.lrS1.value) || '0'),
          auto_eval: !!(els.autoEval && els.autoEval.checked),
          from_scratch: fromScratch,
        }),
      });
      await refreshTrainStatus();
    } catch (e) {
      showError('启动训练失败', String(e.message || e));
      els.trainStartBtn.disabled = false;
    }
  }

  async function stopTraining() {
    const ok = window.confirm('确定停止训练？已经训练的阶段会保留，但这次不会产出完整模型。');
    if (!ok) return;
    try {
      trainStoppedByUser = true;
      await api('/api/train/stop', { method: 'POST' });
      await refreshTrainStatus();
    } catch (e) {
      showError('停止失败', String(e.message || e));
    }
  }

  // ---------- 评测打分 ----------
  const LANG_LABEL = { ja: '日文', zh: '中文', en: '英文' };

  async function runEvaluation() {
    if (!els.evalBtn) return;
    els.evalBtn.disabled = true;
    els.evalBtn.textContent = '评测中…';
    els.evalProgress.classList.remove('hidden');
    if (els.evalResult) els.evalResult.classList.add('hidden');
    els.evalProgressText.textContent = '正在合成测试句并打分，约 1.5 分钟…';
    const progressTimer = setInterval(async () => {
      try {
        const st = await api('/api/eval/status');
        const msg = st && (st.message || st.stage);
        if (msg) els.evalProgressText.textContent = msg;
      } catch (e) { /* 状态拿不到就算了 */ }
    }, 1500);
    try {
      const res = await api('/api/evaluate', { method: 'POST' });
      if (!res || !res.ok || !res.result) throw new Error('评测没有返回结果');
      renderEvalResult(res.result);
      await loadEvalHistory();
    } catch (e) {
      showError('评测失败', String(e.message || e));
    } finally {
      clearInterval(progressTimer);
      els.evalProgress.classList.add('hidden');
      els.evalBtn.textContent = '开始评测';
      els.evalBtn.disabled = !state.engineUp;
    }
  }

  async function loadEvalTarget() {
    if (!els.evalTarget) return;
    try {
      const [models, voices, tests] = await Promise.all([
        api('/api/models'),
        api('/api/voices'),
        api('/api/evaluate/tests'),
      ]);
      const m = (models.models || [])[0];
      const v = (voices.voices || [])[0];
      const jaN = (tests.ja || []).length;
      const zhN = ((tests.cross || {}).zh || []).length;
      const enN = ((tests.cross || {}).en || []).length;
      els.evalTarget.textContent =
        `当前模型：${m ? m.name : '默认'} · 参考音频：${v ? (v.name === m?.id ? '默认参考音频' : v.name) : '—'} · ` +
        `测试句：${jaN} 句日文 + ${zhN} 句中文 + ${enN} 句英文（共 ${jaN + zhN + enN} 句）`;
    } catch (e) {
      els.evalTarget.textContent = '读取评测对象失败';
    }
  }

  function renderEvalResult(r) {
    if (!els.evalResult) return;
    els.evalResult.classList.remove('hidden');
    els.evalScore.textContent = r.overall != null ? r.overall.toFixed(3) : '—';
    els.evalLevel.textContent = r.level || '—';
    els.evalLevel.className = 'eval-level ' + evalLevelClass(r.level);
    els.evalModel.textContent = '当前模型：' + (r.model || '默认');

    // 人话结论
    if (els.evalConclusion) {
      const parts = [];
      const names = { ja: '日文', zh: '中文', en: '英文' };
      let best = null;
      for (const [lang, v] of Object.entries(r.by_lang || {})) {
        if (v.avg == null) continue;
        parts.push(`${names[lang] || lang} ${v.avg.toFixed(2)}（${levelWord(v.avg)}）`);
        if (!best || v.avg > best.avg) best = { lang, avg: v.avg };
      }
      let tail = '';
      if (r.overall != null) {
        tail = r.overall >= 0.78
          ? '整体达到"很像"水平，可以直接用。'
          : r.overall >= 0.65
            ? '整体"像"，日常能用；想更像可以扩数据或加训练轮数。'
            : '整体一般，建议先看「标注」和「质检」有没有脏数据。';
      }
      const bestTxt = best ? `最好的是${names[best.lang] || best.lang}。` : '';
      els.evalConclusion.textContent = parts.length ? `结论：${parts.join('，')}。${bestTxt}${tail}` : '结论：没有拿到有效分数。';
    }

    // 分语言小分
    els.evalLangs.innerHTML = '';
    for (const [lang, v] of Object.entries(r.by_lang || {})) {
      const d = document.createElement('span');
      d.className = 'eval-lang-chip';
      d.textContent = (LANG_LABEL[lang] || lang) + ' ' + (v.avg != null ? v.avg.toFixed(2) : '—') + `（${v.count}句）`;
      els.evalLangs.appendChild(d);
    }

    // 每句明细（可播放，带"像/不像"标签）
    state.evalLastResult = r;
    renderEvalDetails(r, state.evalFilter || 'all');
  }

  function levelWord(score) {
    if (score >= 0.78) return '很像';
    if (score >= 0.65) return '像';
    if (score >= 0.50) return '一般';
    return '不像';
  }

  function renderEvalDetails(r, filter) {
    if (!els.evalDetails) return;
    els.evalDetails.innerHTML = '';
    const showFilter = els.evalFilter;
    if (showFilter) {
      showFilter.hidden = false;
      showFilter.querySelectorAll('.filter-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.filter === filter);
      });
    }
    const details = (r.details || []).filter((it) =>
      filter === 'bad' ? (it.score == null || it.score < 0.65) : true
    );
    if (!details.length) {
      const empty = document.createElement('div');
      empty.className = 'eval-detail-empty';
      empty.textContent = filter === 'bad' ? '好消息：没有明显不像的句子。' : '没有明细。';
      els.evalDetails.appendChild(empty);
      return;
    }
    for (const item of details) {
      const row = document.createElement('div');
      row.className = 'eval-detail-row';
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'history-play';
      play.setAttribute('aria-label', '播放');
      setIcon(play, 'play');
      play.title = '播放';
      const txt = document.createElement('span');
      txt.className = 'eval-detail-text';
      txt.textContent = `[${LANG_LABEL[item.lang] || item.lang}] ${item.text}`;
      const lv = document.createElement('span');
      lv.className = 'lv-chip ' + evalLevelClass(item.level);
      lv.textContent = item.level || '—';
      const score = document.createElement('span');
      score.className = 'eval-detail-score';
      score.textContent = item.score != null ? item.score.toFixed(3) : '—';
      row.append(play, txt, lv, score);
      if (item.audio_url) {
        row.addEventListener('click', () => playAudio(item.audio_url));
      }
      els.evalDetails.appendChild(row);
    }
  }

  function evalLevelClass(level) {
    if (!level) return '';
    if (level.indexOf('很像') >= 0) return 'lv-good';
    if (level.indexOf('不像') >= 0) return 'lv-bad';
    if (level.indexOf('像') >= 0) return 'lv-ok';
    return 'lv-mid';
  }

  let evalHistoryRecords = [];

  async function loadEvalHistory() {
    if (!els.evalHistory) return;
    try {
      const res = await api('/api/evaluations');
      const list = (res && res.evaluations) || [];
      evalHistoryRecords = list;
      els.evalHistory.querySelectorAll('.eval-history-item').forEach((n) => n.remove());
      els.evalHistoryEmpty.hidden = list.length > 0;
      for (const e of list) {
        const row = document.createElement('div');
        row.className = 'eval-history-item';
        // 全部用 textContent 渲染（e.model 是后端数据，不拼 innerHTML）
        const score = document.createElement('span');
        score.className = 'eval-h-score';
        score.textContent = e.overall != null ? e.overall.toFixed(3) : '—';
        const level = document.createElement('span');
        level.className = 'eval-h-level';
        level.textContent = e.level || '';
        const model = document.createElement('span');
        model.className = 'eval-h-model';
        model.textContent = e.model || '';
        const time = document.createElement('span');
        time.className = 'eval-h-time';
        time.textContent = formatTime(e.created_at || e.time);
        row.append(score, level, model, time);
        row.title = '点击查看这次评测的明细';
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => {
          const record = evalHistoryRecords.find((x) => x.time === e.time);
          if (!record) return;
          renderEvalResult(record);
          if (els.evalResult) els.evalResult.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        els.evalHistory.appendChild(row);
      }
    } catch (e) {
      /* 历史加载失败不影响主流程 */
    }
  }

  // ---------- 模型改名 ----------
  async function renameCurrentModel() {
    const idx = els.voiceSelect.selectedIndex;
    const opt = idx >= 0 ? els.voiceSelect.options[idx] : null;
    const file = opt && opt.dataset ? opt.dataset.file : '';
    if (!file) {
      showError('没有可改名的模型', '先等模型列表加载出来。');
      return;
    }
    const old = opt.textContent;
    const input = window.prompt('给这个模型起个名字（留空 = 恢复默认 e 编号）\n当前：' + old, old);
    if (input === null) return;   // 取消
    try {
      const res = await api('/api/models/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: file, name: input }),
      });
      await loadVoices();
      const newName = res && res.model ? (res.model.display || res.model.name) : input;
      // 重新选中刚改名的那个
      for (const o of els.voiceSelect.options) {
        if (o.dataset && o.dataset.file === file) { els.voiceSelect.value = o.value; o.selected = true; break; }
      }
    } catch (e) {
      showError('改名失败', String(e.message || e));
    }
  }

  // ---------- 预设（浏览器本地存储） ----------
  const PRESET_KEY = 'abv:presets';

  function getPresets() {
    try {
      const raw = localStorage.getItem(PRESET_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  // 按下拉框的 value 找音色：模型条目 value = 模型名，零样本 value = 参考音频路径
  function findVoice(value) {
    if (!value) return null;
    return state.voices.find((v) =>
      (v.char === 'model' ? (v.name || v.path) === value : (v.path || v.name) === value)
    ) || null;
  }

  function savePresets(list) {
    // 返回 false 表示没存上（隐私模式/空间满），由调用方提示用户
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      return false;
    }
  }

  function renderPresets() {
    const list = getPresets();
    els.presetList.innerHTML = '';
    els.presetEmpty.hidden = list.length > 0;
    els.presetList.classList.toggle('hidden', list.length === 0);
    for (let i = 0; i < list.length; i++) {
      els.presetList.appendChild(buildPresetItem(list[i], i));
    }
  }

  function buildPresetItem(p, index) {
    const row = document.createElement('div');
    row.className = 'preset-item';

    const name = document.createElement('span');
    name.className = 'preset-name';
    name.textContent = p.name || ('预设 ' + (index + 1));

    const meta = document.createElement('div');
    meta.className = 'preset-meta';
    const voiceName = findVoice(p.voice);
    const voiceTag = document.createElement('span');
    voiceTag.className = 'history-tag';
    voiceTag.textContent = voiceName ? (voiceName.display || voiceName.label || voiceName.name) : '音色已失效';
    const langTag = document.createElement('span');
    langTag.className = 'history-tag';
    langTag.textContent = (p.lang || '?').toUpperCase();
    const toneTag = document.createElement('span');
    toneTag.className = 'history-tag';
    toneTag.textContent = p.tone || '自动';
    meta.append(voiceTag, langTag, toneTag);

    const actions = document.createElement('div');
    actions.className = 'preset-actions';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'preset-apply';
    apply.textContent = '应用';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'preset-delete';
    del.textContent = '删除';

    apply.addEventListener('click', () => applyPreset(p));
    del.addEventListener('click', () => {
      const list = getPresets();
      list.splice(index, 1);
      if (!savePresets(list)) {
        showError('预设删除失败', '浏览器本地存储不可用（可能是隐私模式或空间满了），这次删除没生效。');
        return;
      }
      renderPresets();
    });

    actions.append(apply, del);
    row.append(name, meta, actions);
    return row;
  }

  function applyPreset(p) {
    // 音色仍存在才设置
    if (findVoice(p.voice)) {
      els.voiceSelect.value = p.voice;
    }
    if (p.lang && ['zh', 'en', 'ja'].includes(p.lang)) setLang(p.lang);
    if (p.inputLang && ['zh', 'en', 'ja'].includes(p.inputLang)) setInputLang(p.inputLang);
    if (p.tone) setTone(p.tone);
    // 音质微调也要一起恢复，否则预设里的声音参数对不上
    if (p.temperature != null) setTemperature(p.temperature);
    if (p.seed != null) setSeed(p.seed);
    els.textInput.focus();
    showToast('已套用预设「' + (p.name || '') + '」');
  }

  function saveCurrentPreset() {
    const list = getPresets();
    let name = '';
    try {
      const input = window.prompt('给这个预设起个名字（留空用时间命名）：', '预设 ' + (list.length + 1));
      if (input === null) return;   // 取消
      name = (input || '').trim();
    } catch (e) { name = ''; }
    if (!name) name = '预设 ' + new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const preset = {
      name,
      voice: els.voiceSelect.value || '',
      lang: state.lang,
      inputLang: state.inputLang,
      tone: state.tone,
      temperature: state.temperature,
      seed: state.seed,
      savedAt: new Date().toISOString(),
    };
    list.push(preset);
    if (!savePresets(list)) {
      // localStorage 不可用时不能静默失败，否则用户以为存上了
      showError('预设保存失败', '浏览器本地存储不可用（可能是隐私模式或空间满了），这次预设没存上。');
      return;
    }
    renderPresets();
    showToast('预设已保存');
  }

  // ---------- 试听所选音色 ----------
  async function previewVoice() {
    const voice = els.voiceSelect.value;
    if (!voice) {
      showError('还没选音色', '先在音色下拉框里选一个，再点试听。');
      return;
    }
    hideError();
    try {
      const url = '/api/preview?voice=' + encodeURIComponent(voice);
      const res = await fetch(url);
      if (!res.ok) {
        // 按状态码给不同的说法：404 = 没有这个参考音频，500 = 引擎出错
        if (res.status === 404) {
          showError('找不到这个参考音频', '当前音色没有可用的参考音频。换一个音色再试，或者先训练一个模型。');
        } else if (res.status === 500) {
          showError('引擎出错', '声音引擎试听时出错了，稍后再试；一直失败就看后端窗口的报错。');
        } else {
          showError('试听失败', '请求没能完成（HTTP ' + res.status + '），稍后再试。');
        }
        return;
      }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      playAudio(objUrl);
      setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    } catch (e) {
      // fetch 本身失败 = 后端服务连不上
      showError('试听失败', '连不上后端服务（' + String(e.message || e) + '），确认后端还在运行后重试。');
    }
  }

  // ---------- 批量合成 ----------
  const ALLOWED_TONES = ['auto', '平静', '开心', '悲伤', '生气', '惊讶', '害怕'];
  let batchRunning = false;
  let batchAbort = null;

  function parseBatchLines() {
    const lines = els.batchInput.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.map((line) => {
      // 支持「语气｜台词」或「语气|台词」的行首指定
      const m = line.match(/^([^｜|]{1,4})[｜|](.*)$/);
      if (m && ALLOWED_TONES.includes(m[1])) {
        return { tone: m[1], text: m[2].trim() };
      }
      return { tone: els.batchDefaultTone.value, text: line };
    }).filter((x) => x.text);
  }

  function updateBatchCount() {
    const n = parseBatchLines().length;
    els.batchCount.textContent = '共 ' + n + ' 句';
  }

  function buildBatchItem(index, item) {
    const row = document.createElement('div');
    row.className = 'batch-item';

    const idx = document.createElement('span');
    idx.className = 'batch-idx';
    idx.textContent = (index + 1) + '.';

    const text = document.createElement('span');
    text.className = 'batch-text';
    text.textContent = item.text;

    const status = document.createElement('span');
    status.className = 'batch-status';
    status.textContent = '排队中…';

    row.append(idx, text, status);
    return { row, status };
  }

  async function startBatch() {
    const items = parseBatchLines();
    if (items.length === 0) {
      showError('没有可合成的句子', '在批量文本框里每行写一句台词。');
      return;
    }
    const voice = els.voiceSelect.value;
    if (!voice) {
      showError('还没选音色', '先选音色，再开始批量合成。');
      return;
    }

    hideError();
    batchRunning = true;
    els.batchStartBtn.disabled = true;
    els.batchStopBtn.classList.remove('hidden');
    els.batchResults.classList.remove('hidden');
    els.batchResults.innerHTML = '';

    for (let i = 0; i < items.length; i++) {
      if (!batchRunning) break;
      const item = items[i];
      const { row, status } = buildBatchItem(i, item);
      els.batchResults.appendChild(row);
      status.textContent = '合成中…';
      batchAbort = new AbortController();
      try {
        const res = await api('/api/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: batchAbort.signal,
          body: JSON.stringify({ text: item.text, lang: state.lang, input_lang: state.inputLang, voice, tone: item.tone, seed: state.seed, temperature: state.temperature }),
        });
        if (res && res.ok && res.audio_url) {
          setIcon(status, 'check');
          status.className = 'batch-status done';
          const audio = document.createElement('audio');
          audio.controls = true;
          audio.preload = 'metadata';
          audio.src = res.audio_url;
          // 批量音频也纳入统一播放管理：开始播放时停掉结果播放器/历史/其它音频
          audio.addEventListener('play', () => stopAll(audio));
          row.appendChild(audio);
        } else {
          throw new Error(res && res.message ? res.message : '没有返回音频');
        }
      } catch (e) {
        if (!batchRunning) {
          status.textContent = '已停止';
          status.className = 'batch-status';
        } else {
          status.innerHTML = iconHtml('alert-triangle') + ' 失败：' + String(e.message || e).slice(0, 60);
          status.className = 'batch-status fail';
        }
      }
    }

    batchRunning = false;
    batchAbort = null;
    els.batchStartBtn.disabled = !state.engineUp;
    els.batchStopBtn.classList.add('hidden');
    loadHistory();
  }

  // ---------- 历史 ----------
  function renderHistory(list) {
    els.historyEmpty.hidden = list.length > 0;
    els.historyList.querySelectorAll('.history-item').forEach((n) => n.remove());
    // 「清空历史」按钮：有记录时才显示
    if (els.clearHistoryBtn) els.clearHistoryBtn.hidden = list.length === 0;
    for (const item of list) {
      els.historyList.appendChild(buildHistoryItem(item));
    }
  }

  function buildHistoryItem(item) {
    const row = document.createElement('div');
    row.className = 'history-item';

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'history-play';
    play.setAttribute('aria-label', '播放');
    setIcon(play, 'play');

    const body = document.createElement('div');
    body.className = 'history-body';
    const textEl = document.createElement('div');
    textEl.className = 'history-text';
    textEl.textContent = item.text || '（无文本）';
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const langTag = document.createElement('span');
    langTag.className = 'history-tag';
    langTag.textContent = (item.lang || '?').toUpperCase();
    const toneTag = document.createElement('span');
    toneTag.className = 'history-tag';
    toneTag.textContent = item.tone || '自动';
    const timeEl = document.createElement('span');
    timeEl.textContent = formatTime(item.created_at || item.time);
    meta.append(langTag, toneTag, timeEl);
    body.append(textEl, meta);

    const dl = document.createElement('a');
    dl.className = 'history-dl';
    setIcon(dl, 'download');
    dl.title = '下载';
    dl.href = item.audio_url || '#';
    if (!item.audio_url) dl.classList.add('hidden');
    // 下载文件名带这条记录的时间戳，不要都叫 full.wav
    dl.setAttribute('download', 'voice_' + (item.time || downloadStamp(new Date())) + '.wav');
    // 点下载图标只下载，不要触发整行播放
    dl.addEventListener('click', (e) => e.stopPropagation());

    // 删除这一条
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-del';
    setIcon(del, 'trash-2');
    del.title = '删除这条记录';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = window.confirm('删除这条记录？音频文件也会一起删掉。');
      if (!ok) return;
      del.disabled = true;
      try {
        await api('/api/history/' + encodeURIComponent(item.time), { method: 'DELETE' });
        row.remove();
        if (els.downloadLink && (els.downloadLink.getAttribute('href') || '').endsWith(item.audio_url || '\u0000')) {
          resetResultArea();
        }
        // A/B 里可能有一侧指向刚删掉的文件，按最新历史过滤
        try {
          const resp = await api('/api/history');
          const list = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.history) ? resp.history : []);
          const urls = new Set(list.map((x) => x.audio_url));
          state.abResults = state.abResults.filter((r) => urls.has(r.audio_url));
          renderAB();
        } catch (e) { /* 历史拿不到就保持原状 */ }
        if (!els.historyList.querySelector('.history-item')) els.historyEmpty.hidden = false;
        if (els.clearHistoryBtn && !els.historyList.querySelector('.history-item')) els.clearHistoryBtn.hidden = true;
      } catch (err) {
        del.disabled = false;
        showError('删除失败', String(err.message || err));
      }
    });

    row.append(play, body, dl, del);

    const url = item.audio_url;
    row.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.history-dl')) return;
      if (!url) return;
      const playing = row.classList.contains('playing');
      // 先停掉所有来源（结果播放器/批量/其它历史/素材试听），再决定是否播放这一条
      stopAll();
      if (playing) return;
      const audio = new Audio(url);
      state.currentAudio = audio;
      row.classList.add('playing');
      setIcon(play, 'pause');
      audio.addEventListener('ended', () => {
        row.classList.remove('playing');
        setIcon(play, 'play');
        if (state.currentAudio === audio) state.currentAudio = null;
      });
      audio.play().catch(() => {});
    });

    return row;
  }

  function formatTime(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return '';
      const now = new Date();
      const diffMin = Math.round((now - d) / 60000);
      if (diffMin < 1) return '刚刚';
      if (diffMin < 60) return diffMin + ' 分钟前';
      if (diffMin < 60 * 24) return Math.round(diffMin / 60) + ' 小时前';
      return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  // ---------- 错误提示 ----------
  function showError(title, desc) {
    els.errorBox.classList.remove('hidden');
    els.errorTitle.textContent = title;
    els.errorDesc.textContent = desc;
    // 错误框在合成页里，别的页面出错要额外弹提示，否则用户看不到
    if (state.view && state.view !== 'synth') {
      showToast(title + '：' + desc);
    }
  }
  function hideError() {
    els.errorBox.classList.add('hidden');
  }

  // ---------- 事件绑定 ----------
  els.langBtns.forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  els.inLangBtns.forEach((b) => b.addEventListener('click', () => setInputLang(b.dataset.lang)));
  updateLangNote();

  els.toneBtns.forEach((b) => b.addEventListener('click', () => setTone(b.dataset.tone)));

  els.textInput.addEventListener('input', () => {
    updateMeta();
    hideError();
    // 输入停顿后自动重判语气
    clearTimeout(els.textInput._toneTimer);
    els.textInput._toneTimer = setTimeout(detectTone, 700);
  });

  els.clearBtn.addEventListener('click', () => {
    els.textInput.value = '';
    updateMeta();
    els.toneDetected.hidden = true;
    setTone('auto');
    els.textInput.focus();
  });

  els.synthBtn.addEventListener('click', synthesize);
  els.retrySynthBtn.addEventListener('click', synthesize);
  els.retryBtn.addEventListener('click', boot);
  els.previewBtn.addEventListener('click', previewVoice);
  // 结果播放器开始播放时停掉其它来源（批量/历史/试听），同一时间只响一个
  els.resultAudio.addEventListener('play', () => stopAll(els.resultAudio));
  // 波形播放进度
  els.resultAudio.addEventListener('timeupdate', () => {
    if (!wavePeaks) return;
    const d = els.resultAudio.duration;
    if (d && isFinite(d)) drawWaveform(Math.min(1, els.resultAudio.currentTime / d));
  });
  window.addEventListener('resize', () => {
    if (wavePeaks) drawWaveform(0);
  });
  // A/B 对比按钮
  const abA = document.getElementById('abAaBtn');
  const abB = document.getElementById('abBbBtn');
  if (abA) abA.addEventListener('click', () => playAB('A'));
  if (abB) abB.addEventListener('click', () => playAB('B'));
  renderAB();
  els.savePresetBtn.addEventListener('click', saveCurrentPreset);
  if (els.renameModelBtn) els.renameModelBtn.addEventListener('click', renameCurrentModel);
  if (els.evalBtn) els.evalBtn.addEventListener('click', runEvaluation);
  if (els.trainStartBtn) els.trainStartBtn.addEventListener('click', startTraining);
  if (els.scanBtn) els.scanBtn.addEventListener('click', scanSource);
  if (els.browseBtn) els.browseBtn.addEventListener('click', browseFolder);
  if (els.importBtn) els.importBtn.addEventListener('click', importAudio);
  if (els.prepareBtn) els.prepareBtn.addEventListener('click', prepareData);
  // 素材页
  if (els.materialRefreshBtn) els.materialRefreshBtn.addEventListener('click', loadMaterials);
  if (els.materialSearch) els.materialSearch.addEventListener('input', renderMaterialList);
  if (els.materialClearBtn) els.materialClearBtn.addEventListener('click', clearMaterials);
  if (els.materialRestoreBtn) els.materialRestoreBtn.addEventListener('click', restoreMaterials);
  // 质检页
  if (els.qcRunBtn) els.qcRunBtn.addEventListener('click', runQc);
  if (els.qcClearBtn) els.qcClearBtn.addEventListener('click', () => clearQcResult(false));
  if (els.annClearBtn) els.annClearBtn.addEventListener('click', () => clearAnnResult(false));
  if (els.qcFilter) {
    els.qcFilter.querySelectorAll('.filter-btn').forEach((b) => {
      b.addEventListener('click', () => { state.qcFilter = b.dataset.filter; renderQcList(state.qcFilter); });
    });
  }
  // 标注页
  if (els.annRefreshBtn) els.annRefreshBtn.addEventListener('click', loadAnnotations);
  if (els.annFilter) {
    els.annFilter.querySelectorAll('.filter-btn').forEach((b) => {
      b.addEventListener('click', () => { state.annFilter = b.dataset.filter; renderAnnotations(state.annFilter); });
    });
  }
  if (els.evalFilter) {
    els.evalFilter.querySelectorAll('.filter-btn').forEach((b) => {
      b.addEventListener('click', () => {
        state.evalFilter = b.dataset.filter;
        if (state.evalLastResult) renderEvalDetails(state.evalLastResult, state.evalFilter);
      });
    });
  }
  if (els.trainStopBtn) els.trainStopBtn.addEventListener('click', stopTraining);

  // ---------- 音质微调（预设恢复也走这里，保证 UI 和 state 一致）----------
  function setTemperature(v) {
    let n = parseFloat(v);
    if (!isFinite(n)) n = 0.9;
    n = Math.min(1.2, Math.max(0.5, n));
    state.temperature = n;
    if (els.tempRange) els.tempRange.value = String(n);
    if (els.tempValue) els.tempValue.textContent = n.toFixed(2);
  }

  function setSeed(v) {
    let n = parseInt(v, 10);
    if (isNaN(n)) n = -1;
    state.seed = n;
    if (els.seedInput) els.seedInput.value = String(n);
  }

  if (els.advToggleBtn) {
    els.advToggleBtn.addEventListener('click', () => {
      const hidden = els.advPanel.classList.toggle('hidden');
      els.advToggleBtn.classList.toggle('open', !hidden);
      els.advToggleBtn.setAttribute('aria-expanded', String(!hidden));
    });
    els.advPanel.classList.add('hidden');
    els.advToggleBtn.classList.remove('open');
    els.advToggleBtn.setAttribute('aria-expanded', 'false');
  }
  if (els.tempRange) {
    els.tempRange.addEventListener('input', () => setTemperature(els.tempRange.value));
    setTemperature(els.tempRange.value);   // 初始化 state.temperature
  }
  if (els.seedInput) {
    els.seedInput.addEventListener('change', () => setSeed(els.seedInput.value));
  }
  if (els.rerollBtn) {
    els.rerollBtn.addEventListener('click', () => {
      // 合成进行中不换种子，否则会把当前结果的种子改乱
      if (state.inFlight) {
        showToast('正在合成中，请稍等…');
        return;
      }
      setSeed(Math.floor(Math.random() * 2147483000));
      // 换种子后直接重合成
      synthesize();
    });
  }

  // 清空或删除后，结果区可能指向已经删掉的文件，统一复位
  function resetResultArea() {
    stopAll();
    state.abResults = [];
    const resultSection = document.getElementById('resultSection');
    const resultAudio = document.getElementById('resultAudio');
    const resultMeta = document.getElementById('resultMeta');
    const translatedBox = document.getElementById('translatedBox');
    const downloadLink = document.getElementById('downloadLink');
    const abCompare = document.getElementById('abCompare');
    const waveCanvas = document.getElementById('waveCanvas');
    if (resultAudio) {
      try { resultAudio.pause(); } catch (e) { /* 忽略 */ }
      resultAudio.removeAttribute('src');
      try { resultAudio.load(); } catch (e) { /* 忽略 */ }
    }
    if (resultSection) resultSection.classList.add('hidden');
    if (translatedBox) translatedBox.textContent = '';
    if (resultMeta) resultMeta.textContent = '';
    if (downloadLink) downloadLink.removeAttribute('href');
    if (abCompare) abCompare.classList.add('hidden');
    if (waveCanvas) {
      const ctx = waveCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
    }
  }

  // 清空全部历史
  if (els.clearHistoryBtn) {
    els.clearHistoryBtn.addEventListener('click', async () => {
      const ok = window.confirm('清空全部历史记录？所有合成音频都会被删除，无法恢复。');
      if (!ok) return;
      els.clearHistoryBtn.disabled = true;
      try {
        await api('/api/history', { method: 'DELETE' });
        renderHistory([]);
        resetResultArea();
      } catch (err) {
        showError('清空失败', String(err.message || err));
      } finally {
        els.clearHistoryBtn.disabled = false;
      }
    });
  }

  els.batchToggleBtn.addEventListener('click', () => {
    els.batchPanel.classList.toggle('hidden');
    if (!els.batchPanel.classList.contains('hidden')) {
      updateBatchCount();
      els.batchInput.focus();
    }
  });

  els.batchInput.addEventListener('input', updateBatchCount);
  els.batchStartBtn.addEventListener('click', startBatch);
  els.batchStopBtn.addEventListener('click', () => {
    batchRunning = false;
    if (batchAbort) batchAbort.abort();
  });

  els.voiceSelect.addEventListener('change', () => {
    if (els.voiceSelect.value) {
      // 记不住选择不影响使用，localStorage 不可用时静默跳过
      try { localStorage.setItem('abv:voice', els.voiceSelect.value); } catch (e) { /* 忽略 */ }
      // 质检/标注对应的是数据本身，换模型不影响，不要清
      updateModelBadges();
    }
  });

  // 快捷键：Ctrl+Enter 合成；空格 播放/暂停结果（焦点不在输入框时）
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && state.view === 'synth') {
      e.preventDefault();
      synthesize();
      return;
    }
    if (e.key === ' ' && !els.synthBtn.disabled && document.activeElement !== els.textInput) {
      const isInput = document.activeElement && (
        document.activeElement.tagName === 'TEXTAREA' ||
        document.activeElement.tagName === 'INPUT'
      );
      if (!isInput && !els.resultSection.classList.contains('hidden')) {
        e.preventDefault();
        if (els.resultAudio.paused) els.resultAudio.play(); else els.resultAudio.pause();
      }
    }
  });

  // 浏览器前进/后退切页
  window.addEventListener('hashchange', () => {
    const name = location.hash.replace('#', '');
    if (name && name !== state.view) switchView(name);
  });

  // 引擎断线轮询（每 12 秒查一次，回来了自动恢复）
  setInterval(async () => {
    try {
      const h = await api('/api/health');
      const up = Boolean(h && h.engine_up);
      if (up !== state.engineUp) {
        if (up) {
          setEngineUp(true);
          await Promise.all([loadVoices(), loadHistory()]);
        } else {
          // 后端在，只是引擎掉了
          setEngineUp(false, 'engine');
        }
      }
    } catch (e) {
      // 连 /api/health 都请求不到 = 后端不可达
      if (state.engineUp) setEngineUp(false, 'backend');
    }
  }, 12000);

  // ---------- 启动 ----------
  updateMeta();
  renderPresets();
  // 顶部标签切换
  document.querySelectorAll('.side-nav-item[data-view], .flow-step[data-view]').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });
  // 直接带 #train / #eval 打开也能定位
  switchView((location.hash || '#synth').slice(1));

  boot();
})();
