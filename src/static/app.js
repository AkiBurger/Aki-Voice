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
    refs: [],                 // 参考音频列表（GET /api/refs）
    currentAudioUrl: null,
    engineUp: false,
    currentAudio: null,       // 当前正在播放的音频（全局只响一个）
    abResults: [],            // 最近两次合成结果（A/B 对比）
    qcFilter: 'all',
    annFilter: 'all',
    annCount: 0,              // 标注条数（教程步骤判断用）
    datasetSnapshot: '',      // 上次的数据指纹，变了就清空质检/标注结果
    currentHistoryUrl: null,
    temperature: 0.9,         // 音质微调：越低越稳
    seed: -1,                 // -1 = 每次随机
    inFlight: false,          // 合成请求进行中（防重复点击 / Ctrl+Enter / 换种子重合成）
    evalRunning: false,       // 评测进行中（期间禁用合成 CTA）
    synthIdleWait: false,     // 批量停止后等待引擎空闲
    // 自定义图片（后端 /api/theme；不支持时静默降级）
    theme: { bg: null, char: null },
    themeSupported: true,
    themeLoaded: false,
    tutorialData: { wav: 0, clean: 0, models: 0, evals: 0, history: 0 },
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
    refSelect: $('refSelect'),
    refHint: $('refHint'),
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
    setRefBtn: $('setRefBtn'),
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
    // v4 游戏主界面 / galgame 外壳
    sceneA: $('sceneA'),
    sceneB: $('sceneB'),
    settingsBtn: $('settingsBtn'),
    settingsPanel: $('settingsPanel'),
    motionToggle: $('motionToggle'),
    charToggle: $('charToggle'),
    voicePanel: $('voicePanel'),
    voicePanelToggle: $('voicePanelToggle'),
    backlogDrawer: $('backlogDrawer'),
    backlogToggle: $('backlogToggle'),
    backlogBody: $('backlogBody'),
    backlogCount: $('backlogCount'),
    speakerTone: $('speakerTone'),
    pageVeil: $('pageVeil'),
    navCapsule: $('navCapsule'),
    voicePanelBtn: $('voicePanelBtn'),
    drawerScrim: $('drawerScrim'),
    historyBtn: $('historyBtn'),
    annSearch: $('annSearch'),
    annCount: $('annCount'),
    evalBar: $('evalBar'),
    // 自定义图片
    bgThumb: $('bgThumb'),
    charThumb: $('charThumb'),
    bgDesc: $('bgDesc'),
    charDesc: $('charDesc'),
    bgUploadBtn: $('bgUploadBtn'),
    bgResetBtn: $('bgResetBtn'),
    charUploadBtn: $('charUploadBtn'),
    charResetBtn: $('charResetBtn'),
    bgFileInput: $('bgFileInput'),
    charFileInput: $('charFileInput'),
    themeNote: $('themeNote'),
    customChar: $('customChar'),
    // 教程
    tutorialBtn: $('tutorialBtn'),
    tutorialPanel: $('tutorialPanel'),
    tutorialCloseBtn: $('tutorialCloseBtn'),
    tutorialBody: $('tutorialBody'),
  };

  // ---------- A 式主视觉背景（角色在右、左侧留白；表情 = 背景 120ms 交叉淡入） ----------
  // 5 张 1920×1277 WebP 主视觉：人物在画面右侧，脸在视觉面板/对话框之上留出空间；
  // idle 同时作为其它 5 页的默认背景。
  const SCENE_SRC = {
    idle: 'assets/hero-idle.webp',
    happy: 'assets/hero-happy.webp',
    thinking: 'assets/hero-thinking.webp',
    surprised: 'assets/hero-surprised.webp',
    sad: 'assets/hero-sad.webp',
  };
  const ui = {
    sceneState: 'idle',
    sceneLayer: 'A',
    sceneSrc: '',
    charTimer: 0,
    trainRunning: false,
  };

  function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  function preloadScenes() {
    Object.values(SCENE_SRC).forEach((src) => {
      const img = new Image();
      img.src = src;
    });
  }

  function initScenes() {
    if (!els.sceneA || !els.sceneB) return;
    const src = SCENE_SRC.idle;
    els.sceneA.style.backgroundImage = 'url("' + src + '")';
    els.sceneB.style.backgroundImage = 'url("' + src + '")';
    els.sceneA.classList.add('is-active');
    els.sceneB.classList.remove('is-active');
    ui.sceneLayer = 'A';
    ui.sceneSrc = src;
  }

  // 表情切换 = 背景图交叉淡入淡出（120ms，只在 transform/opacity 之外仅动 opacity）
  function setCharacter(name) {
    // 自定义背景/立绘启用时暂停表情切换（场景只有一张图）
    if (themeActive()) return;
    if (!SCENE_SRC[name]) name = 'idle';
    ui.sceneState = name;
    const src = SCENE_SRC[name];
    clearTimeout(ui.charTimer);
    if (name === 'happy' || name === 'sad' || name === 'surprised') {
      ui.charTimer = setTimeout(() => {
        setCharacter(state.inFlight ? 'thinking' : 'idle');
      }, name === 'surprised' ? 1400 : 2600);
    }
    if (!els.sceneA || !els.sceneB) return;
    if (ui.sceneSrc === src) return;
    const from = ui.sceneLayer === 'A' ? els.sceneA : els.sceneB;
    const to = ui.sceneLayer === 'A' ? els.sceneB : els.sceneA;
    to.style.backgroundImage = 'url("' + src + '")';
    to.classList.add('is-active');
    from.classList.remove('is-active');
    ui.sceneLayer = ui.sceneLayer === 'A' ? 'B' : 'A';
    ui.sceneSrc = src;
  }

  // ---------- 页面切换 v2：内容交叉淡入 + 方向位移 + 极细斜向高光 ----------
  const TRANS = { timer: 0, leaveTimer: 0, titleTimer: 0, titleTimer2: 0 };
  function motionEnabled() {
    return !document.body.classList.contains('no-motion') && !prefersReducedMotion();
  }
  function viewIndex(v) { return MENU_ORDER.indexOf(v); }
  function pulseNav(name) {
    const btn = Array.from(navButtons()).find((b) => b.dataset.view === name);
    if (!btn) return;
    btn.classList.remove('pulse');
    void btn.offsetWidth;
    btn.classList.add('pulse');
    clearTimeout(pulseNav._t);
    pulseNav._t = setTimeout(() => btn.classList.remove('pulse'), 240);
  }
  // 导航激活胶囊：按当前 item 的 offsetTop/height 平滑滑动
  function moveNavCapsule(animate) {
    const cap = els.navCapsule;
    if (!cap) return;
    const btn = Array.from(navButtons()).find((b) => b.dataset.view === state.view);
    if (!btn) return;
    if (!animate) {
      cap.classList.add('no-anim');
      cap.style.opacity = '0';
    }
    cap.style.transform = 'translateY(' + btn.offsetTop + 'px)';
    cap.style.height = btn.offsetHeight + 'px';
    if (!animate) {
      void cap.offsetHeight;
      cap.classList.remove('no-anim');
      cap.style.opacity = '';
    }
    cap.classList.add('ready');
  }
  // 顶栏标题：旧标题 4px 上移淡出 → 新标题 4px 滑入
  function animateTitle(text) {
    const t = document.getElementById('pageTitle');
    if (!t) return;
    clearTimeout(TRANS.titleTimer);
    clearTimeout(TRANS.titleTimer2);
    if (!motionEnabled()) {
      t.textContent = text;
      t.classList.remove('title-leave', 'title-enter');
      return;
    }
    t.classList.remove('title-enter');
    t.classList.add('title-leave');
    TRANS.titleTimer = setTimeout(() => {
      t.textContent = text;
      t.classList.remove('title-leave');
      void t.offsetWidth;
      t.classList.add('title-enter');
      TRANS.titleTimer2 = setTimeout(() => t.classList.remove('title-enter'), 140);
    }, 70);
  }
  function clearTransition() {
    clearTimeout(TRANS.timer);
    clearTimeout(TRANS.leaveTimer);
    clearTimeout(TRANS.titleTimer);
    clearTimeout(TRANS.titleTimer2);
    if (els.pageVeil) els.pageVeil.classList.remove('run');
    document.body.classList.remove('is-transitioning');
    document.querySelectorAll('.view.view-leave').forEach((el) => {
      el.classList.remove('view-leave', 'dir-down', 'dir-up');
      if (el.id !== 'view-' + state.view) el.classList.add('hidden');
    });
    document.querySelectorAll('.view.view-enter').forEach((el) => {
      el.classList.remove('view-enter', 'dir-down', 'dir-up', 'fade-only');
    });
  }
  function playViewTransition(prev, next, title) {
    const prevEl = document.getElementById('view-' + prev);
    const nextEl = document.getElementById('view-' + next);
    if (!nextEl) return;
    clearTransition();
    const motion = motionEnabled();
    // 方向：菜单 index 增大 = 新内容从下方来；减小 = 从上方来
    const dir = viewIndex(next) > viewIndex(prev) ? 'down' : 'up';
    if (!motion) {
      // 只做 150ms 纯淡入
      if (prevEl && prevEl !== nextEl) prevEl.classList.add('hidden');
      nextEl.classList.add('view-enter', 'fade-only');
      clearTimeout(playViewTransition._fade);
      playViewTransition._fade = setTimeout(() => nextEl.classList.remove('view-enter', 'fade-only'), 180);
      animateTitle(title);
      return;
    }
    clearTimeout(playViewTransition._fade);
    if (prevEl && prevEl !== nextEl) {
      prevEl.classList.remove('hidden');
      prevEl.classList.add('view-leave', 'dir-' + dir);
      TRANS.leaveTimer = setTimeout(() => {
        prevEl.classList.add('hidden');
        prevEl.classList.remove('view-leave', 'dir-' + dir);
      }, 220);
    }
    nextEl.classList.remove('hidden');
    nextEl.classList.remove('view-enter', 'dir-down', 'dir-up', 'fade-only');
    void nextEl.offsetWidth;
    nextEl.classList.add('view-enter', 'dir-' + dir);
    if (els.pageVeil) {
      els.pageVeil.classList.remove('run');
      void els.pageVeil.offsetWidth;
      els.pageVeil.classList.add('run');
    }
    document.body.classList.add('is-transitioning');
    document.body.dataset.transDir = dir;
    animateTitle(title);
    TRANS.timer = setTimeout(() => {
      if (els.pageVeil) els.pageVeil.classList.remove('run');
      document.body.classList.remove('is-transitioning');
      nextEl.classList.remove('view-enter', 'dir-down', 'dir-up');
    }, 300);
  }

  function applyDisplaySettings() {
    let motionOn = true;
    let charOn = true;
    try {
      motionOn = localStorage.getItem('abv:motion') !== '0';
      charOn = localStorage.getItem('abv:char') !== '0';
    } catch (e) { /* 存不上就保持默认 */ }
    document.body.classList.toggle('no-motion', !motionOn);
    document.body.classList.toggle('no-char', !charOn);
    if (els.motionToggle) els.motionToggle.checked = motionOn;
    if (els.charToggle) els.charToggle.checked = charOn;
  }

  // ---------- 自定义图片（背景图 / 角色立绘，走后端 /api/theme） ----------
  function themeActive() {
    return !!(state.theme.bg || state.theme.char);
  }

  function bust(url, ts) {
    if (!url) return url;
    const v = String(ts || Date.now());
    // 已带 v= 参数时替换，避免 ?v=xxx&v=yyy
    if (/[?&]v=/.test(url)) return url.replace(/([?&])v=[^&#]*/, '$1v=' + v);
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + v;
  }

  function setThumb(el, item) {
    if (!el) return;
    if (item && item.url) {
      el.style.backgroundImage = 'url("' + bust(item.url, item.updated_at) + '")';
      el.classList.add('has-image');
    } else {
      el.style.backgroundImage = '';
      el.classList.remove('has-image');
    }
  }

  function renderThemeSlots() {
    const bg = state.theme.bg;
    const ch = state.theme.char;
    setThumb(els.bgThumb, bg);
    setThumb(els.charThumb, ch);
    if (els.bgDesc) els.bgDesc.textContent = bg
      ? '已设置。背景已换成你的图，表情切换暂停。'
      : '还没上传。上传后替换主视觉背景，表情切换会暂停。';
    if (els.charDesc) els.charDesc.textContent = ch
      ? '已设置。背景换成纯色底图，右侧显示你的立绘，表情切换暂停。'
      : '还没上传。上传后背景换成纯色底图，右侧立绘换成你的图。';
    if (els.bgResetBtn) els.bgResetBtn.disabled = !bg || !state.themeSupported;
    if (els.charResetBtn) els.charResetBtn.disabled = !ch || !state.themeSupported;
  }

  function applyTheme() {
    const t = state.theme;
    const setSceneBg = (url) => {
      els.sceneA.style.backgroundImage = 'url("' + url + '")';
      els.sceneB.style.backgroundImage = 'url("' + url + '")';
      ui.sceneSrc = url;
    };
    if (t.bg) {
      setSceneBg(bust(t.bg.url, t.bg.updated_at));
      ui.sceneState = 'custom';
    } else if (t.char) {
      setSceneBg('assets/bg-plain.webp');
      ui.sceneState = 'custom';
    } else {
      // 无自定义图片：完整恢复内置五表情双图层（含图层状态）
      initScenes();
    }
    if (t.char) {
      els.customChar.src = bust(t.char.url, t.char.updated_at);
      els.customChar.hidden = false;
    } else {
      els.customChar.hidden = true;
      els.customChar.removeAttribute('src');
    }
    renderThemeSlots();
  }

  async function loadTheme() {
    if (!state.themeLoaded) {
      // 首屏先按默认渲染占位
      renderThemeSlots();
    }
    try {
      const t = await api('/api/theme');
      state.themeSupported = true;
      state.theme = { bg: (t && t.bg) || null, char: (t && t.char) || null };
      state.themeLoaded = true;
      if (els.themeNote) {
        els.themeNote.hidden = true;
        els.themeNote.classList.remove('unsupported');
      }
      applyTheme();
    } catch (e) {
      if (e && e.status === 404) {
        // 后端版本不支持自定义图片：静默降级，只在设置面板里说明
        state.themeSupported = false;
        state.theme = { bg: null, char: null };
        state.themeLoaded = true;
        if (els.themeNote) {
          els.themeNote.hidden = false;
          els.themeNote.classList.add('unsupported');
          els.themeNote.textContent = '当前后端版本不支持自定义图片。';
        }
        renderThemeSlots();
      }
      // 其它错误（后端没起等）不在这里提示，全局有引擎状态兜底
    }
  }

  function setSlotBusy(slot, busy) {
    const map = { bg: ['bgUploadBtn', 'bgResetBtn'], char: ['charUploadBtn', 'charResetBtn'] };
    (map[slot] || []).forEach((id) => {
      const el = els[id];
      if (!el) return;
      el.classList.toggle('theme-uploading', busy);
      el.disabled = busy;
      if (busy && id.indexOf('Upload') >= 0) el.textContent = '上传中…';
      else if (!busy && id.indexOf('Upload') >= 0) el.textContent = '上传';
    });
  }

  async function uploadTheme(slot, file) {
    if (!state.themeSupported) {
      showToast('当前后端版本不支持自定义图片', 3000);
      return;
    }
    const name = slot === 'bg' ? '背景图' : '角色立绘';
    const fd = new FormData();
    fd.append('file', file);
    setSlotBusy(slot, true);
    try {
      await api('/api/theme/upload?slot=' + slot, { method: 'POST', body: fd });
      await loadTheme();
      showToast(name + '已上传。自定义图片已启用，表情切换暂停。', 3200);
    } catch (e) {
      showToast(name + '上传失败：' + String((e && e.message) || e), 3600);
    } finally {
      setSlotBusy(slot, false);
    }
  }

  async function resetTheme(slot) {
    const name = slot === 'bg' ? '背景图' : '角色立绘';
    try {
      await api('/api/theme/' + slot, { method: 'DELETE' });
      await loadTheme();
      showToast(name + '已恢复默认。', 2600);
    } catch (e) {
      showToast(name + '恢复失败：' + String((e && e.message) || e), 3600);
    }
  }

  // ---------- 左下角教程 ----------
  // 与左侧菜单 01~06 同序；首次使用按下方推荐流程走
  const TUTORIAL_STEPS = [
    { id: 'synth', title: '合成', view: 'synth', desc: '写台词、选语气，点合成。平时主要用这一页。' },
    { id: 'material', title: '素材', view: 'material', desc: '导入人声，识别并清洗。第一次做声音从这页开始。' },
    { id: 'qc', title: '质检', view: 'qc', desc: '检查清洗结果，把有问题的片段挑出来。' },
    { id: 'annotate', title: '标注', view: 'annotation', desc: '核对识别出的文本，改掉错字；训练用的就是改后的文本。' },
    { id: 'train', title: '训练', view: 'train', desc: '用清洗好的素材训练音色，练完自动挂到合成页。' },
    { id: 'eval', title: '评测', view: 'eval', desc: '跑测试句，看声纹相似度分数判断像不像。' },
  ];
  const TUTORIAL_FLOW = ['material', 'qc', 'annotate', 'train', 'eval', 'synth'];
  const TUTORIAL_HINT = '从零开始：02 素材 → 03 质检 → 04 标注 → 05 训练 → 06 评测，最后回 01 合成。';

  async function refreshTutorialData() {
    try {
      const results = await Promise.allSettled([
        api('/api/data/status'),
        api('/api/models'),
        api('/api/evaluations'),
        api('/api/history'),
      ]);
      const ok = (i, fb) => (results[i].status === 'fulfilled' && results[i].value ? results[i].value : fb);
      const d = ok(0, {});
      const m = ok(1, {});
      const ev = ok(2, {});
      const h = ok(3, {});
      const histList = Array.isArray(h) ? h : (h && Array.isArray(h.history) ? h.history : []);
      state.tutorialData = {
        wav: Number(d.wav_count) || 0,
        clean: Number(d.clean_count) || 0,
        models: Array.isArray(m.models) ? m.models.length : 0,
        evals: Array.isArray(ev.evaluations) ? ev.evaluations.length : 0,
        history: histList.length,
      };
    } catch (e) {
      /* 读不到就按全 0 处理 */
    }
  }

  function tutorialDone(stepId) {
    const d = state.tutorialData;
    switch (stepId) {
      case 'material': return d.wav > 0 && d.clean > 0;
      case 'qc': return d.clean > 0;
      case 'annotate': return d.clean > 0;
      case 'train': return d.models > 0;
      case 'eval': return d.evals > 0;
      case 'synth': return d.history > 0;
      default: return false;
    }
  }

  function currentTutorialStep() {
    for (const id of TUTORIAL_FLOW) {
      if (!tutorialDone(id)) return id;
    }
    return 'synth';
  }

  function renderTutorial() {
    if (!els.tutorialBody) return;
    const current = currentTutorialStep();
    els.tutorialBody.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'tutorial-hint';
    hint.textContent = TUTORIAL_HINT;
    els.tutorialBody.appendChild(hint);
    TUTORIAL_STEPS.forEach((s, i) => {
      const done = tutorialDone(s.id);
      const isCurrent = s.id === current;
      const row = document.createElement('div');
      row.className = 'tutorial-step' + (isCurrent ? ' is-current' : '') + (done && !isCurrent ? ' is-done' : '');

      const num = document.createElement('span');
      num.className = 't-step-num';
      num.textContent = String(i + 1);

      const body = document.createElement('div');
      body.className = 't-step-body';
      const title = document.createElement('div');
      title.className = 't-step-title';
      const titleText = document.createElement('span');
      titleText.textContent = s.title;
      title.appendChild(titleText);
      const mark = document.createElement('span');
      mark.className = 't-step-mark';
      mark.textContent = isCurrent ? '你现在在这里' : (done ? '已完成' : '');
      if (mark.textContent) title.appendChild(mark);
      const desc = document.createElement('div');
      desc.className = 't-step-desc';
      desc.textContent = s.desc;
      body.append(title, desc);

      const go = document.createElement('button');
      go.type = 'button';
      go.className = 't-step-go';
      go.textContent = '去这里';
      go.addEventListener('click', () => {
        closeTutorial();
        if (typeof switchView === 'function') switchView(s.view);
      });

      row.append(num, body, go);
      els.tutorialBody.appendChild(row);
    });
  }

  function openTutorial() {
    if (!els.tutorialPanel) return;
    els.tutorialPanel.classList.remove('hidden');
    els.tutorialBtn.setAttribute('aria-expanded', 'true');
    openSettings(false);
    refreshTutorialData().then(renderTutorial);
  }

  function closeTutorial() {
    if (!els.tutorialPanel) return;
    els.tutorialPanel.classList.add('hidden');
    els.tutorialBtn.setAttribute('aria-expanded', 'false');
  }

  // ---- 布局变量：对话框位置决定 BACKLOG / 面板高度，避免矮屏互相遮挡 ----
  function syncLayoutVars() {
    const dialog = document.querySelector('.dialog');
    if (!dialog) return;
    const r = dialog.getBoundingClientRect();
    // 非合成页对话框是隐藏的（rect 全 0）：保持上次的变量，避免教程按钮被顶出屏幕
    if (r.height < 10 || r.width < 10) return;
    const root = document.documentElement;
    root.style.setProperty('--dialog-top', Math.round(r.top) + 'px');
    root.style.setProperty('--content-left', Math.round(r.left) + 'px');
  }

  function drawerMode() {
    return document.body.classList.contains('compact-ui');
  }

  // 窄屏 / 矮屏进入紧凑模式：声の設定与设置改顶栏按钮 + 抽屉，历史也有入口
  function applyCompactUI() {
    const compact = window.innerWidth <= 860 || (window.innerWidth <= 1400 && window.innerHeight <= 790);
    document.body.classList.toggle('compact-ui', compact);
    if (!compact) {
      document.body.classList.remove('voice-open', 'history-open');
      if (els.voicePanelBtn) els.voicePanelBtn.setAttribute('aria-expanded', 'false');
      openSettings(false);
      syncDrawerScrim();
    }
    syncLayoutVars();
  }

  function syncDrawerScrim() {
    if (!els.drawerScrim) return;
    if (!drawerMode()) { els.drawerScrim.classList.add('hidden'); return; }
    const settingsOpen = els.settingsPanel && !els.settingsPanel.classList.contains('hidden');
    const show = settingsOpen || document.body.classList.contains('voice-open') || document.body.classList.contains('history-open');
    els.drawerScrim.classList.toggle('hidden', !show);
  }
  function openSettings(open) {
    if (!els.settingsPanel || !els.settingsBtn) return;
    els.settingsPanel.classList.toggle('hidden', !open);
    els.settingsBtn.setAttribute('aria-expanded', String(!!open));
    if (open) {
      document.body.classList.remove('voice-open', 'history-open');
      if (els.voicePanelBtn) els.voicePanelBtn.setAttribute('aria-expanded', 'false');
      if (els.historyBtn) els.historyBtn.setAttribute('aria-expanded', 'false');
    }
    syncDrawerScrim();
  }
  function toggleVoiceDrawer(open) {
    if (!els.voicePanel) return;
    const next = open === undefined ? !document.body.classList.contains('voice-open') : !!open;
    document.body.classList.toggle('voice-open', next);
    if (els.voicePanelBtn) els.voicePanelBtn.setAttribute('aria-expanded', String(next));
    if (next) {
      els.voicePanel.classList.remove('collapsed');
      if (els.voicePanelToggle) els.voicePanelToggle.setAttribute('aria-expanded', 'true');
      openSettings(false);
      document.body.classList.remove('history-open');
      toggleBacklog(false);
    }
    syncDrawerScrim();
  }
  function toggleHistoryDrawer(open) {
    if (!els.backlogDrawer) return;
    const next = open === undefined ? !document.body.classList.contains('history-open') : !!open;
    document.body.classList.toggle('history-open', next);
    if (els.historyBtn) els.historyBtn.setAttribute('aria-expanded', String(next));
    if (next) {
      openSettings(false);
      document.body.classList.remove('voice-open');
      if (els.voicePanelBtn) els.voicePanelBtn.setAttribute('aria-expanded', 'false');
      toggleBacklog(true);
    } else {
      toggleBacklog(false);
    }
    syncDrawerScrim();
  }
  function closeDrawers() {
    document.body.classList.remove('voice-open', 'history-open');
    if (els.voicePanelBtn) els.voicePanelBtn.setAttribute('aria-expanded', 'false');
    if (els.historyBtn) els.historyBtn.setAttribute('aria-expanded', 'false');
    if (els.settingsPanel) els.settingsPanel.classList.add('hidden');
    if (els.settingsBtn) els.settingsBtn.setAttribute('aria-expanded', 'false');
    closeTutorial();
    toggleBacklog(false);
    syncDrawerScrim();
  }

  // 轻量玻璃确认/输入框（替代原生 confirm/prompt，保持沉浸）
  function miniModal(opts) {
    return new Promise((resolve) => {
      const scrim = document.createElement('div');
      scrim.className = 'mini-modal-scrim';
      const box = document.createElement('div');
      box.className = 'mini-modal';
      const title = document.createElement('div');
      title.className = 'mini-modal-title';
      title.textContent = opts.title || '确认';
      const desc = document.createElement('div');
      desc.className = 'mini-modal-desc';
      desc.textContent = opts.desc || '';
      box.append(title, desc);
      let input = null;
      if (opts.input) {
        input = document.createElement('input');
        input.className = 'mini-modal-input';
        input.type = 'text';
        input.value = opts.value || '';
        input.setAttribute('aria-label', opts.title || '输入');
        box.appendChild(input);
      }
      const actions = document.createElement('div');
      actions.className = 'mini-modal-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn-secondary btn-sm';
      cancel.textContent = opts.cancelText || '取消';
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'btn-primary';
      ok.style.cssText = 'height:30px;padding:0 14px;font-size:13px;letter-spacing:.06em;clip-path:none;border-radius:9px;';
      ok.textContent = opts.okText || '确定';
      actions.append(cancel, ok);
      box.appendChild(actions);
      scrim.appendChild(box);
      document.body.appendChild(scrim);
      const close = (result) => {
        document.removeEventListener('keydown', onKey);
        scrim.remove();
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') close(null);
        else if (e.key === 'Enter' && (!input || document.activeElement === input || document.activeElement === ok)) close(input ? input.value : true);
      };
      cancel.addEventListener('click', () => close(null));
      ok.addEventListener('click', () => close(input ? input.value : true));
      scrim.addEventListener('click', (e) => { if (e.target === scrim) close(null); });
      document.addEventListener('keydown', onKey);
      setTimeout(() => { if (input) { input.focus(); input.select(); } else ok.focus(); }, 20);
    });
  }
  async function askConfirm(title, desc, okText) {
    const r = await miniModal({ title, desc, okText: okText || '确定' });
    return !!r;
  }
  async function askPrompt(title, desc, value) {
    const r = await miniModal({ title, desc, value, input: true, okText: '保存' });
    return r === null ? null : String(r);
  }

  function toggleBacklog(open) {
    if (!els.backlogDrawer || !els.backlogBody) return;
    const next = open === undefined ? els.backlogBody.classList.contains('hidden') : !!open;
    els.backlogBody.classList.toggle('hidden', !next);
    els.backlogDrawer.classList.toggle('open', next);
    if (els.backlogToggle) els.backlogToggle.setAttribute('aria-expanded', String(next));
  }

  function toggleVoicePanel() {
    if (!els.voicePanel || !els.voicePanelToggle) return;
    const collapsed = els.voicePanel.classList.toggle('collapsed');
    els.voicePanelToggle.setAttribute('aria-expanded', String(!collapsed));
  }

  // ---------- 页面切换（左侧导航）----------
  const VIEW_NAMES = ['synth', 'train', 'eval', 'material', 'qc', 'annotation'];
  const VIEW_TITLES = {
    synth: '语音合成', train: '训练模型', eval: '评测打分',
    material: '素材', qc: '质检', annotation: '标注',
  };
  // 菜单顺序（决定转场方向）：01 合成 → 02 素材 → 03 质检 → 04 标注 → 05 训练 → 06 评测
  const MENU_ORDER = ['synth', 'material', 'qc', 'annotation', 'train', 'eval'];

  function navButtons() {
    return document.querySelectorAll('.side-nav-item[data-view], .flow-step[data-view]');
  }

  function switchView(name) {
    if (!VIEW_NAMES.includes(name)) name = 'synth';
    const prev = state.view;
    // 同页再点：只做轻微 pulse，不再触发转场/重复渲染
    if (prev === name) {
      pulseNav(name);
      const box0 = document.getElementById('contentScroll');
      try { if (box0) box0.scrollTop = 0; } catch (e) { /* 忽略 */ }
      closeDrawers();
      return;
    }
    state.view = name;
    hideError();
    VIEW_NAMES.forEach((v) => {
      const el = document.getElementById('view-' + v);
      if (!el) return;
      if (v === name) el.classList.remove('hidden');
      else el.classList.add('hidden');
    });
    navButtons().forEach((b) => {
      const on = b.dataset.view === name;
      b.classList.toggle('current', on);
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    // 激活胶囊平滑滑到新 item
    moveNavCapsule(!!prev && motionEnabled());
    // 顶栏页面标题：首屏直接设置；切换时由 playViewTransition 做淡出/滑入
    const title = VIEW_TITLES[name] || '语音合成';
    const pageTitle = document.getElementById('pageTitle');
    if (!prev && pageTitle) pageTitle.textContent = title;
    try {
      history.replaceState(null, '', '#' + name);
    } catch (e) {
      /* file:// 下可能不支持，忽略 */
    }
    // 切页数据加载：等转场扫完再加载，避免 370 行列表渲染卡住动画
    // 素材页保留旧列表先显示、稍后再静默刷新，兼顾首屏与转场帧率
    const deferPageLoad = (fn, delay) => {
      if (!motionEnabled()) { fn(); return; }
      setTimeout(fn, delay || 300);
    };
    if (name === 'train') {
      deferPageLoad(() => {
        loadTrainData();
        refreshTrainStatus();
        updateDataStatus();
        resumeDataJob();
      });
    }
    if (name === 'material') {
      // 旧列表已渲染在 DOM 里（切走只是 hidden），回来不会空白；
      // 只在还没加载过时拉数据，避免每次切页重渲染 370 行卡住转场
      deferPageLoad(() => {
        if (!materialFiles.length) loadMaterials();
        updateDataStatus();
        resumeDataJob();
      }, 450);
    }
    if (name === 'qc') deferPageLoad(loadQcReport);
    if (name === 'annotation') deferPageLoad(loadAnnotations);
    if (name === 'eval') {
      deferPageLoad(() => {
        loadEvalTarget();
        loadEvalHistory();
      });
    }
    if (name === 'synth') {
      deferPageLoad(() => {
        loadRefs();
        loadTheme();   // 切回合成页恢复自定义图片状态
      });
    }
    try { document.title = title + ' · AkiBurger Voice'; } catch (e) { /* 忽略 */ }
    // 外壳：body[data-view] 控制对话框/浮层显隐；背景表情回 idle；内容交叉淡入转场
    document.body.dataset.view = name;
    setCharacter(name === 'synth' && state.inFlight ? 'thinking' : 'idle');
    if (prev) playViewTransition(prev, name, title);
    closeDrawers();
    if (els.batchPanel && !els.batchPanel.classList.contains('hidden')) {
      els.batchPanel.classList.add('hidden');
      document.body.classList.remove('batch-open');
    }
    requestAnimationFrame(syncLayoutVars);
    // 内容区滚动复位（新布局里滚动容器是 #contentScroll，不再是 window）
    const scrollBox = document.getElementById('contentScroll');
    try {
      if (scrollBox) scrollBox.scrollTop = 0;
      else window.scrollTo(0, 0);
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 工具 ----------
  const FIELD_CN = {
    epochs_s2: '音色模型轮数', epochs_s1: '韵律模型轮数',
    batch_s2: '音色批量', batch_s1: '韵律批量',
    save_every_s2: '音色保存间隔', save_every_s1: '韵律保存间隔',
    lr_s2: '音色学习率', lr_s1: '韵律学习率',
    temperature: '稳定度', seed: '随机种子', text: '台词',
    tone: '语气', lang: '输出语言', input_lang: '输入语言',
    voice: '音色', ref: '参考音频', path: '文件夹路径', name: '名称',
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(path, options) {
    let res;
    try {
      res = await fetch(path, options);
    } catch (e) {
      // fetch 本身失败 = 后端服务连不上（AbortError 除外，交给调用方判断）
      if (e && e.name === 'AbortError') throw e;
      const err = new Error('连不上后端服务，请确认后端还在运行');
      err.status = 0;
      err.network = true;
      throw err;
    }
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try {
        const body = await res.json();
        if (body && (body.message || body.detail)) {
          if (typeof body.detail === 'string') {
            msg = body.detail;
          } else if (Array.isArray(body.detail) && body.detail.length) {
            // FastAPI 422：detail 是数组，取第一条的 msg，字段名映射成中文
            const first = body.detail[0] || {};
            msg = String(first.msg || body.message || msg);
            const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : '';
            if (field) {
              const cn = FIELD_CN[field] || field;
              msg = msg.split(String(field)).join(cn);
              if (msg.indexOf(cn) < 0) msg = cn + '：' + msg;
            }
          } else {
            msg = body.message || msg;
          }
        }
      } catch (e) { /* 非 JSON 响应 */ }
      if (res.status === 429) {
        // 后端在跑别的合成：给中文提示，调用方可以按 429 退避
        msg = '引擎正忙（429），请稍等片刻再试';
      }
      const err = new Error(msg);
      err.status = res.status;   // 调用方可以按状态码给出不同提示
      throw err;
    }
    return res.json();
  }

  // 合成按钮可用态：引擎在、不在合成/评测中、且台词非空
  function updateSynthButtonState() {
    if (!els.synthBtn) return;
    const hasText = !!(els.textInput && els.textInput.value.trim());
    const busy = state.inFlight || state.evalRunning || state.synthIdleWait;
    els.synthBtn.disabled = !state.engineUp || busy || !hasText;
    els.synthBtn.classList.toggle('needs-text', state.engineUp && !busy && !hasText);
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
    updateSynthButtonState();
    els.batchToggleBtn.disabled = !up;
    els.previewBtn.disabled = !up;
    if (els.evalBtn) els.evalBtn.disabled = !up || state.evalRunning;
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
      // 自定义图片：启动时恢复状态（接口 404 时内部静默降级）
      loadTheme();
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
      // 音色列表刷新后重算预设里的「音色已失效」标签
      try { renderPresets(); } catch (e) { /* 预设列表异常不影响音色 */ }
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
      // 后端返回 {"history": [...], "total": N}，兼容纯数组
      const list = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.history) ? resp.history : []);
      const total = Array.isArray(resp) ? list.length : (resp && (resp.total ?? resp.total_count));
      renderHistory(list, total);
    } catch (e) {
      renderHistory([]);
    }
  }

  // ---------- 参考音频（自动 / 指定某条历史结果） ----------
  const REF_KEY = 'abv:ref';

  function savedRef() {
    try { return localStorage.getItem(REF_KEY) || ''; } catch (e) { return ''; }
  }

  function saveRefChoice() {
    try { localStorage.setItem(REF_KEY, currentRef()); } catch (e) { /* 记不住不影响使用 */ }
  }

  function currentRef() {
    return (els.refSelect && els.refSelect.value) || '';
  }

  // 文件名去掉 .wav，界面里更干净
  function refLabel(name) {
    return String(name || '').replace(/\.wav$/i, '');
  }

  // 结果音频地址 -> 历史时间戳（/static/output/<time>/full.wav）
  function historyTimeFromUrl(url) {
    if (!url) return '';
    const m = String(url).match(/\/output\/(\d{8}_\d{6})\//);
    return m ? m[1] : '';
  }

  function updateRefHint() {
    if (!els.refHint) return;
    const base = '自动：按语气从素材里挑参考；指定：固定用这条参考。';
    els.refHint.textContent = currentRef()
      ? base + ' 当前已指定参考，语气不再自动切换参考音频。'
      : base;
  }

  function renderRefOptions(list, selected) {
    const sel = els.refSelect;
    if (!sel) return;
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动（按语气挑选）';
    sel.appendChild(auto);
    for (const r of list) {
      if (!r || !r.name) continue;
      const opt = document.createElement('option');
      opt.value = r.name;
      const bits = [];
      if (r.tone) bits.push(r.tone);
      if (r.duration != null && isFinite(Number(r.duration))) {
        bits.push(Number(r.duration).toFixed(1) + 's');
      }
      opt.textContent = refLabel(r.name) + (bits.length ? '（' + bits.join(' · ') + '）' : '');
      if (r.text) opt.title = r.text;
      opt.dataset.source = r.source || '';
      sel.appendChild(opt);
    }
    // 恢复上次选择；已不存在的参考回落到「自动」
    const want = selected || savedRef() || '';
    const exists = Array.prototype.some.call(sel.options, (o) => o.value === want);
    sel.value = exists ? want : '';
    sel.disabled = false;
    saveRefChoice();
    updateRefHint();
  }

  // prefer：刷新后希望选中的参考（比如刚保存的那条）
  async function loadRefs(prefer) {
    if (!els.refSelect) return;
    const keep = prefer || currentRef() || savedRef() || '';
    try {
      const resp = await api('/api/refs');
      const list = resp && Array.isArray(resp.refs) ? resp.refs : [];
      state.refs = list;
      renderRefOptions(list, keep);
    } catch (e) {
      // 接口还没就绪或网络抖动：静默降级成只有「自动」，不影响合成
      if (!state.refs || state.refs.length === 0) {
        renderRefOptions([], '');
      } else {
        renderRefOptions(state.refs, keep);
      }
    }
  }

  // 把历史里的某条合成结果固化成参考音频
  async function setRefFromHistory(time, confirmText) {
    if (!time) {
      showError('还不能设为参考', '这条记录没有对应的音频文件。');
      return false;
    }
    const ok = await askConfirm('设为参考音频？', confirmText || '把这条合成语音设为参考音频？保存后可在「声の設定 → 参考音频」里指定，也可以随预设一起保存。', '设为参考');
    if (!ok) return false;
    try {
      const res = await api('/api/ref/from-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time }),
      });
      if (!res || !res.ok || !res.ref) throw new Error((res && res.message) || '没有返回参考信息');
      const name = (res.ref && res.ref.name) || '';
      await loadRefs(name);
      const msg = name ? '已设为参考音频「' + refLabel(name) + '」' : '已设为参考音频';
      showToast(res.warning ? msg + '；' + res.warning : msg);
      return true;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/not found/i.test(msg) && !/[\u4e00-\u9fa5]/.test(msg)) {
        // 后端接口还没上线
        showToast('暂时还不能设为参考，等这个功能就绪后再试。');
      } else {
        showError('设为参考失败', msg);
      }
      return false;
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
    updateSynthButtonState();
  }

  // ---------- 语气 ----------
  function setTone(tone) {
    state.tone = tone;
    els.toneBtns.forEach((b) => {
      const on = b.dataset.tone === tone;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    if (els.speakerTone) els.speakerTone.textContent = tone === 'auto' ? '自动' : tone;
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
    setCharacter('thinking');
    els.synthBtn.disabled = true;
    els.synthBtn.querySelector('.btn-label').textContent = '合成中…';
    els.synthProgress.classList.remove('hidden');
    syncLayoutVars();
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
          seed: state.seed, temperature: state.temperature, ref: currentRef(),
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

      // 随机模式下，把这次实际用的种子回显并同步 state（显示值 = 下次实际用值）
      const seedUsed = res.seed_used !== undefined ? res.seed_used : res.seed;
      if (seedUsed !== undefined && seedUsed !== -1) {
        setSeed(seedUsed);
      }

      state.currentAudioUrl = res.audio_url;
      els.resultAudio.src = res.audio_url;
      pushABResult(res.audio_url);      // 记录最近两次结果，供 A/B 对比
      loadWaveform(res.audio_url);      // 绘制波形
      els.downloadLink.href = res.audio_url;
      // 下载文件名带时间戳，避免每次都叫 full.wav
      els.downloadLink.download = 'voice_' + downloadStamp(new Date()) + '.wav';
      els.resultSection.classList.remove('hidden');
      els.resultSection.classList.remove('is-new');
      void els.resultSection.offsetWidth;
      els.resultSection.classList.add('is-new');
      setTimeout(() => els.resultSection.classList.remove('is-new'), 320);
      setCharacter('happy');
      if (els.setRefBtn) els.setRefBtn.disabled = false;
      // 结果在对话框上方：聚焦+确保可见，避免用户点完看不到
      try {
        els.resultSection.scrollIntoView({ block: 'nearest' });
        els.resultSection.focus({ preventScroll: true });
      } catch (e) { /* 忽略 */ }

      const segs = Array.isArray(res.segments) ? res.segments.length : 0;
      els.resultMeta.textContent =
        (res.lang ? res.lang.toUpperCase() + ' · ' : '') +
        (res.tone ? res.tone + ' · ' : '') +
        (segs > 1 ? '文本分 ' + segs + ' 段 · ' : '') +
        '耗时 ' + (res.elapsed_ms != null ? (res.elapsed_ms / 1000).toFixed(1) : (elapsed / 1000).toFixed(1)) + ' 秒' +
        (res.ref_used ? ' · 参考 ' + refLabel(res.ref_used) : '');

      loadHistory(); // 刷新历史
      // 新结果自动播放前，先停掉其它正在响的（历史/批量/试听），避免同时出声
      stopAll(els.resultAudio);
      setTimeout(() => els.resultAudio.play().catch(() => {}), 100);
    } catch (e) {
      showError('合成失败', String(e.message || e));
    } finally {
      state.inFlight = false;
      els.synthBtn.querySelector('.btn-label').textContent = '合成';
      els.synthProgress.classList.add('hidden');
      updateSynthButtonState();
      syncLayoutVars();
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
    const ok = await askConfirm('删除这段素材？', '素材会移到回收站，可以点「恢复删除」找回。', '删除');
    if (!ok) return;
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
    const ok = await askConfirm('清空所有已导入素材？', '素材会移到回收站（不是真删），之后可以点「恢复删除」找回。', '全部清空');
    if (!ok) return;
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
      state.annCount = d.count;
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
    const query = ((els.annSearch && els.annSearch.value) || '').trim().toLowerCase();
    if (query) entries = entries.filter((e) => String(e.name || '').toLowerCase().includes(query));
    if (els.annCount) els.annCount.textContent = query ? `匹配 ${entries.length} / 共 ${(annLastData.entries || []).length} 条` : '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'eval-detail-empty';
      empty.textContent = query ? '没有匹配的文件名' : '没有符合条件的条目。';
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
          // 只更新这一行 + 明确 toast，不整表重绘（避免列表闪一下、toast 被冲掉）
          e.text = input.value;
          e.text_len = [...input.value].length;
          save.textContent = '已保存';
          showToast('已保存：' + e.name, 2800);
          setTimeout(() => { save.textContent = '保存'; save.disabled = false; }, 1200);
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

  function showToast(msg, ms) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('show'), ms || 2400);
  }

  async function browseFolder() {
    if (!els.browseBtn) return;
    const oldHtml = els.browseBtn.innerHTML;
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
      if (els.browseHint) els.browseHint.textContent = '打开选择框失败：' + friendlyError(e.message || e);
    } finally {
      els.browseBtn.disabled = false;
      els.browseBtn.innerHTML = oldHtml;  // 保留图标，不要被 textContent 吃掉
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
    setCharacter('thinking');
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
    setCharacter('thinking');
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
        if (j.kind) setCharacter('thinking');
        dataJobTimer = setTimeout(pollDataJob, 2000);
      } else {
        setDataJobBusy(false);
        if (j.kind) setCharacter(j.error ? 'sad' : 'happy');
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
        if (!ui.trainRunning) { ui.trainRunning = true; setCharacter('thinking'); }
        if (!trainTimer) trainTimer = setInterval(refreshTrainStatus, 5000);
      } else if (trainTimer) {
        if (ui.trainRunning) {
          ui.trainRunning = false;
          setCharacter(st.success === false ? 'sad' : 'happy');
        }
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
    setCharacter('thinking');
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
    if (!els.evalBtn || state.evalRunning) return;
    state.evalRunning = true;
    const btnHtml = els.evalBtn.innerHTML;
    els.evalBtn.disabled = true;
    els.evalBtn.textContent = '评测中…';
    els.evalProgress.classList.remove('hidden');
    if (els.evalBar) els.evalBar.style.width = '0%';
    setCharacter('thinking');
    if (els.evalResult) els.evalResult.classList.add('hidden');
    els.evalProgressText.textContent = '正在准备评测…';
    // 评测期间合成 CTA 禁用并说明原因
    if (els.synthBtn) {
      const lab = els.synthBtn.querySelector('.btn-label');
      if (lab) lab.textContent = '评测中…';
      els.synthBtn.disabled = true;
    }
    const startedAt = Date.now();
    const progressTimer = setInterval(async () => {
      try {
        const st = await api('/api/eval/status');
        const p = (st && st.progress) || {};
        if (p && p.total > 0) {
          const cur = Math.min(p.total, p.current || 0);
          const pct = p.percent != null ? Math.round(p.percent) : Math.round((cur / p.total) * 100);
          els.evalProgressText.textContent = `第 ${cur}/${p.total} 句 · ${pct}%`;
          if (els.evalBar) els.evalBar.style.width = pct + '%';
        } else if (st && st.stage) {
          els.evalProgressText.textContent = st.stage;
        }
      } catch (e) { /* 状态拿不到就退回时间提示 */ }
      if (!/^第 /.test(els.evalProgressText.textContent || '')) {
        const sec = Math.round((Date.now() - startedAt) / 1000);
        els.evalProgressText.textContent = `正在评测…已用 ${sec} 秒（约 1.5 分钟）`;
      }
    }, 1200);
    try {
      const res = await api('/api/evaluate', { method: 'POST' });
      if (!res || !res.ok || !res.result) throw new Error('评测没有返回结果');
      renderEvalResult(res.result);
      await loadEvalHistory();
      setCharacter('happy');
    } catch (e) {
      showError('评测失败', String(e.message || e));
      setCharacter('sad');
    } finally {
      clearInterval(progressTimer);
      els.evalProgress.classList.add('hidden');
      els.evalBtn.innerHTML = btnHtml;
      els.evalBtn.disabled = !state.engineUp;
      state.evalRunning = false;
      if (els.synthBtn) {
        const lab = els.synthBtn.querySelector('.btn-label');
        if (lab) lab.textContent = '合成';
        updateSynthButtonState();
      }
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
    const refTag = document.createElement('span');
    refTag.className = 'history-tag';
    refTag.textContent = p.ref ? '参考：' + refLabel(p.ref) : '参考：自动';
    if (p.ref) refTag.title = refLabel(p.ref);
    meta.append(voiceTag, langTag, toneTag, refTag);

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

  async function applyPreset(p) {
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
    // 参考音频：列表可能还没加载，先刷一次再判断；原参考被删了就回落到「自动」
    if (els.refSelect) {
      if (p.ref && els.refSelect.options.length <= 1) await loadRefs();
      const want = p.ref || '';
      const exists = !!want && Array.prototype.some.call(els.refSelect.options, (o) => o.value === want);
      els.refSelect.value = exists ? want : '';
      saveRefChoice();
      updateRefHint();
      els.textInput.focus();
      if (want && !exists) {
        showToast('已套用预设；原来的参考音频已不存在，已改用「自动」');
        return;
      }
    }
    els.textInput.focus();
    showToast('已套用预设「' + (p.name || '') + '」');
  }

  function saveCurrentPreset() {
    const list = getPresets();
    const defName = '预设 ' + (list.length + 1);
    askPrompt('保存当前设置为预设', '给这个预设起个名字（留空用时间命名）', defName).then((input) => {
      if (input === null) return;   // 取消
      let name = (input || '').trim();
      if (!name) name = '预设 ' + new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const preset = {
        name,
        voice: els.voiceSelect.value || '',
        ref: currentRef(),
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
      showToast('预设已保存', 2600);
    });
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
  let batchStopped = false;
  let batchAbort = null;

  // 后端合成状态（task-24 提供 /api/synth/status；暂时 404 时用保守等待兜底）
  async function waitSynthIdle(timeoutMs) {
    const limit = timeoutMs || 120000;
    const t0 = Date.now();
    let probed = false;
    let apiMissing = false;
    while (Date.now() - t0 < limit) {
      let st = null;
      if (!apiMissing && !probed) {
        probed = true;
        try {
          st = await api('/api/synth/status');
        } catch (e) {
          // 后端还没上线该接口（404）：只探一次，避免刷一屏 404，改走保守等待
          if (e && (e.status === 404 || e.status === 0)) apiMissing = true;
        }
      } else if (!apiMissing) {
        try { st = await api('/api/synth/status'); } catch (e) { st = null; }
      }
      if (st) {
        const busy = st.busy === true || st.running === true || st.in_flight === true ||
          (st.current && (st.current.running === true || st.current.busy === true));
        if (!busy) return true;
      } else if (apiMissing && Date.now() - t0 >= 6000) {
        // 后端还没有 /api/synth/status：保守等 6s（覆盖单句合成耗时），再靠 429 退避兜底
        return true;
      }
      await sleep(500);
    }
    return false;
  }

  // 批量单句请求：429 时按 800ms / 1600ms 退避重试，最多 2 次
  async function synthOneWithRetry(payload, signal) {
    let lastErr = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        return await api('/api/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify(payload),
        });
      } catch (e) {
        lastErr = e;
        if (e && e.status === 429 && attempt < 2 && batchRunning) {
          await sleep(800 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error('合成失败');
  }

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
    batchStopped = false;
    els.batchStartBtn.disabled = true;
    els.batchStopBtn.classList.remove('hidden');
    els.batchStopBtn.disabled = false;
    els.batchResults.classList.remove('hidden');
    els.batchResults.innerHTML = '';
    if (els.synthBtn) els.synthBtn.disabled = true;

    for (let i = 0; i < items.length; i++) {
      if (!batchRunning) break;
      const item = items[i];
      const { row, status } = buildBatchItem(i, item);
      els.batchResults.appendChild(row);
      status.textContent = '合成中…';
      batchAbort = new AbortController();
      try {
        const res = await synthOneWithRetry({
          text: item.text, lang: state.lang, input_lang: state.inputLang, voice,
          tone: item.tone, seed: state.seed, temperature: state.temperature, ref: currentRef(),
        }, batchAbort.signal);
        if (res && res.ok && res.audio_url) {
          status.innerHTML = iconHtml('check') + ' 完成';
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
          status.innerHTML = iconHtml('alert-triangle') + ' 失败：' + friendlyError(String(e.message || e)).slice(0, 70);
          status.className = 'batch-status fail';
        }
      }
    }

    batchRunning = false;
    batchAbort = null;
    els.batchStopBtn.classList.add('hidden');
    if (batchStopped) {
      // 停止只是中止前端请求，服务端可能还在跑：等它空闲再允许重开
      els.batchStartBtn.disabled = true;
      els.batchStartBtn.textContent = '等待引擎空闲…';
      state.synthIdleWait = true;
      updateSynthButtonState();
      await waitSynthIdle();
      state.synthIdleWait = false;
    }
    els.batchStartBtn.textContent = '开始逐句合成';
    els.batchStartBtn.disabled = !state.engineUp;
    updateSynthButtonState();
    loadHistory();
  }

  // ---------- 历史 ----------
  function syncHistoryCounts() {
    if (!els.historyList) return;
    const n = els.historyList.querySelectorAll('.history-item').length;
    if (els.historyEmpty) els.historyEmpty.hidden = n > 0;
    if (els.clearHistoryBtn) els.clearHistoryBtn.hidden = n === 0;
    if (els.backlogCount) els.backlogCount.textContent = String(n);
  }

  function renderHistory(list, total) {
    const totalN = Number.isFinite(Number(total)) ? Number(total) : list.length;
    els.historyEmpty.hidden = list.length > 0;
    els.historyList.querySelectorAll('.history-item').forEach((n) => n.remove());
    // 「清空历史」按钮：有记录时才显示
    if (els.clearHistoryBtn) els.clearHistoryBtn.hidden = totalN === 0;
    if (els.backlogCount) els.backlogCount.textContent = String(totalN);
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

    // 设为参考音频（右键边上的图标按钮）
    const refBtn = document.createElement('button');
    refBtn.type = 'button';
    refBtn.className = 'history-ref';
    setIcon(refBtn, 'star');
    refBtn.title = '设为参考音频';
    refBtn.setAttribute('aria-label', '设为参考音频');
    refBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setRefFromHistory(item.time,
        '把这条合成语音设为参考音频？\n保存后可以在「模型 → 参考音频」里指定，也可以随预设一起保存。');
    });

    // 删除这一条
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-del';
    setIcon(del, 'trash-2');
    del.title = '删除这条记录';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await askConfirm('删除这条记录？', '音频文件也会一起删掉，无法恢复。', '删除');
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
        syncHistoryCounts();
      } catch (err) {
        del.disabled = false;
        showError('删除失败', String(err.message || err));
      }
    });

    row.append(play, body, refBtn, dl, del);

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
  function friendlyError(desc) {
    let d = String(desc == null ? '' : desc);
    if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(d)) d = '连不上后端服务，请确认后端还在运行';
    if (/429/.test(d) && !/引擎正忙/.test(d)) d = '引擎正忙（429），请稍等片刻再试';
    // 422 英文字段/句子兜底：常见字段直译
    d = d.replace(/epochs_s2/g, '音色模型轮数').replace(/epochs_s1/g, '韵律模型轮数')
      .replace(/batch_s2/g, '音色批量').replace(/batch_s1/g, '韵律批量')
      .replace(/save_every_s2/g, '音色保存间隔').replace(/save_every_s1/g, '韵律保存间隔')
      .replace(/lr_s2/g, '音色学习率').replace(/lr_s1/g, '韵律学习率')
      .replace(/String should match pattern.*$/i, '路径格式不对')
      .replace(/Field required/gi, '必填项缺了');
    return d;
  }

  function showError(title, desc) {
    const text = friendlyError(desc);
    els.errorBox.classList.remove('hidden');
    els.errorTitle.textContent = title;
    els.errorDesc.textContent = text;
    setCharacter('sad');
    // 合成页：错误面板在对话框上方，聚焦+滚到可见，并额外 toast，避免"点了没反应"
    if (state.view === 'synth') {
      try {
        els.errorBox.scrollIntoView({ block: 'nearest' });
        els.errorBox.focus({ preventScroll: true });
      } catch (e) { /* 忽略 */ }
    }
    // 错误框在合成页里，别的页面出错也要弹提示（非合成页给足 5 秒阅读时间）
    showToast(title + '：' + text, state.view === 'synth' ? 2600 : 5000);
  }
  function hideError() {
    els.errorBox.classList.add('hidden');
  }

  // ---------- 事件绑定 ----------
  els.langBtns.forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  els.inLangBtns.forEach((b) => b.addEventListener('click', () => setInputLang(b.dataset.lang)));
  updateLangNote();

  els.toneBtns.forEach((b) => b.addEventListener('click', () => {
    // 语气只更新选中态与 speakerTone；surprised 只留给切模型/参考
    setTone(b.dataset.tone);
  }));

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

  // ---------- v4 外壳：设置 / 声の設定折叠 / BACKLOG 抽屉 ----------
  if (els.settingsBtn) {
    els.settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSettings(els.settingsPanel.classList.contains('hidden'));
    });
    document.addEventListener('click', (e) => {
      if (!els.settingsPanel || els.settingsPanel.classList.contains('hidden')) return;
      if (els.settingsPanel.contains(e.target) || els.settingsBtn.contains(e.target)) return;
      openSettings(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDrawers();
    });
  }

  // ---------- 自定义图片：上传 / 恢复默认 ----------
  function bindThemeSlot(slot, uploadBtn, resetBtn, fileInput) {
    if (!uploadBtn || !resetBtn || !fileInput) return;
    uploadBtn.addEventListener('click', () => {
      // 每次点击都重置 input，让用户能重新选同一张图
      fileInput.value = '';
      fileInput.click();
    });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      uploadTheme(slot, f);
    });
    resetBtn.addEventListener('click', () => resetTheme(slot));
  }
  bindThemeSlot('bg', els.bgUploadBtn, els.bgResetBtn, els.bgFileInput);
  bindThemeSlot('char', els.charUploadBtn, els.charResetBtn, els.charFileInput);

  // ---------- 教程：开/关/点外关闭 ----------
  if (els.tutorialBtn) {
    els.tutorialBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (els.tutorialPanel.classList.contains('hidden')) openTutorial();
      else closeTutorial();
    });
    if (els.tutorialCloseBtn) {
      els.tutorialCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTutorial();
      });
    }
    document.addEventListener('click', (e) => {
      if (!els.tutorialPanel || els.tutorialPanel.classList.contains('hidden')) return;
      if (els.tutorialPanel.contains(e.target) || els.tutorialBtn.contains(e.target)) return;
      closeTutorial();
    });
  }

  if (els.voicePanelBtn) {
    els.voicePanelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleVoiceDrawer();
    });
  }
  if (els.historyBtn) {
    els.historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHistoryDrawer();
    });
  }
  if (els.drawerScrim) {
    els.drawerScrim.addEventListener('click', closeDrawers);
  }
  const skipLink = document.querySelector('.skip-link');
  if (skipLink) {
    skipLink.addEventListener('click', (e) => {
      e.preventDefault();
      const box = document.getElementById('contentScroll');
      if (box) {
        box.setAttribute('tabindex', '-1');
        box.focus({ preventScroll: true });
        box.scrollTop = 0;
      }
    });
  }
  window.addEventListener('resize', () => {
    applyCompactUI();
    syncDrawerScrim();
    syncLayoutVars();
    moveNavCapsule(false);
  });
  if (els.motionToggle) {
    els.motionToggle.addEventListener('change', () => {
      try { localStorage.setItem('abv:motion', els.motionToggle.checked ? '1' : '0'); } catch (e) { /* 忽略 */ }
      applyDisplaySettings();
    });
  }
  if (els.charToggle) {
    els.charToggle.addEventListener('change', () => {
      try { localStorage.setItem('abv:char', els.charToggle.checked ? '1' : '0'); } catch (e) { /* 忽略 */ }
      applyDisplaySettings();
      if (els.charToggle.checked) setCharacter('idle');
    });
  }
  if (els.voicePanelToggle) els.voicePanelToggle.addEventListener('click', toggleVoicePanel);
  if (els.backlogToggle) els.backlogToggle.addEventListener('click', () => toggleBacklog());

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
  if (els.annSearch) {
    els.annSearch.addEventListener('input', () => renderAnnotations(state.annFilter || 'all'));
  }
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
    // input 也同步，避免用户改完直接点合成（change 还没触发）
    els.seedInput.addEventListener('change', () => setSeed(els.seedInput.value));
    els.seedInput.addEventListener('input', () => setSeed(els.seedInput.value));
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
    if (els.setRefBtn) els.setRefBtn.disabled = true;
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
      const ok = await askConfirm('清空全部历史记录？', '所有合成音频都会被删除，无法恢复。', '全部清空');
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
    const open = els.batchPanel.classList.toggle('hidden');
    document.body.classList.toggle('batch-open', !open);
    if (!open) {
      updateBatchCount();
      els.batchInput.focus();
      syncLayoutVars();
    }
  });

  els.batchInput.addEventListener('input', updateBatchCount);
  els.batchStartBtn.addEventListener('click', startBatch);
  els.batchStopBtn.addEventListener('click', () => {
    if (!batchRunning) return;
    batchStopped = true;
    batchRunning = false;
    if (batchAbort) batchAbort.abort();
    els.batchStartBtn.disabled = true;
    els.batchStartBtn.textContent = '等待引擎空闲…';
    els.batchStopBtn.disabled = true;
    showToast('已停止，等待引擎空闲后可重新开始…', 3000);
  });

  els.voiceSelect.addEventListener('change', () => {
    if (els.voiceSelect.value) {
      // 记不住选择不影响使用，localStorage 不可用时静默跳过
      try { localStorage.setItem('abv:voice', els.voiceSelect.value); } catch (e) { /* 忽略 */ }
      // 质检/标注对应的是数据本身，换模型不影响，不要清
      updateModelBadges();
      setCharacter('surprised');
    }
  });

  // 参考音频选择：记住选择并更新提示
  if (els.refSelect) {
    els.refSelect.addEventListener('change', () => {
      saveRefChoice();
      updateRefHint();
      setCharacter('surprised');
    });
  }

  // 结果区「设为参考」：从当前结果音频地址里取历史时间戳
  if (els.setRefBtn) {
    els.setRefBtn.addEventListener('click', () => {
      const time = historyTimeFromUrl(state.currentAudioUrl);
      if (!time) {
        showError('还不能设为参考', '先合成一条结果，再把它设为参考。');
        return;
      }
      setRefFromHistory(time,
        '把这次合成结果设为参考音频？\n保存后可以在「模型 → 参考音频」里指定，也可以随预设一起保存。');
    });
  }

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

  // 浏览器前进/后退切页（#main / #contentScroll 是 skip link，不算页面）
  window.addEventListener('hashchange', () => {
    const name = location.hash.replace('#', '');
    if (VIEW_NAMES.includes(name) && name !== state.view) switchView(name);
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
  applyCompactUI();
  updateMeta();
  renderPresets();
  applyDisplaySettings();
  initScenes();
  preloadScenes();
  setTone('auto');
  // 对话框高度变化时同步布局变量（进度条/批量/预设面板都依赖它）
  const dialogEl = document.querySelector('.dialog');
  if (dialogEl && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => syncLayoutVars()).observe(dialogEl);
  }
  syncLayoutVars();
  updateSynthButtonState();
  // 字体加载后胶囊位置可能变，重新对齐一次
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => moveNavCapsule(false));
  window.addEventListener('load', () => moveNavCapsule(false));
  // 顶部标签切换
  document.querySelectorAll('.side-nav-item[data-view], .flow-step[data-view]').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });
  // 直接带 #train / #eval 打开也能定位
  const initialView = (location.hash || '#synth').slice(1);
  switchView(VIEW_NAMES.includes(initialView) ? initialView : 'synth');

  boot();

  // 教程：首次打开自动弹一次，之后只点按钮才开
  try {
    if (!localStorage.getItem('abv:tutorialSeen')) {
      localStorage.setItem('abv:tutorialSeen', '1');
      setTimeout(() => openTutorial(), 900);
    }
  } catch (e) { /* localStorage 不可用时跳过自动弹出 */ }
})();
