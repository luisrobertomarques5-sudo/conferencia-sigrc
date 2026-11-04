const { chromium } = require('playwright'); const fs = require('fs');
(async () => {
  const b = await chromium.launch(); const p = await (await b.newContext({ timezoneId: 'America/Sao_Paulo' })).newPage();
  await p.goto('http://127.0.0.1:8765/resolucao/solicitacoes/recebidas');
  await p.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('conferencia_sigrc'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await p.evaluate(() => { window.__CONF_SIGRC_TEST__ = { onExport: async (blob) => { const u = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); window.__m = btoa(s); } }; });
  await p.addScriptTag({ path: 'dist/conferencia-sigrc.min.js' });
  await p.waitForFunction(() => window.__CONF_SIGRC__);
  await p.evaluate(() => window.__CONF_SIGRC__._exportar());
  await p.waitForFunction(() => window.__m);
  fs.writeFileSync('planilhas/modelo-planilha-conferencia-sigrc.xlsx', Buffer.from(await p.evaluate(() => window.__m), 'base64'));
  await b.close(); console.log('ok');
})();
