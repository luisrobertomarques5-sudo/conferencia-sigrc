// Teste de ponta a ponta do painel contra o SIGRC simulado.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const SRC = process.env.SRC || path.resolve(__dirname, '../src/conferencia-sigrc.js');
const OUT = path.resolve(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:8765';
const ctl = s => fetch(`${BASE}/__ctl?s=${encodeURIComponent(JSON.stringify(s))}`);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  const erros = []; page.on('pageerror', e => erros.push(e.message)); page.on('console', m => { if (m.type() === 'error') erros.push('console: ' + m.text()); });
  const injetar = async () => {
    await page.evaluate(() => { window.__CONF_SIGRC_TEST__ = { onExport: async (blob, nome) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); window.__exp = { nome, b64: btoa(s) }; } }; });
    await page.addScriptTag({ path: SRC });
    await page.waitForFunction(() => window.__CONF_SIGRC__ && document.querySelector('#conferencia-sigrc-host'));
  };
  const estado = () => page.evaluate(() => { const S = window.__CONF_SIGRC__._S; const c = {}; for (const it of S.items.values()) { const k = it.caixa + ':' + (it.naCaixa ? it.conf : 'fora'); c[k] = (c[k] || 0) + 1; } return { estado: S.run && S.run.estado, motivo: S.run && S.run.motivo, exec: S.executando, c, n: S.items.size, logs: S.logs.length }; });
  const esperarFim = async (ms = 120000) => { await page.waitForFunction(() => { const S = window.__CONF_SIGRC__._S; return S.run && !S.executando && S.run.estado !== 'executando'; }, null, { timeout: ms }); };
  const clicar = sel => page.locator(`#conferencia-sigrc-host >> ${sel}`).first().click();
  const exportar = async (nome) => { await page.evaluate(() => { window.__exp = null; }); await clicar('button[data-a="exportar"]'); await page.waitForFunction(() => window.__exp, null, { timeout: 30000 }); const e = await page.evaluate(() => window.__exp); fs.writeFileSync(path.join(OUT, nome), Buffer.from(e.b64, 'base64')); return e.nome; };

  await ctl({ falhar401Apos: null });
  await page.goto(`${BASE}/resolucao/solicitacoes/recebidas`);
  await page.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('conferencia_sigrc'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await injetar();
  await page.evaluate(() => { window.__CONF_SIGRC__._S.cfg.intervalo = 0; });
  await page.screenshot({ path: path.join(OUT, '01-inicial.png') });

  // 1) conferência completa
  await clicar('button[data-a="iniciar"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '02-executando.png') });
  await esperarFim();
  const e1 = await estado(); console.log('RUN1', JSON.stringify(e1));
  await clicar('button[data-a="aba"][data-v="ATRIBUIDAS"]');
  await page.locator('#conferencia-sigrc-host >> tr.it').first().click();
  await page.screenshot({ path: path.join(OUT, '03-atribuidas.png') });
  console.log('EXPORT1', await exportar('export1.xlsx'));

  // 2) importar planilha base modificada (feita pelo python) e exportar de novo
  require('child_process').execFileSync('python3', [path.join(__dirname, 'modificar_base.py'), path.join(OUT, 'export1.xlsx'), path.join(OUT, 'base_modificada.xlsx')], { stdio: 'inherit' });
  await page.locator('#conferencia-sigrc-host >> #arq').setInputFiles(path.join(OUT, 'base_modificada.xlsx'));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '04-importacao.png') });
  await clicar('button[data-a="fecharModal"]');
  console.log('EXPORT2', await exportar('export2.xlsx'));

  // 3) sessão expira no meio da conferência → pausa; depois retoma
  await ctl({ falhar401Apos: 60 });
  await clicar('button[data-a="iniciar"]');
  await page.waitForTimeout(300);
  if (await page.locator('#conferencia-sigrc-host >> .modal').count()) await clicar('button[data-a="modalAcao"][data-i="1"]');
  await esperarFim();
  const e3 = await estado(); console.log('RUN-SESSAO', JSON.stringify(e3));
  await page.screenshot({ path: path.join(OUT, '05-sessao.png') });
  await ctl({ falhar401Apos: null });
  await clicar('button[data-a="retomar"]');
  await esperarFim();
  console.log('RUN-RETOMADA', JSON.stringify(await estado()));

  // 4) interrupção por recarga da página → retomar
  await page.evaluate(() => { window.__CONF_SIGRC__._S.cfg.intervalo = 60; });
  await clicar('button[data-a="iniciar"]');
  await page.waitForFunction(() => { const S = window.__CONF_SIGRC__._S; return [...S.items.values()].filter(i => i.runId === S.run.id && i.conf === 'verificada').length > 30; }, null, { timeout: 60000 });
  page.once('dialog', d => d.accept());
  await page.goto(`${BASE}/resolucao/solicitacoes/recebidas`);
  await injetar();
  console.log('APOS-RELOAD', JSON.stringify(await estado()));
  await page.screenshot({ path: path.join(OUT, '06-interrompida.png') });
  await page.evaluate(() => { window.__CONF_SIGRC__._S.cfg.intervalo = 0; });
  await clicar('button[data-a="retomar"]');
  await esperarFim();
  console.log('RUN-POS-RELOAD', JSON.stringify(await estado()));
  await clicar('button[data-a="reproc"]');
  await esperarFim();
  console.log('RUN-REPROC', JSON.stringify(await estado()));
  await clicar('button[data-a="aba"][data-v="RELATORIO"]');
  await page.screenshot({ path: path.join(OUT, '07-relatorio.png') });
  await clicar('button[data-a="aba"][data-v="AUDITORIA"]');
  await page.screenshot({ path: path.join(OUT, '08-auditoria.png') });
  console.log('EXPORT3', await exportar('export3.xlsx'));

  // 5) round-trip do leitor xlsx no navegador
  const rt = await page.evaluate(async () => {
    const b = Uint8Array.from(atob(window.__exp.b64), c => c.charCodeAt(0));
    const wb = await window.__CONF_SIGRC__._XLSX.ler(b.buffer);
    return wb.sheets.map(s => `${s.name}:${s.rows.length}`).join(' ');
  });
  console.log('ROUNDTRIP', rt);
  // 6) mobile width screenshot
  await page.setViewportSize({ width: 390, height: 800 });
  await clicar('button[data-a="aba"][data-v="RECEBIDAS"]');
  await page.screenshot({ path: path.join(OUT, '09-mobile.png') });
  console.log('ERROS-JS', JSON.stringify(erros));
  await browser.close();
})().catch(e => { console.error('FALHOU', e); process.exit(1); });
