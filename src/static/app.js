/* ============================================================
   AkiBurger Voice · 合成台 前端逻辑
   后端契约（见 README / 后端同事）：
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

  // ---------- 状态 ----------
  const state = {
    lang: 'ja',               // 输出语言
    inputLang: 'zh',          // 我输入的语言（默认中文：中文进、日文出）
    tone: 'auto',
    voices: [],
    currentAudioUrl: null,
    engineUp: false,
    currentAudio: null,       // 当前正在播放的音频（全局只响一个）
    qcFilter: 'all',
    annFilter: 'all',
    datasetSnapshot: '',      // 上次的数据指纹，变了就清空质检/标注结果
    currentHistoryUrl: null,
    temperature: 0.9,         // 音质微调：越低越稳
    seed: -1,                 // -1 = 每次随机
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
    previewAudio: $('previewAudio'),
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

  // ---------- 页面切换（顶部标签）----------
  const VIEW_NAMES = ['synth', 'train', 'eval', 'material', 'qc', 'annotation'];

  function switchView(name) {
    if (!VIEW_NAMES.includes(name)) name = 'synth';
    VIEW_NAMES.forEach((v) => {
      const el = document.getElementById('view-' + v);
      if (el) el.classList.toggle('hidden', v !== name);
    });
    document.querySelectorAll('.flow-step[data-view]').forEach((b) => {
      b.classList.toggle('current', b.dataset.view === name);
    });
    try {
      history.replaceState(null, '', '#' + name);
    } catch (e) {
      /* file:// 下可能不支持，忽略 */
    }
    if (name === 'train') {
      loadTrainData();
      refreshTrainStatus();
      updateDataStatus();
    }
    if (name === 'material') { loadMaterials(); updateDataStatus(); }
    if (name === 'qc') { loadQcReport(); }
    if (name === 'annotation') { loadAnnotations(); }
    if (name === 'eval') {
      loadEvalTarget();
      loadEvalHistory();
    }
    const TITLES = { synth: '语音合成', train: '训练模型', eval: '评测打分', material: '素材', qc: '质检', annotation: '标注' };
    try { document.title = (TITLES[name] || '语音合成') + ' · AkiBurger Voice'; } catch (e) {}
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
  }

  // ---------- 工具 ----------
  async function api(path, options) {
    const res = await fetch(path, options);
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try {
        const body = await res.json();
        if (body && (body.message || body.detail)) {
          msg = typeof body.detail === 'string' ? body.detail : (body.message || msg);
        }
      } catch (e) { /* 非 JSON 响应 */ }
      throw new Error(msg);
    }
    return res.json();
  }

  function setEngineUp(up, reason) {
    state.engineUp = up;
    els.engineBadge.textContent = up ? '引擎就绪' : '引擎未就绪';
    els.engineBadge.className = 'badge ' + (up ? 'badge-ok' : 'badge-danger');
    els.footEngine.textContent = up ? '引擎在线' : '引擎未连接';
    els.engineDown.classList.toggle('hidden', up);
    if (!up && reason) {
      els.engineDownDesc.innerHTML =
        '界面已经打开了，但后端服务没连上。<br>' +
        '试试：先启动后端的 <code>backend.py</code>（负责把请求转给声音引擎），' +
        '再点 <button type="button" class="linklike" id="retryBtn2">重试连接</button>。';
      const btn = els.engineDownDesc.querySelector('#retryBtn2');
      if (btn) btn.addEventListener('click', boot);
    }
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
      setEngineUp(Boolean(h.engine_up));
      if (h.engine_up) {
        await Promise.all([loadVoices(), loadHistory(), loadEvalHistory()]);
      }
      // 训练面板不依赖引擎状态，始终加载
      loadTrainData();
      refreshTrainStatus();
    } catch (e) {
      // 可能是 file:// 直接打开（无后端），或后端未启动
      setEngineUp(false, e.message);
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
        opt.value = v.path || v.name || '';
        opt.textContent = v.display || v.label || v.name || '未命名';
        if (v.file) opt.dataset.file = v.file;
        els.voiceSelect.appendChild(opt);
      }
      els.voiceSelect.disabled = false;
      if (els.renameModelBtn) els.renameModelBtn.disabled = false;
      // 记忆上次选择
      const last = localStorage.getItem('abv:voice');
      if (last && state.voices.some((v) => (v.path || v.name) === last)) {
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
        if (state.tone === 'auto') setTone(res.tone);
        return;
      }
      throw new Error('no tone');
    } catch (e) {
      const g = guessToneLocal(text);
      els.toneDetected.hidden = false;
      els.toneDetectedName.textContent = g.tone;
      els.toneDetectedConf.textContent = '置信度 ' + g.confidence + '（本地规则）';
      if (state.tone === 'auto') setTone(g.tone);
    }
  }

  // ---------- 合成 ----------
  async function synthesize() {
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
    els.synthBtn.disabled = true;
    els.synthBtn.querySelector('.btn-label').textContent = '⏳ 合成中…';
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
      if (els.seedInput && res.seed !== undefined && res.seed !== -1) {
        els.seedInput.value = res.seed;
      }

      state.currentAudioUrl = res.audio_url;
      els.resultAudio.src = res.audio_url;
      els.downloadLink.href = res.audio_url;
      els.resultSection.classList.remove('hidden');

      const segs = Array.isArray(res.segments) ? res.segments.length : 0;
      els.resultMeta.textContent =
        (res.lang ? res.lang.toUpperCase() + ' · ' : '') +
        (res.tone ? res.tone + ' · ' : '') +
        (segs > 1 ? segs + ' 段拼接 · ' : '') +
        '耗时 ' + (res.elapsed_ms != null ? (res.elapsed_ms / 1000).toFixed(1) : (elapsed / 1000).toFixed(1)) + ' 秒';

      loadHistory(); // 刷新历史
      setTimeout(() => els.resultAudio.play().catch(() => {}), 100);
    } catch (e) {
      showError('合成失败', String(e.message || e));
    } finally {
      els.synthBtn.disabled = !state.engineUp;
      els.synthBtn.querySelector('.btn-label').textContent = '🔊 合成';
      els.synthProgress.classList.add('hidden');
    }
  }

  // ---------- 统一播放：任何时候只响一个 ----------
  function stopAudio() {
    if (state.currentAudio) {
      try { state.currentAudio.pause(); } catch (e) { /* 忽略 */ }
      state.currentAudio = null;
    }
  }

  function playAudio(url) {
    if (!url) return;
    stopAudio();
    const a = new Audio(url);
    state.currentAudio = a;
    a.addEventListener('ended', () => {
      if (state.currentAudio === a) state.currentAudio = null;
    });
    a.play().catch(() => {});
  }

  // ---------- 素材页 ----------
  function audioPlay(url) {
    playAudio(url);
  }

  async function loadMaterials() {
    if (!els.materialStats) return;
    try {
      const d = await api('/api/material/list');
      els.materialStats.textContent =
        d.count > 0 ? `已导入 ${d.count} 段 · 总时长约 ${d.total_min} 分钟` : '还没有导入任何素材';
      els.materialList.innerHTML = '';
      const shown = d.files.slice(0, 300);
      for (const f of shown) {
        const row = document.createElement('div');
        row.className = 'material-row';
        const play = document.createElement('span');
        play.className = 'history-play';
        play.textContent = '▶';
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
      if (d.count > shown.length) {
        const more = document.createElement('div');
        more.className = 'eval-detail-empty';
        more.textContent = `只显示前 ${shown.length} 条（共 ${d.count} 条）`;
        els.materialList.appendChild(more);
      }
    } catch (e) {
      els.materialStats.textContent = '读取失败：' + (e.message || e);
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
      showToast(已从回收站恢复  + res.restored +  段素材);
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
      filter === 'all' ? it.level !== 'pass' : it.level === filter
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
    for (const it of items.slice(0, 300)) {
      const row = document.createElement('div');
      row.className = 'qc-row';
      const play = document.createElement('span');
      play.className = 'history-play';
      play.textContent = '▶';
      play.addEventListener('click', () => audioPlay('/api/material/audio?name=' + encodeURIComponent(it.name)));
      const lv = document.createElement('span');
      lv.className = 'lv-chip ' + (it.level === 'fail' ? 'lv-bad' : 'lv-mid');
      lv.textContent = it.level === 'fail' ? '不合格' : '警告';
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
    for (const e of entries.slice(0, 300)) {
      const row = document.createElement('div');
      row.className = 'ann-row';
      const play = document.createElement('span');
      play.className = 'history-play';
      play.textContent = '▶';
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
    if (!els.dataBadge) return;
    try {
      const d = await api('/api/data/status');
      const ready = d.clean_count > 0;
      els.dataBadge.textContent = ready ? `就绪 ${d.clean_count} 条` : (d.wav_count > 0 ? `仅导入 ${d.wav_count} 段` : '未导入');
      els.dataBadge.className = 'badge ' + (ready ? 'badge-ok' : 'badge-warn');
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
      if (j.running) {
        dataJobTimer = setTimeout(pollDataJob, 2000);
      } else {
        els.importBtn.disabled = false;
        els.prepareBtn.disabled = false;
        updateDataStatus();
        loadTrainData();
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
        : '⚠️ 训练数据还不齐（需要 wav 音频 + 清洗后的标注文件）';
    } catch (e) {
      els.trainData.textContent = '训练数据检查失败';
    }
  }

  function fmtDur(sec) {
    if (sec == null) return '—';
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
  }

  async function refreshTrainStatus() {
    if (!els.trainBadge) return;
    try {
      const st = await api('/api/train/status');
      const running = st.running;
      els.trainBadge.textContent = running ? '训练中' : (st.success === true ? '已完成' : (st.success === false ? '失败/已停' : '空闲'));
      els.trainBadge.className = 'badge ' + (running ? 'badge-warn' : (st.success === true ? 'badge-ok' : (st.success === false ? 'badge-danger' : 'badge-warn')));
      els.trainStartBtn.disabled = running || !state.engineUp;
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
    const ok = window.confirm(
      `开始训练？\n音色模型 ${s2} 轮 + 韵律模型 ${s1} 轮，预计 ${Math.round(s2 * 2 + s1 * 0.6)} 分钟左右。\n训练期间合成会变慢（显存被占用），建议先做完手头的合成。`
    );
    if (!ok) return;
    els.trainStartBtn.disabled = true;
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
    try {
      const res = await api('/api/evaluate', { method: 'POST' });
      if (!res || !res.ok || !res.result) throw new Error('评测没有返回结果');
      renderEvalResult(res.result);
      await loadEvalHistory();
    } catch (e) {
      showError('评测失败', String(e.message || e));
    } finally {
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
      const play = document.createElement('span');
      play.className = 'history-play';
      play.textContent = '▶';
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

  async function loadEvalHistory() {
    if (!els.evalHistory) return;
    try {
      const res = await api('/api/evaluations');
      const list = (res && res.evaluations) || [];
      els.evalHistory.querySelectorAll('.eval-history-item').forEach((n) => n.remove());
      els.evalHistoryEmpty.hidden = list.length > 0;
      for (const e of list) {
        const row = document.createElement('div');
        row.className = 'eval-history-item';
        row.innerHTML =
          '<span class="eval-h-score">' + (e.overall != null ? e.overall.toFixed(3) : '—') + '</span>' +
          '<span class="eval-h-level">' + (e.level || '') + '</span>' +
          '<span class="eval-h-model">' + (e.model || '') + '</span>' +
          '<span class="eval-h-time">' + formatTime(e.created_at || e.time) + '</span>';
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

  function savePresets(list) {
    localStorage.setItem(PRESET_KEY, JSON.stringify(list));
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
    const voiceName = state.voices.find((v) => (v.path || v.name) === p.voice);
    const voiceTag = document.createElement('span');
    voiceTag.className = 'history-tag';
    voiceTag.textContent = voiceName ? voiceName.name : '音色已失效';
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
    apply.textContent = '▶ 应用';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'preset-delete';
    del.textContent = '删除';

    apply.addEventListener('click', () => applyPreset(p));
    del.addEventListener('click', () => {
      const list = getPresets();
      list.splice(index, 1);
      savePresets(list);
      renderPresets();
    });

    actions.append(apply, del);
    row.append(name, meta, actions);
    return row;
  }

  function applyPreset(p) {
    // 音色仍存在才设置
    if (p.voice && state.voices.some((v) => (v.path || v.name) === p.voice)) {
      els.voiceSelect.value = p.voice;
    }
    if (p.lang && ['zh', 'en', 'ja'].includes(p.lang)) setLang(p.lang);
    if (p.tone) setTone(p.tone);
    els.textInput.focus();
  }

  function saveCurrentPreset() {
    const list = getPresets();
    let name = '';
    try {
      name = (window.prompt('给这个预设起个名字（留空用时间命名）：', '预设 ' + (list.length + 1)) || '').trim();
    } catch (e) { name = ''; }
    if (!name) name = '预设 ' + new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const preset = {
      name,
      voice: els.voiceSelect.value || '',
      lang: state.lang,
      tone: state.tone,
      savedAt: new Date().toISOString(),
    };
    list.push(preset);
    savePresets(list);
    renderPresets();
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
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      playAudio(objUrl);
      setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    } catch (e) {
      // 后端还没实现 /api/preview，给出人话提示，请 lead 补接口
      showError(
        '试听接口还没开通',
        '前端已经按 GET /api/preview?voice=xxx 的方式请求了，但后端还没有这个接口（返回：' +
        String(e.message || e) + '）。请联系后端同事补上：用声音引擎把该音色的参考音频转成音频流返回。'
      );
    }
  }

  // ---------- 批量合成 ----------
  const ALLOWED_TONES = ['auto', '平静', '开心', '悲伤', '生气', '惊讶', '害怕'];
  let batchRunning = false;

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
      try {
        const res = await api('/api/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: item.text, lang: state.lang, voice, tone: item.tone }),
        });
        if (res && res.ok && res.audio_url) {
          status.textContent = '✅';
          status.className = 'batch-status done';
          const audio = document.createElement('audio');
          audio.controls = true;
          audio.preload = 'metadata';
          audio.src = res.audio_url;
          row.appendChild(audio);
        } else {
          throw new Error(res && res.message ? res.message : '没有返回音频');
        }
      } catch (e) {
        status.textContent = '❌ 失败：' + String(e.message || e).slice(0, 60);
        status.className = 'batch-status fail';
      }
    }

    batchRunning = false;
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

    const play = document.createElement('span');
    play.className = 'history-play';
    play.textContent = '▶';

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
    dl.textContent = '⬇';
    dl.title = '下载';
    dl.href = item.audio_url || '#';
    if (!item.audio_url) dl.classList.add('hidden');
    dl.setAttribute('download', '');

    // 删除这一条
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-del';
    del.textContent = '🗑';
    del.title = '删除这条记录';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = window.confirm('删除这条记录？音频文件也会一起删掉。');
      if (!ok) return;
      del.disabled = true;
      try {
        await api('/api/history/' + encodeURIComponent(item.time), { method: 'DELETE' });
        row.remove();
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
      if (e.target === dl) return;
      if (!url) return;
      const playing = row.classList.contains('playing');
      // 全部停掉，再决定是否播放这一条（点同一条 = 暂停）
      stopAudio();
      els.historyList.querySelectorAll('.history-item.playing').forEach((n) => {
        n.classList.remove('playing');
        const p = n.querySelector('.history-play');
        if (p) p.textContent = '▶';
      });
      if (playing) return;
      const audio = new Audio(url);
      state.currentAudio = audio;
      row.classList.add('playing');
      play.textContent = '❚❚';
      audio.addEventListener('ended', () => {
        row.classList.remove('playing');
        play.textContent = '▶';
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

  // ---------- 音质微调 ----------
  if (els.advToggleBtn) {
    els.advToggleBtn.addEventListener('click', () => {
      const hidden = els.advPanel.classList.toggle('hidden');
      els.advToggleBtn.textContent = (hidden ? '▶' : '▼') + ' 音质微调（合成不满意时用）';
    });
  }
  if (els.tempRange) {
    els.tempRange.addEventListener('input', () => {
      state.temperature = parseFloat(els.tempRange.value);
      els.tempValue.textContent = state.temperature.toFixed(2);
    });
    state.temperature = parseFloat(els.tempRange.value);
    els.tempValue.textContent = state.temperature.toFixed(2);
  }
  if (els.seedInput) {
    els.seedInput.addEventListener('change', () => {
      const v = parseInt(els.seedInput.value, 10);
      state.seed = isNaN(v) ? -1 : v;
    });
  }
  if (els.rerollBtn) {
    els.rerollBtn.addEventListener('click', () => {
      const s = Math.floor(Math.random() * 2147483000);
      els.seedInput.value = s;
      state.seed = s;
      // 换种子后直接重合成
      synthesize();
    });
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
  els.batchStopBtn.addEventListener('click', () => { batchRunning = false; });

  els.voiceSelect.addEventListener('change', () => {
    if (els.voiceSelect.value) {
      localStorage.setItem('abv:voice', els.voiceSelect.value);
      // 换了模型，之前的质检/标注结果不再对应，清掉
      clearQcResult(true);
      clearAnnResult(true);
    }
  });

  // 快捷键：Ctrl+Enter 合成；空格 播放/暂停结果（焦点不在输入框时）
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
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

  // 引擎断线轮询（每 12 秒查一次，回来了自动恢复）
  setInterval(async () => {
    try {
      const h = await api('/api/health');
      if (Boolean(h.engine_up) !== state.engineUp) {
        if (h.engine_up) {
          setEngineUp(true);
          await Promise.all([loadVoices(), loadHistory()]);
        } else {
          setEngineUp(false);
        }
      }
    } catch (e) {
      if (state.engineUp) setEngineUp(false);
    }
  }, 12000);

  // ---------- 启动 ----------
  updateMeta();
  renderPresets();
  // 顶部标签切换
  document.querySelectorAll('.flow-step[data-view]').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });
  // 直接带 #train / #eval 打开也能定位
  switchView((location.hash || '#synth').slice(1));

  boot();
})();
