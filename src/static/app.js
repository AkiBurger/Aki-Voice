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
    lang: 'ja',
    tone: 'auto',
    voices: [],
    currentAudioUrl: null,
    engineUp: false,
    historyPlayer: null,      // 正在播放历史的 <audio>
    currentHistoryUrl: null,
  };

  // ---------- 元素 ----------
  const els = {
    voiceSelect: $('voiceSelect'),
    engineBadge: $('engineBadge'),
    engineDown: $('engineDown'),
    engineDownDesc: $('engineDownDesc'),
    retryBtn: $('retryBtn'),
    previewBtn: $('previewBtn'),
    previewAudio: $('previewAudio'),
    langBtns: [...document.querySelectorAll('.lang-btn')],
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
  };

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
  }

  // ---------- 启动流程：体检 -> 音色 -> 历史 ----------
  async function boot() {
    setEngineUp(false, null);
    try {
      const h = await api('/api/health');
      setEngineUp(Boolean(h.engine_up));
      if (h.engine_up) {
        await Promise.all([loadVoices(), loadHistory()]);
      }
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
        opt.textContent = v.name || '未命名音色';
        els.voiceSelect.appendChild(opt);
      }
      els.voiceSelect.disabled = false;
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
    els.progressText.textContent = '正在合成「' + text.slice(0, 20) + (text.length > 20 ? '…' : '') + '」';
    const t0 = performance.now();

    try {
      const res = await api('/api/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang: state.lang, voice, tone: state.tone }),
      });
      const elapsed = Math.round(performance.now() - t0);
      if (!res || !res.ok || !res.audio_url) throw new Error(res && res.message ? res.message : '后端没有返回音频');

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
      const audio = new Audio(objUrl);
      audio.onended = () => URL.revokeObjectURL(objUrl);
      await audio.play();
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

    row.append(play, body, dl);

    const url = item.audio_url;
    row.addEventListener('click', (e) => {
      if (e.target === dl) return;
      if (!url) return;
      if (state.historyPlayer && state.historyPlayer.src === url) {
        state.historyPlayer.pause();
        state.historyPlayer = null;
        row.classList.remove('playing');
        play.textContent = '▶';
        return;
      }
      if (state.historyPlayer) state.historyPlayer.pause();
      const audio = new Audio(url);
      state.historyPlayer = audio;
      els.historyList.querySelectorAll('.history-item.playing').forEach((n) => {
        n.classList.remove('playing');
        const p = n.querySelector('.history-play');
        if (p) p.textContent = '▶';
      });
      row.classList.add('playing');
      play.textContent = '❚❚';
      audio.addEventListener('ended', () => {
        row.classList.remove('playing');
        play.textContent = '▶';
        state.historyPlayer = null;
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
  boot();
})();
