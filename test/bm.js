const { chromium } = require('playwright'); const fs = require('fs');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8765/resolucao/solicitacoes/recebidas');
  await p.evaluate(() => { window.__CONF_SIGRC_TEST__ = {}; });
  const bm = fs.readFileSync('index.html', 'utf8').match(/href="(javascript:[^"]+)"/)[1];
  // simula clique num link javascript: (mesmo mecanismo do favorito)
  await p.evaluate(href => { const a = document.createElement('a'); a.href = href; document.body.appendChild(a); a.click(); }, bm);
  await p.waitForFunction(() => window.__CONF_SIGRC__ && document.querySelector('#conferencia-sigrc-host'), null, { timeout: 10000 });
  console.log('bookmarklet OK, versão', await p.evaluate(() => window.__CONF_SIGRC__.versao), 'title', await p.title(), 'errs', errs);
  // segundo clique apenas mostra o painel
  await p.evaluate(href => { const a = document.createElement('a'); a.href = href; a.click(); }, bm);
  await p.waitForTimeout(500);
  console.log('hosts', await p.evaluate(() => document.querySelectorAll('#conferencia-sigrc-host').length));
  await b.close();
})().catch(e => { console.error('FALHOU', e.message); process.exit(1); });
