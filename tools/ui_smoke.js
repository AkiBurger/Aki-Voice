// UI 真实交互冒烟测试：连真实后端，检查控制台错误、动态数据、页面切换
const { spawn } = require('child_process');
const http = require('http');

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const URL = 'http://127.0.0.1:8017/static/index.html';

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
  const profile = require('os').tmpdir() + '\\abv-cdp-' + Date.now();
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', URL,
  ], { stdio: 'ignore' });

  let ws;
  try {
    // 等调试端口就绪
    let version = null;
    for (let i = 0; i < 40; i++) {
      try { version = await getJSON('/json/version'); break; } catch (e) { await sleep(250); }
    }
    if (!version) throw new Error('CDP 端口没起来');

    let tab = null;
    for (let i = 0; i < 40; i++) {
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
    const logs = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
        logs.push(msg.params.type + ': ' + (msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        errors.push('log: ' + msg.params.entry.text);
      }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: URL });
    await sleep(1500);

    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) return { error: r.result.exceptionDetails.text };
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await sleep(6000); // 等首屏异步数据

    const checks = {};
    checks.title = await evaluate('document.title');
    checks.pageTitle = await evaluate("document.getElementById('pageTitle')?.textContent || ''");
    checks.hash = await evaluate('location.hash');
    checks.navCount = await evaluate("document.querySelectorAll('.side-nav-item[data-view]').length");
    checks.voiceOptions = await evaluate("document.querySelectorAll('#voiceSelect option').length");
    checks.historyRows = await evaluate("document.querySelectorAll('.history-item').length");
    checks.materialStats = await evaluate("document.getElementById('materialStats')?.textContent || ''");

    // 切到素材页
    await evaluate("document.querySelector('.side-nav-item[data-view=\"material\"]').click()");
    await sleep(2500);
    checks.materialPageTitle = await evaluate("document.getElementById('pageTitle').textContent");
    checks.materialRows = await evaluate("document.querySelectorAll('.material-row').length");
    checks.materialStats2 = await evaluate("document.getElementById('materialStats')?.textContent || ''");

    // 切到训练页
    await evaluate("document.querySelector('.side-nav-item[data-view=\"train\"]')?.click() || document.querySelector('.flow-step[data-view=\"train\"]').click()");
    await sleep(2000);
    checks.trainData = await evaluate("document.getElementById('trainData')?.textContent || ''");
    checks.trainBadge = await evaluate("document.getElementById('trainBadge')?.textContent || ''");

    // 切到评测页
    await evaluate("document.querySelector('.side-nav-item[data-view=\"eval\"]').click()");
    await sleep(1500);
    checks.evalTarget = await evaluate("document.getElementById('evalTarget')?.textContent || ''");
    checks.evalHistory = await evaluate("document.querySelectorAll('.eval-history-item').length");

    // 切回合成页
    await evaluate("document.querySelector('.side-nav-item[data-view=\"synth\"]').click()");
    await sleep(800);
    checks.abHidden = await evaluate("document.getElementById('abCompare').classList.contains('hidden')");
    checks.waveCanvas = await evaluate("!!document.getElementById('waveCanvas')");

    console.log(JSON.stringify({ checks, errors: errors.slice(0, 10), consoleErrors: logs.slice(0, 10) }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ fatal: String(e && e.stack || e) }, null, 2));
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { edge.kill(); } catch (e) {}
  }
}

main();
