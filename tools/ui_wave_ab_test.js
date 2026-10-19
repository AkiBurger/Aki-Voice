// 波形 + A/B 对比 真实合成测试（会真的调一次合成，约 5~10 秒）
const { spawn } = require('child_process');
const http = require('http');

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const URL = 'http://127.0.0.1:8017/static/index.html#synth';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const profile = require('os').tmpdir() + '\\abv-wave-' + Date.now();
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', URL,
  ], { stdio: 'ignore' });

  let ws;
  try {
    let tab = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await getJSON('/json/list');
        tab = (list || []).find((t) => t.type === 'page' && !(t.url || '').startsWith('devtools://'));
        if (tab) break;
      } catch (e) { /* 等 */ }
      await sleep(250);
    }
    if (!tab) throw new Error('没找到页面 target');

    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const mid = ++id; pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.enable');
    const synthReqs = [];
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.method === 'Network.requestWillBeSent' && (msg.params.request.url || '').includes('/api/synthesize')) {
        synthReqs.push({ url: msg.params.request.url, body: msg.params.request.postData });
      }
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) return { error: r.result.exceptionDetails.text };
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await sleep(5000);

    const setText = (t) => evaluate(`(() => {
      const ta = document.getElementById('textInput');
      ta.value = ${JSON.stringify(t)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return ta.value.length;
    })()`);

    const clickSynth = () => evaluate("document.getElementById('synthBtn').click(); 'clicked'");

    const waitDone = async (timeoutMs) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const busy = await evaluate("!!(document.getElementById('synthProgress') && !document.getElementById('synthProgress').classList.contains('hidden'))");
        if (busy === false || busy === undefined) {
          const vis = await evaluate("!document.getElementById('resultSection').classList.contains('hidden')");
          if (vis) return true;
        }
        await sleep(700);
      }
      return false;
    };

    const out = {};
    // 输入语言切到日文（否则日文台词会被当中文翻译）
    await evaluate("document.querySelector('.in-lang-btn[data-lang=\"ja\"]')?.click()");
    await evaluate("document.querySelector('.lang-btn[data-lang=\"ja\"]')?.click()");
    await sleep(500);
    const snapshot = () => evaluate(`(() => {
      const errBox = document.getElementById('errorBox');
      const errVisible = errBox && !errBox.classList.contains('hidden');
      return {
        errVisible: !!errVisible,
        errTitle: document.getElementById('errorTitle')?.textContent || '',
        errDesc: document.getElementById('errorDesc')?.textContent || '',
        synthDisabled: document.getElementById('synthBtn').disabled,
        progressHidden: document.getElementById('synthProgress').classList.contains('hidden'),
        resultHidden: document.getElementById('resultSection').classList.contains('hidden'),
        engineBadge: document.getElementById('engineBadge')?.textContent || '',
      };
    })()`);
    out.beforeFirst = await snapshot();
    for (let i = 0; i < 30; i++) {
      const d = await evaluate("document.getElementById('synthBtn').disabled");
      if (!d) break;
      await sleep(500);
    }
    // 第一次合成
    await setText('おはよう。今日もいい天気だね。');
    await clickSynth();
    await sleep(1500);
    out.duringFirst = await snapshot();
    out.firstDone = await waitDone(120000);
    out.afterFirst = await snapshot();
    await sleep(2500);
    out.first = await evaluate(`(() => {
      const c = document.getElementById('waveCanvas');
      let drawn = false;
      try {
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < d.length; i += 40) { if (d[i] > 0) { drawn = true; break; } }
      } catch (e) { drawn = 'err'; }
      return {
        audio: document.getElementById('resultAudio').getAttribute('src') || '',
        download: document.getElementById('downloadLink').getAttribute('download') || '',
        canvasDrawn: drawn,
        abHidden: document.getElementById('abCompare').classList.contains('hidden'),
      };
    })()`);

    // 第二次合成（不同文本）→ A/B 应该出现
    await setText('「ちょっと待って！」彼女は振り返った。');
    await clickSynth();
    out.secondDone = await waitDone(120000);
    await sleep(2500);
    out.second = await evaluate(`({
      abHidden: document.getElementById('abCompare').classList.contains('hidden'),
      abBtns: document.querySelectorAll('#abCompare .ab-btn').length,
      hint: document.getElementById('abHint') ? document.getElementById('abHint').textContent : '',
      meta: document.getElementById('resultMeta').textContent,
    })`);

    // 点 B 播放
    await evaluate("document.getElementById('abBbBtn') && document.getElementById('abBbBtn').click()");
    await sleep(1200);
    out.abAfterClick = await evaluate("document.getElementById('abHint') ? document.getElementById('abHint').textContent : ''");

    out.synthRequests = synthReqs;
    try {
      await evaluate("document.getElementById('resultSection').scrollIntoView({block:'start'})");
      await sleep(800);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (shot && shot.result && shot.result.data) {
        require('fs').writeFileSync('D:\\Dev\\projects\\voice-studio\\docs\\assets\\07-result-waveform.png', Buffer.from(shot.result.data, 'base64'));
        out.screenshot = '07-result-waveform.png';
      }
    } catch (e) { out.screenshotError = String(e); }
    out.errors = errors.slice(0, 8);
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ fatal: String((e && e.stack) || e) }, null, 2));
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { edge.kill(); } catch (e) {}
  }
}
main();
