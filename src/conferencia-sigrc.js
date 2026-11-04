/*!
 * Conferência SIGRC — Recebidas e Atribuídas
 * Painel de conferência automática que roda dentro do sistema Resolução (SIGRC),
 * usando a sessão já logada do usuário. Somente leitura: apenas consultas (GET).
 * Dados ficam no próprio navegador (IndexedDB). Exporta Excel (.xlsx) sem bibliotecas externas.
 */
(() => {
  'use strict';
  const VERSAO = '1.0.0';
  if (window.__CONF_SIGRC__) { window.__CONF_SIGRC__.mostrar(); return; }
  const TESTE = !!window.__CONF_SIGRC_TEST__;
  if (!TESTE && !/(^|\.)sigrc\.prefeitura\.sp\.gov\.br$/i.test(location.hostname)) {
    alert('Conferência SIGRC: abra o sistema Resolução (sigrc.prefeitura.sp.gov.br), faça login e clique novamente no favorito.');
    return;
  }
  const API = (TESTE && window.__CONF_SIGRC_TEST__.api) || '/resolucao/api';
  const CAIXAS = ['RECEBIDAS', 'ATRIBUIDAS'];
  const NOME_CAIXA = { RECEBIDAS: 'Recebidas', ATRIBUIDAS: 'Atribuídas' };

  /* ───────────────────────── utilitários ───────────────────────── */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad = n => String(n).padStart(2, '0');
  const agoraISO = () => new Date().toISOString();
  const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toDate = v => { if (!v) return null; const d = v instanceof Date ? v : new Date(v); return isNaN(d) ? null : d; };
  const fmtDT = v => { const x = toDate(v); if (!x) return ''; return `${pad(x.getDate())}/${pad(x.getMonth() + 1)}/${x.getFullYear()} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`; };
  const cap = s => { s = String(s ?? '').replace(/_/g, ' ').toLowerCase(); return s ? s[0].toUpperCase() + s.slice(1) : ''; };
  const CONF_LBL = { verificada: 'Verificada', pendente: 'Pendente', erro: 'Erro', incompleta: 'Incompleta' };

  function htmlParaTexto(html) {
    if (html == null) return '';
    let s = String(html);
    if (!/[<&]/.test(s)) return s.replace(/\r\n/g, '\n').trim();
    s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '$&\n').replace(/<li[^>]*>/gi, '$&• ');
    const doc = new DOMParser().parseFromString('<div>' + s + '</div>', 'text/html');
    return (doc.body.textContent || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function slaTexto(t) {
    if (!t) return '';
    const d = Number(t.dias), hh = Number(t.horas), m = Number(t.minutos);
    if ([d, hh, m].some(Number.isNaN)) return '';
    if (d < 0 || hh < 0 || m < 0) {
      const dd = Math.abs(d);
      return dd > 0 ? `Atrasado ${dd} dia${dd > 1 ? 's' : ''}` : `Atrasado ${Math.abs(hh)}h${pad(Math.abs(m))}`;
    }
    return d > 0 ? `Restam ${d} dia${d > 1 ? 's' : ''}` : `Restam ${hh}h${pad(m)}`;
  }

  /* ───────────────────────── armazenamento local (IndexedDB) ───────────────────────── */
  const DB = {
    db: null, memoria: null,
    async abrir() {
      try {
        await new Promise((res, rej) => {
          const rq = indexedDB.open('conferencia_sigrc', 1);
          rq.onupgradeneeded = () => {
            const d = rq.result;
            d.createObjectStore('items', { keyPath: 'key' });
            d.createObjectStore('meta');
            d.createObjectStore('log', { autoIncrement: true });
          };
          rq.onsuccess = () => { this.db = rq.result; res(); };
          rq.onerror = () => rej(rq.error);
        });
      } catch (e) { this.memoria = { items: new Map(), meta: new Map(), log: [] }; }
    },
    _tx(store, modo, fn) {
      return new Promise((res, rej) => {
        const t = this.db.transaction(store, modo); const s = t.objectStore(store); let out;
        const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
        t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    },
    async get(store, key) { if (this.memoria) return this.memoria[store].get(key); return this._tx(store, 'readonly', s => s.get(key)); },
    async put(store, val, key) {
      if (this.memoria) { if (store === 'log') this.memoria.log.push(val); else this.memoria[store].set(key ?? val.key, val); return; }
      return this._tx(store, 'readwrite', s => (key === undefined ? s.put(val) : s.put(val, key)));
    },
    async putMany(store, vals) {
      if (this.memoria) { vals.forEach(v => this.memoria[store].set(v.key, v)); return; }
      return new Promise((res, rej) => { const t = this.db.transaction(store, 'readwrite'); const s = t.objectStore(store); vals.forEach(v => s.put(v)); t.oncomplete = res; t.onerror = () => rej(t.error); });
    },
    async all(store) { if (this.memoria) return store === 'log' ? this.memoria.log.slice() : [...this.memoria[store].values()]; return this._tx(store, 'readonly', s => s.getAll()); },
    async limpar() {
      if (this.memoria) { this.memoria = { items: new Map(), meta: new Map(), log: [] }; return; }
      for (const st of ['items', 'meta', 'log']) await this._tx(st, 'readwrite', s => s.clear());
    }
  };

  /* ───────────────────────── estado ───────────────────────── */
  const S = {
    items: new Map(), logs: [], run: null, cfg: { sensiveis: false, intervalo: 300 }, base: null, atualizacao: null,
    executando: false, parar: false, etapa: '', aba: 'RECEBIDAS', filtros: { RECEBIDAS: { q: '', f: 'todas' }, ATRIBUIDAS: { q: '', f: 'todas' }, LOG: 'todos' },
    abertos: new Set(), banner: null, operador: ''
  };
  const salvarMeta = (k, v) => DB.put('meta', v, k);

  async function log(tipo, msg, it) {
    const e = { ts: agoraISO(), tipo, msg, caixa: it ? it.caixa : '', id: it ? it.id : '', runId: S.run ? S.run.id : '' };
    S.logs.push(e); if (S.logs.length > 5000) S.logs.splice(0, S.logs.length - 5000);
    try { await DB.put('log', e); } catch (_) { /* ignora */ }
    agendarRender();
  }

  /* ───────────────────────── cliente da API do SIGRC (somente GET) ───────────────────────── */
  class ErroSessao extends Error {}
  async function apiGet(path, { tentativas = 3, timeout = 30000 } = {}) {
    let ultimo;
    for (let a = 1; a <= tentativas; a++) {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeout);
      try {
        const r = await fetch(API + path, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json, text/plain, */*' }, signal: ctl.signal });
        clearTimeout(tm);
        if (r.status === 401 || r.status === 403) throw new ErroSessao(`Sessão expirada ou sem permissão (HTTP ${r.status})`);
        const ct = r.headers.get('content-type') || '';
        if (r.ok && !/json/i.test(ct)) throw new ErroSessao('O sistema não devolveu dados (provável sessão expirada)');
        if (!r.ok) { const e = new Error(`HTTP ${r.status} em ${path.split('?')[0]}`); e.semRepetir = r.status >= 400 && r.status < 500 && r.status !== 429; throw e; }
        return await r.json();
      } catch (e) {
        clearTimeout(tm);
        if (e instanceof ErroSessao || e.semRepetir) throw e;
        ultimo = e.name === 'AbortError' ? new Error(`Tempo esgotado em ${path.split('?')[0]}`) : e;
        if (a < tentativas) await sleep(700 * a * a);
      }
    }
    throw ultimo;
  }

  async function listarCaixa(caixa) {
    const PS = 100; const vistos = new Map(); const dups = []; let total = null;
    const varrer = async (sortField, sortOrder) => {
      for (let page = 1; page <= 500; page++) {
        S.etapa = `Listando ${NOME_CAIXA[caixa]} (página ${page})`; agendarRender();
        const j = await apiGet(`/solicitacoes/caixas?pageSize=${PS}&caixa=${caixa}&page=${page}&sortField=${sortField}&sortOrder=${sortOrder}`);
        if (total === null || typeof j.total === 'number') total = j.total;
        const res = j.resultado || [];
        for (const it of res) { if (vistos.has(it.id)) { if (sortField === 'id') dups.push(it.id); } else vistos.set(it.id, it); }
        if (res.length < PS) break;
      }
    };
    await varrer('id', 'ASCENDING');
    if (total !== null && vistos.size < total) {
      await log('aviso', `${NOME_CAIXA[caixa]}: o sistema informa ${total} e foram listadas ${vistos.size}. Fazendo segunda varredura.`);
      await varrer('dataCadastro', 'DESCENDING');
    }
    return { total, itens: [...vistos.values()], dups };
  }

  async function lerHistorico(id, idOrgao) {
    const regs = []; let total = null;
    for (let page = 1; page <= 200; page++) {
      S.etapa = `${S.etapaBase} · histórico (página ${page})`; agendarRender();
      const q = `/solicitacoes/${id}/historico/?page=${page}` + (idOrgao != null ? `&idOrgao=${idOrgao}` : '');
      const j = await apiGet(q);
      if (total === null) total = typeof j.total === 'number' ? j.total : null;
      const hs = j.historicos || [];
      regs.push(...hs);
      if (!hs.length || (total !== null && regs.length >= total)) break;
    }
    const porId = new Map(); let semId = 0;
    for (const r of regs) { const k = r.historico && r.historico.id != null ? r.historico.id : 'x' + (semId++); if (!porId.has(k)) porId.set(k, r); }
    return { total, registros: [...porId.values()], brutos: regs.length };
  }

  const cacheForm = new Map();
  async function lerFormulario(idForm) {
    if (!cacheForm.has(idForm)) cacheForm.set(idForm, await apiGet(`/formulario/${idForm}`));
    return cacheForm.get(idForm);
  }

  const RE_SENS_ID = /cpf|cartao|cns|nascimento|mae|endereco|logradouro|cep|bairro|complemento|telefone|celular|email|rne|crnm|dprnm|estrangeiro|raca|genero|orientacao|deficiencia|nome/;
  const RE_SENS_LBL = /\bcpf\b|\bcin\b|cartao sus|cartao nacional|nascimento|nome da mae|endereco|\bcep\b|telefone|celular|e mail|email|identidade de genero|orientacao sexual|\braca\b|deficiencia|\brg\b/;
  const META_REG = new Set(['id', 'idVersaoFormulario', 'dataCadastro', 'idUsuarioCadastro', 'idRegistro', 'tenant']);
  function textoFormulario(form, reg, incluirSens) {
    if (!reg) return '';
    const linhas = []; const usados = new Set();
    for (const c of (form && form.componentes) || []) {
      if (!c.htmlId) continue; usados.add(c.htmlId);
      if (['SEPARATOR', 'LABEL', 'INPUTFILE', 'BUTTON'].includes(c.htmlTipo)) continue;
      let v = reg[c.htmlId]; if (v === null || v === undefined || v === '') continue;
      const rot = htmlParaTexto(c.descricaoComponente || c.htmlId).replace(/\s+/g, ' ').replace(/[:\s]+$/, '');
      if (!incluirSens && (RE_SENS_ID.test(c.htmlId.toLowerCase()) || RE_SENS_LBL.test(norm(rot)))) continue;
      if (c.htmlTipo === 'CHECKBOX') v = (v === 'on' || v === true || v === 'true') ? 'Sim' : (v === 'off' || v === false || v === 'false') ? 'Não' : v;
      linhas.push(`${rot}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    }
    for (const [k, v] of Object.entries(reg)) {
      if (usados.has(k) || META_REG.has(k) || v === null || v === '' || typeof v === 'object') continue;
      if (/^fu_/.test(k)) continue;
      if (!incluirSens && RE_SENS_ID.test(k.toLowerCase())) continue;
      linhas.push(`${k}: ${String(v)}`);
    }
    return linhas.join('\n');
  }

  /* ───────────────────────── conferência ───────────────────────── */
  function novoItem(caixa, id) {
    return { key: `${caixa}:${id}`, caixa, id: Number(id), naCaixa: true, primeiraVezEm: agoraISO(), conf: 'pendente', tentativas: 0, erros: [], problemas: [], avisos: [] };
  }

  function resumoLista(li) {
    return {
      dataCadastro: li.dataCadastro, dataLimite: li.dataLimite, criticidade: cap(li.criticidade), status: cap(li.statusSolicitacao),
      ultimoStatus: li.historicoAtual && li.historicoAtual.status ? li.historicoAtual.status.descricao : '',
      orgao: li.orgao ? li.orgao.orgao : '', meio: li.meioComunicacao ? li.meioComunicacao.descricao : '',
      tipo: li.tipoSolicitacao ? li.tipoSolicitacao.descricao : '', sla: slaTexto(li.tempoRestante)
    };
  }

  async function processarItem(it) {
    const id = it.id;
    S.etapaBase = `${NOME_CAIXA[it.caixa]} · ${id}`;
    S.etapa = `${S.etapaBase} · abrindo solicitação`; S.atual = it.key; agendarRender();
    it.tentativas = (it.tentativas || 0) + 1; it.ultimaTentativaEm = agoraISO();
    const avisos = []; const etapas = {};
    try {
      const det = await apiGet(`/solicitacoes/detalhes/${id}`);
      etapas.detalhe = true;
      let caminho = '';
      try { const bc = await apiGet(`/solicitacoes/${id}/breadcrumb`); caminho = Array.isArray(bc) ? bc.join(' > ') : ''; etapas.caminho = true; }
      catch (e) { if (e instanceof ErroSessao) throw e; avisos.push('Caminho não lido: ' + e.message); }
      let formTxt = ''; const formEsperado = !!(det.idFormulario && det.idRegistroFormulario);
      if (formEsperado) {
        S.etapa = `${S.etapaBase} · formulário`; agendarRender();
        const form = await lerFormulario(det.idFormulario);
        const reg = await apiGet(`/formulario/${det.idFormulario}/registro/${det.idRegistroFormulario}`);
        formTxt = textoFormulario(form, reg, S.cfg.sensiveis); etapas.formulario = true;
      }
      const p = det.pessoa || {};
      const dados = {
        id: det.id, dataAbertura: det.dataCadastro || null, tipo: det.tipoSolicitacao ? det.tipoSolicitacao.descricao : '', caminho,
        solicitante: p.nome || '', meio: det.meioComunicacao ? det.meioComunicacao.descricao : '',
        orgao: det.orgaoTratamento || (it.lista && it.lista.orgao) || '', status: cap(det.statusSolicitacao),
        ultimoStatus: det.historicoAtual && det.historicoAtual.status ? det.historicoAtual.status.descricao : '',
        dataUltimoStatus: det.historicoAtual ? det.historicoAtual.dataAlteracao || null : null,
        responsavel: det.usuarioTratamento ? det.usuarioTratamento.nome || '' : '',
        criticidade: (it.lista && it.lista.criticidade) || '', dataLimite: det.dataLimite || null,
        sla: slaTexto(det.tempoRestante) || (it.lista && it.lista.sla) || '', sigilo: det.sigilo ? 'Sim' : 'Não',
        anexos: Array.isArray(det.anexos) ? det.anexos.length : 0, descricao: htmlParaTexto(det.descricao), formulario: formTxt
      };
      if (S.cfg.sensiveis) dados.sens = { cpf: p.cpf || '', email: p.email || '', telefone: (p.telefones || []).map(t => `(${t.ddd ?? ''}) ${t.numero ?? ''}`.trim()).join(', ') };
      let historico = null, propostas = null, hTotal = null, hLidos = null;
      if (it.caixa === 'ATRIBUIDAS') {
        const hist = await lerHistorico(id, det.idOrgao);
        hTotal = hist.total; hLidos = hist.registros.length; etapas.historico = `${hLidos}/${hTotal ?? '?'}`;
        if (hist.brutos !== hist.registros.length) avisos.push(`Histórico com ${hist.brutos - hist.registros.length} registro(s) repetido(s) na paginação do sistema (desconsiderados)`);
        historico = hist.registros.map(r => {
          const x = r.historico || {};
          return {
            data: x.dataAlteracao || null, status: x.status ? x.status.descricao : '',
            operador: (r.nomeUsuarioAlteracao || '') + (r.loginUsuarioAlteracao ? ` (${r.loginUsuarioAlteracao})` : ''),
            orgao: r.descricaoOrgao || (x.orgao && x.orgao.orgao) || '', meio: x.meioComunicacaoTratamentoDescricao || '',
            texto: htmlParaTexto(x.resposta), nota: htmlParaTexto(x.notaTratamento)
          };
        }).sort((a, b) => (toDate(b.data) || 0) - (toDate(a.data) || 0));
        propostas = historico.filter(x => norm(x.status).includes('proposta de resposta'));
      }
      it.dados = dados; it.historico = historico; it.propostas = propostas; it.historicoTotal = hTotal; it.historicoLidos = hLidos; it.etapas = etapas;
      const prob = validar(it, formEsperado);
      it.problemas = prob.problemas; it.avisos = avisos.concat(prob.avisos); it.erros = [];
      if (prob.problemas.length) { it.conf = 'incompleta'; await log('aviso', 'Conferência incompleta: ' + prob.problemas.join('; '), it); }
      else {
        it.conf = 'verificada'; it.verificadoEm = agoraISO();
        const extra = it.caixa === 'ATRIBUIDAS' ? (propostas.length ? ` · ${propostas.length} proposta(s) de resposta, mais recente em ${fmtDT(propostas[0].data)}` : ' · sem proposta de resposta no histórico') : '';
        await log('ok', `Verificada${extra}`, it);
      }
    } catch (e) {
      if (e instanceof ErroSessao) { it.tentativas--; throw e; }
      it.conf = 'erro'; it.erros = [e.message || String(e)]; it.avisos = avisos;
      await log('erro', `Falha na extração (tentativa ${it.tentativas}): ${e.message || e}`, it);
    }
    await DB.put('items', it);
  }

  function validar(it, formEsperado) {
    const problemas = [], avisos = []; const d = it.dados;
    if (String(d.id) !== String(it.id)) problemas.push(`O sistema devolveu a solicitação ${d.id} ao pedir ${it.id}`);
    if (!d.dataAbertura) problemas.push('Data de abertura não informada pelo sistema');
    if (!d.orgao) problemas.push('Órgão não informado pelo sistema');
    if (!d.ultimoStatus) avisos.push('Status atual não informado pelo sistema');
    if (formEsperado && !(it.etapas && it.etapas.formulario)) problemas.push('Formulário não lido');
    if (it.caixa === 'ATRIBUIDAS') {
      if (it.historicoTotal == null) problemas.push('O sistema não informou o total de registros do histórico');
      else if (it.historicoLidos !== it.historicoTotal) problemas.push(`Histórico incompleto: ${it.historicoLidos} de ${it.historicoTotal} registros lidos`);
      (it.propostas || []).forEach((p, i) => {
        if (!p.data) problemas.push(`Proposta de resposta nº ${i + 1} sem data`);
        if (!p.texto) avisos.push(`Proposta de ${fmtDT(p.data)} registrada sem texto no sistema`);
      });
    }
    return { problemas, avisos };
  }

  async function iniciarConferencia() {
    if (S.executando) return;
    S.executando = true; agendarRender();
    S.run = { id: 'C' + Date.now(), inicio: agoraISO(), fim: null, estado: 'executando', listas: {}, operador: '' };
    await salvarMeta('run', S.run);
    await log('info', 'Nova conferência iniciada');
    await executar();
  }

  async function retomar() {
    if (S.executando || !S.run) return;
    S.executando = true; agendarRender();
    S.run.estado = 'executando'; S.run.motivo = ''; await salvarMeta('run', S.run);
    await log('info', 'Conferência retomada');
    await executar();
  }

  async function reprocessarErros() {
    if (S.executando || !S.run) return;
    const alvo = [...S.items.values()].filter(i => i.naCaixa && i.runId === S.run.id && (i.conf === 'erro' || i.conf === 'incompleta'));
    if (!alvo.length) { aviso('Não há solicitações com erro ou incompletas nesta conferência.'); return; }
    S.executando = true; agendarRender();
    alvo.forEach(i => { i.conf = 'pendente'; });
    await DB.putMany('items', alvo);
    S.run.estado = 'executando'; S.run.fim = null; await salvarMeta('run', S.run);
    await log('info', `Reprocessando ${alvo.length} solicitação(ões) com erro ou incompletas`);
    await executar();
  }

  async function executar() {
    S.executando = true; S.parar = false; S.banner = null; agendarRender();
    try {
      if (!S.run.operador) {
        try { const u = await apiGet('/usuarios/logged', { tentativas: 1 }); S.run.operador = (u && (u.nome || u.name || (u.usuario && u.usuario.nome) || u.login)) || ''; } catch (e) { if (e instanceof ErroSessao) throw e; }
      }
      for (const cx of CAIXAS) {
        if (S.run.listas[cx]) continue;
        const L = await listarCaixa(cx);
        const ids = new Set(L.itens.map(x => String(x.id)));
        const mudados = [];
        for (const li of L.itens) {
          const key = `${cx}:${li.id}`; let it = S.items.get(key);
          if (!it) { it = novoItem(cx, li.id); S.items.set(key, it); }
          else if (!it.naCaixa) { it.naCaixa = true; it.voltouEm = agoraISO(); await log('info', 'Voltou a constar na caixa', it); }
          it.naCaixa = true; it.saiuDaCaixaEm = null; it.lista = resumoLista(li); it.runId = S.run.id; it.conf = 'pendente'; it.tentativas = 0; it.erros = []; it.problemas = [];
          mudados.push(it);
        }
        for (const it of S.items.values()) {
          if (it.caixa === cx && it.naCaixa && !ids.has(String(it.id))) {
            it.naCaixa = false; it.saiuDaCaixaEm = agoraISO(); mudados.push(it);
            await log('aviso', `Não consta mais na caixa ${NOME_CAIXA[cx]} (registro mantido para rastreabilidade)`, it);
          }
        }
        await DB.putMany('items', mudados);
        for (const d of L.dups) await log('dup', `Solicitação ${d} apareceu repetida na listagem do sistema (${NOME_CAIXA[cx]}); considerada uma única vez`);
        S.run.listas[cx] = { totalSistema: L.total, listadas: L.itens.length, em: agoraISO(), dups: L.dups };
        if (L.total !== null && L.itens.length !== L.total) await log('aviso', `${NOME_CAIXA[cx]}: o sistema informa ${L.total}, foram listadas ${L.itens.length}`);
        await log('info', `${NOME_CAIXA[cx]}: ${L.itens.length} solicitação(ões) listada(s) (total informado pelo sistema: ${L.total ?? '?'})`);
        await salvarMeta('run', S.run);
      }
      const rec = new Set([...S.items.values()].filter(i => i.caixa === 'RECEBIDAS' && i.naCaixa).map(i => i.id));
      const ambas = [...S.items.values()].filter(i => i.caixa === 'ATRIBUIDAS' && i.naCaixa && rec.has(i.id));
      if (ambas.length && !S.run.avisouAmbas) { S.run.avisouAmbas = true; for (const i of ambas) await log('dup', `Solicitação ${i.id} consta nas duas caixas (Recebidas e Atribuídas)`); }

      const fila = [...S.items.values()].filter(i => i.naCaixa && i.runId === S.run.id && i.conf === 'pendente')
        .sort((a, b) => (a.caixa === b.caixa ? a.id - b.id : a.caixa === 'RECEBIDAS' ? -1 : 1));
      for (const it of fila) {
        if (S.parar) break;
        await processarItem(it);
        agendarRender();
        if (S.cfg.intervalo > 0) await sleep(S.cfg.intervalo);
      }
      if (S.parar) { S.run.estado = 'pausado'; S.run.motivo = 'Pausada pelo usuário'; await log('info', 'Conferência pausada pelo usuário'); }
      else {
        S.run.estado = 'concluido'; S.run.fim = agoraISO();
        const c = contagens();
        await log('info', `Conferência concluída: ${c.total.analisadas} analisadas, ${c.total.verificadas} concluídas, ${c.total.pendentes} pendentes (${c.total.erros} com erro, ${c.total.incompletas} incompletas)`);
      }
    } catch (e) {
      S.run.estado = 'pausado';
      if (e instanceof ErroSessao) {
        S.run.motivo = 'Sessão do SIGRC expirada';
        S.banner = { tipo: 'erro', txt: 'A sessão do SIGRC expirou ou perdeu a permissão. Faça login novamente; depois clique no favorito "Conferência SIGRC" e em "Retomar". Nada do que já foi verificado se perde.' };
        await log('erro', 'Conferência pausada: ' + e.message);
      } else {
        S.run.motivo = 'Falha: ' + (e.message || e);
        S.banner = { tipo: 'erro', txt: 'A conferência foi pausada por uma falha de comunicação: ' + (e.message || e) + '. Clique em "Retomar" para continuar de onde parou.' };
        await log('erro', 'Conferência pausada por falha: ' + (e.message || e));
      }
    } finally {
      S.executando = false; S.parar = false; S.etapa = ''; S.atual = null;
      await salvarMeta('run', S.run);
      agendarRender();
    }
  }

  function contagens() {
    const z = () => ({ naCaixa: 0, verificadas: 0, pendentes: 0, erros: 0, incompletas: 0, analisadas: 0, comProposta: 0, semProposta: 0, fora: 0 });
    const c = { RECEBIDAS: z(), ATRIBUIDAS: z(), total: z() };
    const rid = S.run && S.run.id;
    for (const it of S.items.values()) {
      const k = c[it.caixa]; if (!k) continue;
      if (!it.naCaixa) { k.fora++; c.total.fora++; continue; }
      const add = (campo) => { k[campo]++; c.total[campo]++; };
      add('naCaixa');
      const conf = it.runId === rid ? it.conf : 'pendente';
      if (conf === 'verificada') { add('verificadas'); add('analisadas'); if (it.caixa === 'ATRIBUIDAS') add((it.propostas || []).length ? 'comProposta' : 'semProposta'); }
      else if (conf === 'erro') { add('erros'); add('pendentes'); add('analisadas'); }
      else if (conf === 'incompleta') { add('incompletas'); add('pendentes'); add('analisadas'); }
      else add('pendentes');
    }
    return c;
  }

  /* ───────────────────────── colunas da planilha ───────────────────────── */
  const COLS_COMUNS = [
    { k: 'id', h: 'Nº Solicitação', w: 13, t: 'num', syn: ['n solicitacao', 'no solicitacao', 'numero da solicitacao', 'numero solicitacao', 'solicitacao', 'n da solicitacao', 'nº', 'numero', 'protocolo'] },
    { k: 'dataAbertura', h: 'Data/hora de abertura', w: 19, t: 'date', syn: ['data e hora', 'data abertura', 'data de abertura', 'data hora', 'data cadastro', 'abertura', 'data'] },
    { k: 'tipo', h: 'Tipo de solicitação', w: 42, syn: ['tipo', 'assunto', 'tipo solicitacao', 'dados da solicitacao'] },
    { k: 'caminho', h: 'Caminho', w: 16 },
    { k: 'solicitante', h: 'Solicitante', w: 30, syn: ['nome do solicitante', 'municipe', 'nome'] },
    { k: 'meio', h: 'Meio de comunicação', w: 14, syn: ['canal', 'meio'] },
    { k: 'orgao', h: 'Órgão', w: 36, syn: ['orgao tratamento', 'orgao responsavel', 'unidade'] },
    { k: 'status', h: 'Status da solicitação', w: 16, syn: ['status'] },
    { k: 'ultimoStatus', h: 'Último status (histórico)', w: 26, syn: ['ultimo status', 'historico atual', 'situacao atual'] },
    { k: 'dataUltimoStatus', h: 'Data do último status', w: 19, t: 'date' },
    { k: 'responsavel', h: 'Responsável pelo tratamento', w: 28, syn: ['responsavel', 'atribuido a', 'operador responsavel'] },
    { k: 'criticidade', h: 'Criticidade', w: 11, syn: ['tipo de criticidade'] },
    { k: 'dataLimite', h: 'Data limite', w: 19, t: 'date', syn: ['prazo', 'vencimento'] },
    { k: 'sla', h: 'SLA na conferência', w: 17, syn: ['sla', 'prazo sla'] },
    { k: 'sigilo', h: 'Sigilo', w: 8 },
    { k: 'anexos', h: 'Anexos (qtd.)', w: 9, t: 'num', syn: ['anexos'] },
    { k: 'descricao', h: 'Descrição', w: 70, wrap: true, syn: ['descricao da solicitacao', 'relato'] },
    { k: 'formulario', h: 'Dados do formulário', w: 55, wrap: true },
    { k: 'cpf', h: 'CPF do solicitante', w: 16, sens: true },
    { k: 'email', h: 'E-mail do solicitante', w: 28, sens: true },
    { k: 'telefone', h: 'Telefone do solicitante', w: 20, sens: true }
  ];
  const COLS_ATRIB = [
    { k: 'possuiProposta', h: 'Possui proposta de resposta', w: 12 },
    { k: 'qtdPropostas', h: 'Qtd. propostas de resposta', w: 11, t: 'num' },
    { k: 'propData', h: 'Data da proposta mais recente', w: 19, t: 'date', syn: ['data da proposta', 'data proposta de resposta', 'data proposta', 'data da proposta de resposta'] },
    { k: 'propOperador', h: 'Operador da proposta mais recente', w: 30 },
    { k: 'propOrgao', h: 'Órgão da proposta mais recente', w: 32 },
    { k: 'propMeio', h: 'Meio da proposta mais recente', w: 12 },
    { k: 'propTexto', h: 'Proposta de resposta mais recente (texto integral)', w: 80, wrap: true, syn: ['proposta de resposta', 'resposta', 'texto da resposta', 'conteudo da resposta', 'texto da proposta'] },
    { k: 'propAnteriores', h: 'Propostas anteriores (data · operador · texto)', w: 80, wrap: true },
    { k: 'historicoResumo', h: 'Histórico (data · status · operador)', w: 60, wrap: true },
    { k: 'historicoLidos', h: 'Registros do histórico lidos', w: 12 }
  ];
  const COLS_CONF = [
    { k: 'situacaoCaixa', h: 'Situação na caixa', w: 24 },
    { k: 'conf', h: 'Conferência', w: 13, syn: ['status da conferencia', 'conferido', 'situacao da conferencia'] },
    { k: 'verificadoEm', h: 'Verificada em', w: 19, t: 'date', syn: ['data da verificacao', 'data verificacao', 'conferido em'] },
    { k: 'obs', h: 'Observações da conferência', w: 50, wrap: true }
  ];
  const colsDe = cx => (cx === 'ATRIBUIDAS' ? [...COLS_COMUNS, ...COLS_ATRIB, ...COLS_CONF] : [...COLS_COMUNS, ...COLS_CONF]);
  const DEF = Object.fromEntries([...COLS_COMUNS, ...COLS_ATRIB, ...COLS_CONF].map(d => [d.k, d]));

  function linha(it) {
    const L = { id: Number(it.id) }; const d = it.dados; const l = it.lista || {};
    if (d) {
      Object.assign(L, {
        dataAbertura: toDate(d.dataAbertura), tipo: d.tipo, caminho: d.caminho, solicitante: d.solicitante, meio: d.meio, orgao: d.orgao,
        status: d.status, ultimoStatus: d.ultimoStatus, dataUltimoStatus: toDate(d.dataUltimoStatus), responsavel: d.responsavel,
        criticidade: d.criticidade, dataLimite: toDate(d.dataLimite), sla: d.sla, sigilo: d.sigilo, anexos: d.anexos, descricao: d.descricao, formulario: d.formulario
      });
      if (d.sens) Object.assign(L, { cpf: d.sens.cpf, email: d.sens.email, telefone: d.sens.telefone });
    } else {
      Object.assign(L, { dataAbertura: toDate(l.dataCadastro), tipo: l.tipo, meio: l.meio, orgao: l.orgao, status: l.status, ultimoStatus: l.ultimoStatus, criticidade: l.criticidade, dataLimite: toDate(l.dataLimite), sla: l.sla });
    }
    if (it.caixa === 'ATRIBUIDAS' && d && it.propostas) {
      const ps = it.propostas; const r = ps[0];
      Object.assign(L, {
        possuiProposta: ps.length ? 'Sim' : 'Não', qtdPropostas: ps.length, propData: r ? toDate(r.data) : null,
        propOperador: r ? r.operador : '', propOrgao: r ? r.orgao : '', propMeio: r ? r.meio : '',
        propTexto: r ? (r.texto || '(proposta registrada sem texto no sistema)') : 'Sem proposta de resposta no histórico',
        propAnteriores: ps.slice(1).map(p => `${fmtDT(p.data)} · ${p.operador || '-'}\n${p.texto || '(sem texto no sistema)'}`).join('\n\n———\n\n'),
        historicoResumo: (it.historico || []).map(x => `${fmtDT(x.data)} · ${x.status} · ${x.operador || '-'}`).join('\n'),
        historicoLidos: `${it.historicoLidos} de ${it.historicoTotal ?? '?'}`
      });
    }
    const confAtual = S.run && it.runId === S.run.id ? it.conf : 'pendente';
    L.situacaoCaixa = it.naCaixa ? 'Na caixa' : `Não consta na caixa desde ${fmtDT(it.saiuDaCaixaEm)}`;
    L.conf = it.naCaixa ? CONF_LBL[confAtual] : (it.verificadoEm ? 'Verificada' : CONF_LBL[it.conf] || 'Pendente');
    const ok = it.naCaixa ? confAtual === 'verificada' : !!it.verificadoEm;
    L.verificadoEm = ok ? toDate(it.verificadoEm) : null;
    const obs = [...(it.problemas || []), ...(it.erros || []), ...(it.avisos || [])];
    if (d && !ok && it.verificadoEm) obs.push(`Dados exibidos são da verificação anterior (${fmtDT(it.verificadoEm)})`);
    if (!d) obs.push('Dados ainda não extraídos do detalhe; campos preenchidos a partir da listagem do sistema');
    L.obs = obs.join('; ');
    return L;
  }

  /* ───────────────────────── planilha base: importação e mesclagem ───────────────────────── */
  function analisarAba(sh, cx) {
    const defs = colsDe(cx); const syn = new Map();
    defs.forEach(d => { syn.set(norm(d.h), d.k); });
    defs.forEach(d => (d.syn || []).forEach(s => { if (!syn.has(norm(s))) syn.set(norm(s), d.k); }));
    let hr = 0, best = -1;
    for (let r = 0; r < Math.min(20, sh.rows.length); r++) {
      const n = (sh.rows[r] || []).filter(c => c && c.v != null && syn.has(norm(c.v))).length;
      if (n > best) { best = n; hr = r; }
    }
    const hdr = (sh.rows[hr] || []).map(c => (c && c.v != null ? String(c.v instanceof Date ? fmtDT(c.v) : c.v) : ''));
    while (hdr.length && !hdr[hdr.length - 1].trim()) hdr.pop();
    const usados = new Set();
    const keyOfCol = hdr.map(t => { const k = syn.get(norm(t)); if (!k || usados.has(k)) return null; usados.add(k); return k; });
    const idCol = keyOfCol.indexOf('id');
    if (idCol < 0) return { erro: `Não encontrei a coluna com o número da solicitação na aba "${sh.name}".` };
    const linhas = [], semId = [], dups = []; const pos = new Map();
    for (let r = hr + 1; r < sh.rows.length; r++) {
      const row = (sh.rows[r] || []).slice(0, Math.max(hdr.length, (sh.rows[r] || []).length)).map(c => (c ? c.v : null));
      if (!row.some(v => v !== null && v !== '')) continue;
      const raw = row[idCol]; const m = raw == null ? null : String(raw).match(/\d{5,}/);
      if (!m) { semId.push({ linha: r + 1, cells: row }); continue; }
      const id = m[0];
      if (pos.has(id)) {
        const alvo = linhas[pos.get(id)];
        keyOfCol.forEach((k, ci) => { if (k) return; const v = row[ci]; if (v == null || v === '') return; const a = alvo.cells[ci]; if (a == null || a === '') alvo.cells[ci] = v; else if (String(a) !== String(v)) alvo.cells[ci] = `${a} | ${v}`; });
        dups.push({ id, linha: r + 1, linhaOriginal: alvo.linha });
        continue;
      }
      pos.set(id, linhas.length); linhas.push({ id, linha: r + 1, cells: row });
    }
    return { nome: sh.name, headerRow: hr, pre: sh.rows.slice(0, hr).map(rw => (rw || []).map(c => (c ? c.v : null))), headers: hdr, keyOfCol, linhas, semId, dups };
  }

  async function importarPlanilha(file) {
    if (!/\.xlsx$/i.test(file.name)) { aviso('Use um arquivo .xlsx (se a planilha estiver em .xls ou .csv, salve como .xlsx no Excel).'); return; }
    let wb;
    try { wb = await XLSX.ler(await file.arrayBuffer()); }
    catch (e) { aviso('Não consegui ler a planilha: ' + e.message); await log('erro', `Falha ao importar "${file.name}": ${e.message}`); return; }
    const base = { arquivo: file.name, importadoEm: agoraISO(), abas: {}, outras: [], formulas: wb.formulas };
    for (const sh of wb.sheets) {
      const n = norm(sh.name);
      if (['resumo', 'auditoria', 'log', 'relatorio'].includes(n)) continue;
      const cx = n.includes('receb') ? 'RECEBIDAS' : n.includes('atribu') ? 'ATRIBUIDAS' : null;
      if (cx && !base.abas[cx]) {
        const a = analisarAba(sh, cx);
        if (a.erro) { base.outras.push({ nome: sh.name, rows: sh.rows.map(rw => (rw || []).map(c => (c ? c.v : null))), motivo: a.erro }); await log('aviso', a.erro + ' Aba mantida sem alterações.'); }
        else base.abas[cx] = a;
      } else base.outras.push({ nome: sh.name, rows: sh.rows.map(rw => (rw || []).map(c => (c ? c.v : null))) });
    }
    S.base = base; await salvarMeta('base', stripBruto(base));
    let msg = `Planilha "${file.name}" importada.`;
    for (const cx of CAIXAS) {
      const a = base.abas[cx]; if (!a) continue;
      msg += ` ${NOME_CAIXA[cx]}: ${a.linhas.length} linha(s), ${a.headers.length} coluna(s)` + (a.dups.length ? `, ${a.dups.length} duplicidade(s)` : '') + '.';
      for (const d of a.dups) await log('dup', `Planilha base (${a.nome}): solicitação ${d.id} repetida na linha ${d.linha} (original na linha ${d.linhaOriginal}); linhas unificadas`);
    }
    if (wb.formulas) await log('aviso', `A planilha base tem ${wb.formulas} fórmula(s); na exportação elas são mantidas como valores.`);
    await log('info', msg);
    abrirImportacao();
  }
  const stripBruto = b => ({ ...b, outras: b.outras.map(o => ({ nome: o.nome, rows: o.rows, motivo: o.motivo })) });

  async function usarAbaComo(nome, cx) {
    const o = S.base.outras.find(x => x.nome === nome); if (!o) return;
    const sh = { name: o.nome, rows: o.rows.map(rw => rw.map(v => (v == null ? null : { v }))) };
    const a = analisarAba(sh, cx);
    if (a.erro) { aviso(a.erro); return; }
    if (S.base.abas[cx]) S.base.outras.push({ nome: S.base.abas[cx].nome, rows: [S.base.abas[cx].headers, ...S.base.abas[cx].linhas.map(l => l.cells)] });
    S.base.abas[cx] = a; S.base.outras = S.base.outras.filter(x => x !== o);
    await salvarMeta('base', stripBruto(S.base));
    await log('info', `Aba "${nome}" da planilha base passa a ser usada como ${NOME_CAIXA[cx]}`);
    abrirImportacao();
  }

  function montarAba(cx) {
    const base = S.base && S.base.abas[cx]; const defs = colsDe(cx); const sens = S.cfg.sensiveis;
    let headers, keyOfCol;
    if (base) {
      headers = base.headers.slice(); keyOfCol = base.keyOfCol.slice();
      for (const d of defs) if (!keyOfCol.includes(d.k) && (!d.sens || sens)) { headers.push(d.h); keyOfCol.push(d.k); }
    } else { const ds = defs.filter(d => !d.sens || sens); headers = ds.map(d => d.h); keyOfCol = ds.map(d => d.k); }
    const itens = [...S.items.values()].filter(i => i.caixa === cx).sort((a, b) => a.id - b.id);
    const porId = new Map(itens.map(i => [String(i.id), i]));
    const rows = []; const usados = new Set();
    const st = { novas: 0, atualizadas: 0, semCorrespondencia: 0, semNumero: 0, dupBase: base ? base.dups.length : 0, colunasPreservadas: base ? base.keyOfCol.filter(k => !k).length : 0 };
    const sc = keyOfCol.indexOf('situacaoCaixa');
    const preencher = (row, it) => { const L = linha(it); keyOfCol.forEach((k, ci) => { if (!k || L[k] === undefined) return; if (DEF[k] && DEF[k].sens && !sens) return; row[ci] = L[k]; }); };
    if (base) {
      for (const bl of base.linhas) {
        const row = bl.cells.slice(0, headers.length); while (row.length < headers.length) row.push(null);
        const it = porId.get(String(bl.id));
        if (it) { preencher(row, it); usados.add(String(it.id)); st.atualizadas++; }
        else { if (sc >= 0) row[sc] = 'Não encontrada nas caixas consultadas'; st.semCorrespondencia++; }
        rows.push(row);
      }
      for (const s of base.semId) { const row = s.cells.slice(0, headers.length); while (row.length < headers.length) row.push(null); rows.push(row); st.semNumero++; }
    }
    for (const it of itens) {
      if (usados.has(String(it.id))) continue;
      const row = new Array(headers.length).fill(null); preencher(row, it); rows.push(row); st.novas++;
    }
    const idCol = keyOfCol.indexOf('id'); const vistos = new Set();
    for (const r of rows) { const v = r[idCol]; if (v == null || v === '') continue; const s = String(v).replace(/\D/g, ''); if (vistos.has(s)) throw new Error(`Duplicidade detectada ao montar a aba ${NOME_CAIXA[cx]}: ${s}. Exportação cancelada.`); vistos.add(s); }
    return { headers, keyOfCol, rows, st, pre: base ? base.pre : [] };
  }

  async function atualizarPlanilha(silencioso) {
    const r = {}; for (const cx of CAIXAS) r[cx] = montarAba(cx);
    S.atualizacao = { em: agoraISO(), st: { RECEBIDAS: r.RECEBIDAS.st, ATRIBUIDAS: r.ATRIBUIDAS.st }, base: S.base ? S.base.arquivo : null };
    await salvarMeta('atualizacao', S.atualizacao);
    if (!silencioso) {
      await log('info', `Planilha atualizada: Recebidas ${r.RECEBIDAS.st.novas} nova(s) / ${r.RECEBIDAS.st.atualizadas} atualizada(s); Atribuídas ${r.ATRIBUIDAS.st.novas} nova(s) / ${r.ATRIBUIDAS.st.atualizadas} atualizada(s)`);
      S.aba = 'RELATORIO';
    }
    return r;
  }

  async function exportarExcel() {
    let r;
    try { r = await atualizarPlanilha(true); } catch (e) { aviso(e.message); await log('erro', e.message); return; }
    const c = contagens(); const run = S.run || {};
    const folhas = []; const truncs = [];
    const confStyle = v => (v === 'Verificada' ? 6 : v === 'Erro' ? 8 : v === 'Pendente' || v === 'Incompleta' ? 7 : null);
    for (const cx of CAIXAS) {
      const a = r[cx]; const hRow = a.pre.length;
      const widths = a.keyOfCol.map((k, i) => (k && DEF[k] ? DEF[k].w : Math.min(40, Math.max(10, String(a.headers[i] || '').length + 2))));
      const wrap = a.keyOfCol.map(k => !!(k && DEF[k] && DEF[k].wrap));
      const confCol = a.keyOfCol.indexOf('conf');
      folhas.push({
        nome: NOME_CAIXA[cx], linhas: [...a.pre, a.headers, ...a.rows], headerRow: hRow, widths, wrap,
        estilo: (ri, ci, v) => (ci === confCol && ri > hRow ? confStyle(v) : null), truncs, filtro: true
      });
    }
    const resumo = [
      ['Relatório da conferência SIGRC'], [],
      ['Conferência', run.id || '-'], ['Início', toDate(run.inicio)], ['Término', toDate(run.fim)], ['Situação', ({ executando: 'Em execução', pausado: 'Pausada', interrompido: 'Interrompida', concluido: 'Concluída' })[run.estado] || '-'],
      ['Executada por', run.operador || '-'], ['Planilha gerada em', new Date()], ['Planilha base', S.base ? S.base.arquivo : 'Nenhuma (modelo padrão)'], [],
      ['Indicador', 'Recebidas', 'Atribuídas', 'Total'],
      (() => { const a = run.listas && run.listas.RECEBIDAS ? run.listas.RECEBIDAS.totalSistema : null, b = run.listas && run.listas.ATRIBUIDAS ? run.listas.ATRIBUIDAS.totalSistema : null; return ['Total informado pelo sistema', a, b, a != null && b != null ? a + b : null]; })(),
      ['Na caixa (listadas)', c.RECEBIDAS.naCaixa, c.ATRIBUIDAS.naCaixa, c.total.naCaixa],
      ['Analisadas', c.RECEBIDAS.analisadas, c.ATRIBUIDAS.analisadas, c.total.analisadas],
      ['Concluídas (verificadas)', c.RECEBIDAS.verificadas, c.ATRIBUIDAS.verificadas, c.total.verificadas],
      ['Pendentes', c.RECEBIDAS.pendentes, c.ATRIBUIDAS.pendentes, c.total.pendentes],
      ['   das quais com erro', c.RECEBIDAS.erros, c.ATRIBUIDAS.erros, c.total.erros],
      ['   das quais incompletas', c.RECEBIDAS.incompletas, c.ATRIBUIDAS.incompletas, c.total.incompletas],
      ['Com proposta de resposta', null, c.ATRIBUIDAS.comProposta, c.ATRIBUIDAS.comProposta],
      ['Sem proposta de resposta', null, c.ATRIBUIDAS.semProposta, c.ATRIBUIDAS.semProposta],
      ['Fora da caixa (mantidas p/ rastreabilidade)', c.RECEBIDAS.fora, c.ATRIBUIDAS.fora, c.total.fora],
      ['Duplicidades registradas', null, null, S.logs.filter(l => l.tipo === 'dup' && (!run.id || l.runId === run.id || !l.runId)).length], [],
      ['Planilha', 'Recebidas', 'Atribuídas'],
      ['Linhas novas', r.RECEBIDAS.st.novas, r.ATRIBUIDAS.st.novas],
      ['Linhas atualizadas', r.RECEBIDAS.st.atualizadas, r.ATRIBUIDAS.st.atualizadas],
      ['Linhas da base sem correspondência nas caixas', r.RECEBIDAS.st.semCorrespondencia, r.ATRIBUIDAS.st.semCorrespondencia],
      ['Linhas da base sem número', r.RECEBIDAS.st.semNumero, r.ATRIBUIDAS.st.semNumero],
      ['Duplicidades unificadas na base', r.RECEBIDAS.st.dupBase, r.ATRIBUIDAS.st.dupBase],
      ['Colunas próprias da base preservadas', r.RECEBIDAS.st.colunasPreservadas, r.ATRIBUIDAS.st.colunasPreservadas]
    ];
    folhas.push({ nome: 'Resumo', linhas: resumo, headerRow: -1, widths: [44, 22, 22, 14], wrap: [true, false, false, false], estilo: (ri, ci) => (ri === 0 ? 10 : (ri === 10 || ri === 23) ? 1 : ci === 0 && ri > 1 ? 9 : null), truncs });
    const aud = [['Caixa', 'Nº Solicitação', 'Conferência', 'Verificada em', 'Última tentativa', 'Tentativas', 'Etapas lidas', 'Problemas e erros', 'Avisos', 'Situação na caixa']];
    for (const it of [...S.items.values()].sort((a, b) => (a.caixa === b.caixa ? a.id - b.id : a.caixa < b.caixa ? 1 : -1))) {
      const L = linha(it); const e = it.etapas || {};
      aud.push([NOME_CAIXA[it.caixa], it.id, L.conf, L.verificadoEm, toDate(it.ultimaTentativaEm), it.tentativas || 0,
        [e.detalhe ? 'Detalhe' : null, e.caminho ? 'Caminho' : null, e.formulario ? 'Formulário' : null, e.historico ? `Histórico ${e.historico}` : null].filter(Boolean).join(', '),
        [...(it.problemas || []), ...(it.erros || [])].join('; '), (it.avisos || []).join('; '), L.situacaoCaixa]);
    }
    folhas.push({ nome: 'Auditoria', linhas: aud, headerRow: 0, widths: [12, 14, 13, 19, 19, 10, 34, 50, 50, 26], wrap: [0, 0, 0, 0, 0, 0, 1, 1, 1, 0].map(Boolean), estilo: (ri, ci, v) => (ci === 2 && ri > 0 ? confStyle(v) : null), truncs, filtro: true });
    const lg = [['Data/hora', 'Tipo', 'Caixa', 'Nº Solicitação', 'Mensagem', 'Conferência']];
    const TIPO = { info: 'Informação', ok: 'Verificada', aviso: 'Aviso', erro: 'Erro', dup: 'Duplicidade' };
    for (const l of S.logs) lg.push([toDate(l.ts), TIPO[l.tipo] || l.tipo, l.caixa ? NOME_CAIXA[l.caixa] : '', l.id || null, l.msg, l.runId]);
    folhas.push({ nome: 'Log', linhas: lg, headerRow: 0, widths: [19, 12, 12, 14, 90, 16], wrap: [0, 0, 0, 0, 1, 0].map(Boolean), truncs, filtro: true });
    if (S.base) for (const o of S.base.outras) folhas.push({ nome: o.nome, linhas: o.rows, headerRow: -1, widths: [], wrap: [], truncs, original: true });
    let blob;
    try { blob = await XLSX.escrever(folhas); }
    catch (e) { aviso('Falha ao gerar o Excel: ' + e.message); await log('erro', 'Falha ao gerar o Excel: ' + e.message); return; }
    const n = new Date();
    const nomeArq = `conferencia-sigrc_${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}_${pad(n.getHours())}${pad(n.getMinutes())}.xlsx`;
    if (TESTE && window.__CONF_SIGRC_TEST__ && window.__CONF_SIGRC_TEST__.onExport) window.__CONF_SIGRC_TEST__.onExport(blob, nomeArq);
    else baixar(blob, nomeArq);
    if (truncs.length) await log('aviso', `${truncs.length} célula(s) ultrapassaram o limite do Excel (32.767 caracteres) e foram cortadas: ${truncs.slice(0, 10).join(', ')}`);
    await log('info', `Excel exportado: ${nomeArq} (Recebidas: ${r.RECEBIDAS.rows.length} linha(s); Atribuídas: ${r.ATRIBUIDAS.rows.length} linha(s))`);
    return { blob, nomeArq };
  }
  function baixar(blob, nome) {
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ───────────────────────── XLSX (leitura e escrita, sem bibliotecas) ───────────────────────── */
  const XLSX = (() => {
    const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    const crc32 = u => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const fluxo = async (u8, ts) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ts)).arrayBuffer());
    const deflate = u8 => fluxo(u8, new CompressionStream('deflate-raw'));
    const inflate = u8 => fluxo(u8, new DecompressionStream('deflate-raw'));
    const enc = new TextEncoder(), dec = new TextDecoder();

    async function zip(arqs) {
      const partes = [], central = []; let off = 0; const d = new Date();
      const tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      for (const f of arqs) {
        const nm = enc.encode(f.nome); const dados = typeof f.dados === 'string' ? enc.encode(f.dados) : f.dados;
        const crc = crc32(dados); const comp = await deflate(dados);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 8, true);
        lh.setUint16(10, tm, true); lh.setUint16(12, dt, true); lh.setUint32(14, crc, true); lh.setUint32(18, comp.length, true);
        lh.setUint32(22, dados.length, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
        partes.push(new Uint8Array(lh.buffer), nm, comp);
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 8, true);
        ch.setUint16(12, tm, true); ch.setUint16(14, dt, true); ch.setUint32(16, crc, true); ch.setUint32(20, comp.length, true); ch.setUint32(24, dados.length, true);
        ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
        central.push(new Uint8Array(ch.buffer), nm);
        off += 30 + nm.length + comp.length;
      }
      const tamCD = central.reduce((a, b) => a + b.length, 0);
      const eo = new DataView(new ArrayBuffer(22));
      eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, arqs.length, true); eo.setUint16(10, arqs.length, true); eo.setUint32(12, tamCD, true); eo.setUint32(16, off, true);
      return new Blob([...partes, ...central, new Uint8Array(eo.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }

    async function unzip(buf) {
      const u8 = new Uint8Array(buf); const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let eo = -1;
      for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eo = i; break; }
      if (eo < 0) throw new Error('o arquivo não é um .xlsx válido');
      const n = dv.getUint16(eo + 10, true); let p = dv.getUint32(eo + 16, true); const out = {};
      for (let k = 0; k < n; k++) {
        if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('estrutura interna do .xlsx inválida');
        const met = dv.getUint16(p + 10, true), cs = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
        const nome = dec.decode(u8.subarray(p + 46, p + 46 + nl));
        const ini = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
        const dados = u8.subarray(ini, ini + cs);
        out[nome] = met === 0 ? dados : met === 8 ? await inflate(dados) : null;
        p += 46 + nl + el + cl;
      }
      return out;
    }

    const xesc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const colL = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    const colI = s => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
    const serial = d => (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - Date.UTC(1899, 11, 30)) / 86400000;
    const deSerial = v => { const u = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000)); return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds()); };
    const nomeAba = (s, usados) => { let n = String(s || 'Planilha').replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31).trim() || 'Planilha'; let b = n, i = 2; while (usados.has(n.toLowerCase())) { n = (b.slice(0, 28) + ' ' + i++).slice(0, 31); } usados.add(n.toLowerCase()); return n; };
    const LIM = 32767;

    const ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm:ss"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="14"/><color rgb="FF1F3A5F"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDFF3E4"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF1CC"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFBDADA"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD5DBE3"/></left><right style="thin"><color rgb="FFD5DBE3"/></right><top style="thin"><color rgb="FFD5DBE3"/></top><bottom style="thin"><color rgb="FFD5DBE3"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

    function folhaXML(f, idxFolha) {
      const L = f.linhas; let maxC = 0; L.forEach(r => { if (r && r.length > maxC) maxC = r.length; });
      const partes = [];
      for (let ri = 0; ri < L.length; ri++) {
        const row = L[ri] || []; const cel = [];
        for (let ci = 0; ci < row.length; ci++) {
          let v = row[ci]; if (v === null || v === undefined || v === '') continue;
          const ref = colL(ci) + (ri + 1); const isH = ri === f.headerRow;
          const est = !isH && f.estilo ? f.estilo(ri, ci, v) : null;
          if (v instanceof Date) { if (isNaN(v)) continue; cel.push(`<c r="${ref}" s="${isH ? 1 : 3}"><v>${serial(v)}</v></c>`); }
          else if (typeof v === 'number' && isFinite(v)) cel.push(`<c r="${ref}" s="${isH ? 1 : est ?? (f.original ? 0 : 4)}"><v>${v}</v></c>`);
          else if (typeof v === 'boolean') cel.push(`<c r="${ref}" t="b" s="${isH ? 1 : 0}"><v>${v ? 1 : 0}</v></c>`);
          else {
            v = String(v);
            if (v.length > LIM) { v = v.slice(0, LIM - 40) + ' […TEXTO CORTADO: limite do Excel]'; f.truncs.push(`${f.nome}!${ref}`); }
            const s = isH ? 1 : est ?? (f.original ? 0 : f.wrap[ci] ? 2 : 5);
            cel.push(`<c r="${ref}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${xesc(v)}</t></is></c>`);
          }
        }
        partes.push(`<row r="${ri + 1}">${cel.join('')}</row>`);
      }
      const cols = (f.widths || []).map((w, i) => (w ? `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>` : '')).join('');
      const pane = f.headerRow >= 0 && L.length > f.headerRow + 1 ? `<pane ySplit="${f.headerRow + 1}" topLeftCell="A${f.headerRow + 2}" activePane="bottomLeft" state="frozen"/>` : '';
      const filtroRef = f.filtro && f.headerRow >= 0 && maxC ? `A${f.headerRow + 1}:${colL(maxC - 1)}${Math.max(L.length, f.headerRow + 1)}` : null;
      f._filtro = filtroRef;
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"${idxFolha === 0 ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${partes.join('')}</sheetData>${filtroRef ? `<autoFilter ref="${filtroRef}"/>` : ''}</worksheet>`;
    }

    async function escrever(folhas) {
      const usados = new Set(); folhas.forEach(f => { f.nome = nomeAba(f.nome, usados); });
      const arqs = []; const xmls = folhas.map((f, i) => folhaXML(f, i));
      const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${folhas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
      const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
      const nomes = folhas.map(f => f.nome);
      const defs = folhas.map((f, i) => (f._filtro ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xesc(f.nome.replace(/'/g, "''"))}'!${f._filtro.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : '')).join('');
      const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${nomes.map((n, i) => `<sheet name="${xesc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${defs ? `<definedNames>${defs}</definedNames>` : ''}</workbook>`;
      const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${folhas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${folhas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
      const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Conferência SIGRC</dc:title><dc:creator>Conferência SIGRC ${VERSAO}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`;
      arqs.push({ nome: '[Content_Types].xml', dados: ct }, { nome: '_rels/.rels', dados: rels }, { nome: 'docProps/core.xml', dados: core }, { nome: 'xl/workbook.xml', dados: wb }, { nome: 'xl/_rels/workbook.xml.rels', dados: wbRels }, { nome: 'xl/styles.xml', dados: ESTILOS });
      xmls.forEach((x, i) => arqs.push({ nome: `xl/worksheets/sheet${i + 1}.xml`, dados: x }));
      return zip(arqs);
    }

    const tags = (el, nome) => [...el.getElementsByTagNameNS('*', nome)];
    const xml = u8 => new DOMParser().parseFromString(dec.decode(u8), 'application/xml');
    const DATAS_FIXAS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

    async function ler(buf) {
      const z = await unzip(buf);
      const pegar = n => z[n] || z[n.replace(/^\//, '')] || null;
      if (!pegar('xl/workbook.xml')) throw new Error('o arquivo não contém uma pasta de trabalho do Excel');
      const sst = [];
      if (pegar('xl/sharedStrings.xml')) for (const si of tags(xml(pegar('xl/sharedStrings.xml')), 'si')) sst.push(tags(si, 't').filter(t => !(t.parentNode && t.parentNode.localName === 'rPh')).map(t => t.textContent).join(''));
      const dataXf = [];
      if (pegar('xl/styles.xml')) {
        const st = xml(pegar('xl/styles.xml')); const fmts = new Map();
        tags(st, 'numFmt').forEach(f => fmts.set(+f.getAttribute('numFmtId'), f.getAttribute('formatCode') || ''));
        const cx = tags(st, 'cellXfs')[0];
        if (cx) [...cx.children].filter(e => e.localName === 'xf').forEach((xf, i) => {
          const id = +(xf.getAttribute('numFmtId') || 0); const code = fmts.get(id);
          dataXf[i] = DATAS_FIXAS.has(id) || (!!code && /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) && !/^general$/i.test(code));
        });
      }
      const wbx = xml(pegar('xl/workbook.xml'));
      const rels = new Map(); if (pegar('xl/_rels/workbook.xml.rels')) tags(xml(pegar('xl/_rels/workbook.xml.rels')), 'Relationship').forEach(r => rels.set(r.getAttribute('Id'), r.getAttribute('Target')));
      const sheets = []; let formulas = 0;
      for (const s of tags(wbx, 'sheet')) {
        const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
        let alvo = rels.get(rid) || ''; alvo = alvo.startsWith('/') ? alvo.slice(1) : 'xl/' + alvo.replace(/^\.\//, '');
        const dados = pegar(alvo); if (!dados) continue;
        const doc = xml(dados); const rows = [];
        for (const r of tags(doc, 'row')) {
          const ri = (+r.getAttribute('r') || rows.length + 1) - 1; const arr = rows[ri] = rows[ri] || []; let auto = 0;
          for (const c of [...r.children].filter(e => e.localName === 'c')) {
            const ref = c.getAttribute('r'); const ci = ref ? colI(ref.replace(/\d+/g, '')) : auto; auto = ci + 1;
            const t = c.getAttribute('t') || 'n'; const s = +(c.getAttribute('s') || 0);
            const vEl = [...c.children].find(e => e.localName === 'v'); const fEl = [...c.children].find(e => e.localName === 'f');
            if (fEl) formulas++;
            let v = null;
            if (t === 's') v = vEl ? sst[+vEl.textContent] ?? '' : null;
            else if (t === 'inlineStr') v = tags(c, 't').map(x => x.textContent).join('');
            else if (t === 'str' || t === 'e') v = vEl ? vEl.textContent : null;
            else if (t === 'b') v = vEl ? vEl.textContent === '1' : null;
            else if (vEl && vEl.textContent !== '') { const n = Number(vEl.textContent); v = dataXf[s] && isFinite(n) ? deSerial(n) : n; }
            if (v !== null && v !== '') arr[ci] = { v };
          }
        }
        for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
        sheets.push({ name: s.getAttribute('name'), rows });
      }
      return { sheets, formulas };
    }
    return { escrever, ler, _zip: zip, _unzip: unzip };
  })();

  /* ───────────────────────── interface ───────────────────────── */
  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
[hidden]{display:none!important}
.ov{position:fixed;inset:0;z-index:2147483646;background:rgba(15,28,46,.55);display:flex;align-items:stretch;justify-content:center;padding:18px;font:14px/1.45 "Open Sans",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1d2733}
.wrap{background:#f4f6f9;border-radius:14px;width:100%;max-width:1400px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35)}
header{background:#1f3a5f;color:#fff;padding:14px 20px;display:flex;align-items:center;gap:14px}
.logo{width:36px;height:36px;border-radius:9px;background:#f47c20;display:grid;place-items:center;flex:none}
.logo svg{width:20px;height:20px}
header h1{font-size:18px;margin:0;font-weight:700;letter-spacing:.2px}
header p{margin:0;font-size:12.5px;opacity:.8}
.grow{flex:1}
button{font:inherit;font-size:13.5px;border:1px solid #c9d2de;background:#fff;color:#1d2733;border-radius:8px;padding:8px 13px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s}
button:hover:not(:disabled){background:#eef2f7;border-color:#9fb0c5}
button:disabled{opacity:.45;cursor:not-allowed}
button.pri{background:#f47c20;border-color:#f47c20;color:#fff;font-weight:700}
button.pri:hover:not(:disabled){background:#e06a10;border-color:#e06a10}
button.sec{background:#1f3a5f;border-color:#1f3a5f;color:#fff;font-weight:600}
button.sec:hover:not(:disabled){background:#2b4d7a}
header button{background:transparent;color:#fff;border-color:rgba(255,255,255,.35)}
header button:hover:not(:disabled){background:rgba(255,255,255,.12);border-color:#fff}
.tb{display:flex;flex-wrap:wrap;gap:8px;padding:12px 20px;background:#fff;border-bottom:1px solid #dfe5ec;align-items:center}
.sep{width:1px;height:26px;background:#dfe5ec;margin:0 4px}
.banner{margin:12px 20px 0;padding:10px 14px;border-radius:9px;font-size:13.5px}
.banner.erro{background:#fdeceb;border:1px solid #f3b8b4;color:#8c1d16}
.banner.info{background:#eaf2fd;border:1px solid #b9d3f5;color:#1b4a85}
.prog{padding:12px 20px 0}
.ptxt{display:flex;justify-content:space-between;gap:10px;font-size:13px;color:#4a5868;margin-bottom:6px}
.bar{height:8px;border-radius:99px;background:#e1e7ef;overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#1f9d55,#36c172);width:0;transition:width .3s}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;padding:12px 20px}
.k{background:#fff;border:1px solid #e1e7ef;border-radius:10px;padding:10px 12px}
.k b{display:block;font-size:22px;line-height:1.15;font-variant-numeric:tabular-nums}
.k span{font-size:12px;color:#5b6878}
.k.ok b{color:#1b7f43}.k.pe b{color:#a86400}.k.er b{color:#b3261e}.k.az b{color:#1f3a5f}
nav{display:flex;gap:4px;padding:0 20px;border-bottom:1px solid #dfe5ec}
nav button{border:none;border-bottom:3px solid transparent;border-radius:0;background:transparent;padding:10px 14px;color:#4a5868;font-weight:600}
nav button.on{color:#1f3a5f;border-bottom-color:#f47c20}
nav button:hover:not(:disabled){background:#e9eef4}
nav .cnt{display:inline-block;min-width:20px;padding:0 6px;margin-left:6px;border-radius:99px;background:#e1e7ef;font-size:11.5px;color:#33404f}
main{flex:1;overflow:auto;padding:14px 20px 20px}
.flt{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
input[type=search],select,input[type=number]{font:inherit;font-size:13.5px;border:1px solid #c9d2de;border-radius:8px;padding:7px 10px;background:#fff;color:#1d2733}
input[type=search]{min-width:240px;flex:1;max-width:420px}
table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid #e1e7ef;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #edf1f5;vertical-align:top;font-size:13px}
th{background:#f7f9fb;color:#4a5868;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.3px;position:sticky;top:0}
tr.it{cursor:pointer}
tr.it:hover td{background:#f8fafc}
tr.cur td{background:#fff7ef}
.num{font-variant-numeric:tabular-nums;font-weight:700;color:#1f3a5f}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:700;white-space:nowrap}
.p-verificada{background:#dff3e4;color:#17663a}.p-pendente{background:#fff1cc;color:#7a5200}.p-erro{background:#fbdada;color:#9b1c14}.p-incompleta{background:#ffe3c2;color:#8a4500}.p-fora{background:#e6e9ee;color:#4a5868}
.late{color:#b3261e;font-weight:600}.ontime{color:#1b7f43;font-weight:600}
.det td{background:#fbfcfd;padding:12px 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px 18px}
.f small{display:block;color:#5b6878;font-size:11.5px;text-transform:uppercase;letter-spacing:.3px}
.f div{white-space:pre-wrap;word-break:break-word}
.f.full{grid-column:1/-1}
.box{background:#fff;border:1px solid #e1e7ef;border-radius:10px;padding:14px 16px;margin-bottom:12px}
.box h3{margin:0 0 8px;font-size:14.5px;color:#1f3a5f}
.muted{color:#5b6878}
.vazio{padding:28px;text-align:center;color:#5b6878;background:#fff;border:1px dashed #c9d2de;border-radius:10px}
.lg td:first-child{white-space:nowrap;color:#5b6878}
.t-ok{color:#17663a;font-weight:700}.t-erro{color:#9b1c14;font-weight:700}.t-aviso{color:#8a4500;font-weight:700}.t-dup{color:#6b2fa3;font-weight:700}.t-info{color:#1b4a85;font-weight:700}
.modal{position:fixed;inset:0;background:rgba(15,28,46,.45);display:grid;place-items:center;z-index:2147483647}
.mc{background:#fff;border-radius:12px;max-width:640px;width:calc(100% - 32px);max-height:85vh;overflow:auto;padding:18px 20px;box-shadow:0 16px 50px rgba(0,0,0,.3)}
.mc h2{margin:0 0 10px;font-size:17px;color:#1f3a5f}
.mc .acts{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;flex-wrap:wrap}
.mc label{display:flex;gap:8px;align-items:flex-start;margin:10px 0}
.mini{position:fixed;right:18px;bottom:18px;z-index:2147483646;background:#1f3a5f;color:#fff;border-radius:99px;padding:10px 16px;font:600 13.5px/1.2 "Open Sans",system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3);cursor:pointer;display:flex;gap:10px;align-items:center}
.mini i{width:9px;height:9px;border-radius:50%;background:#36c172;display:inline-block}
.mini i.run{animation:pul 1s infinite}
@keyframes pul{50%{opacity:.3}}
.rel td,.rel th{font-size:13.5px}
.rel td:not(:first-child),.rel th:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
@media (max-width:700px){header p{display:none}.ov{padding:0}.wrap{border-radius:0}.tb,.kpis,main,nav,.prog{padding-left:12px;padding-right:12px}}
`;
  const ICONE = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';

  let host, root, renderPend = false;
  function agendarRender() { if (renderPend) return; renderPend = true; requestAnimationFrame(() => { renderPend = false; render(); }); }
  const $ = sel => root.querySelector(sel);

  function montarUI() {
    host = document.createElement('div'); host.id = 'conferencia-sigrc-host';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
<div class="ov" id="ov"><div class="wrap">
 <header><div class="logo">${ICONE}</div><div><h1>Conferência SIGRC</h1><p>Recebidas e Atribuídas · somente leitura · os dados ficam neste computador</p></div><span class="grow"></span>
  <button data-a="min" title="Minimizar o painel e voltar ao SIGRC">Minimizar</button><button data-a="fechar">Fechar</button></header>
 <div class="tb">
  <button class="pri" data-a="iniciar">Iniciar conferência</button>
  <button data-a="pausar">Pausar</button>
  <button data-a="retomar">Retomar</button>
  <button data-a="reproc">Reprocessar erros</button>
  <span class="sep"></span>
  <button data-a="importar">Importar planilha</button>
  <button data-a="atualizar">Atualizar planilha</button>
  <button class="sec" data-a="exportar">Exportar Excel</button>
  <span class="grow"></span>
  <button data-a="config">Configurações</button>
 </div>
 <div id="banner"></div>
 <div class="prog"><div class="ptxt"><span id="etapa"></span><span id="pct"></span></div><div class="bar"><i id="barra"></i></div></div>
 <div class="kpis" id="kpis"></div>
 <nav id="nav"></nav>
 <main id="main"></main>
</div></div>
<div class="mini" id="mini" hidden><i></i><span></span></div>
<div id="modal"></div>
<input type="file" id="arq" accept=".xlsx" hidden>`;
    document.body.appendChild(host);
    root.addEventListener('click', aoClicar);
    root.addEventListener('input', aoDigitar);
    root.addEventListener('change', aoMudar);
    $('#arq').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await importarPlanilha(f); agendarRender(); });
    window.addEventListener('beforeunload', e => { if (S.executando) { e.preventDefault(); e.returnValue = ''; } });
  }

  async function aoClicar(e) {
    const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
    const a = b.dataset.a;
    switch (a) {
      case 'min': $('#ov').hidden = true; $('#mini').hidden = false; break;
      case 'mostrar': mostrar(); break;
      case 'fechar': if (S.executando) { $('#ov').hidden = true; $('#mini').hidden = false; } else { host.remove(); window.__CONF_SIGRC__ = null; } break;
      case 'iniciar':
        if (S.run && (S.run.estado === 'pausado' || S.run.estado === 'interrompido')) confirmar('Existe uma conferência não concluída', 'Iniciar uma nova conferência descarta o andamento atual (os dados já extraídos continuam guardados e o histórico de auditoria é mantido). Deseja iniciar do zero ou retomar a anterior?', [['Retomar a anterior', () => retomar()], ['Iniciar nova', () => iniciarConferencia(), 'pri']]);
        else iniciarConferencia();
        break;
      case 'pausar': S.parar = true; S.etapa = 'Pausando após a solicitação atual…'; agendarRender(); break;
      case 'retomar': retomar(); break;
      case 'reproc': reprocessarErros(); break;
      case 'importar': $('#arq').click(); break;
      case 'atualizar': try { await atualizarPlanilha(false); } catch (err) { aviso(err.message); } break;
      case 'exportar': await exportarExcel(); break;
      case 'config': abrirConfig(); break;
      case 'aba': S.aba = b.dataset.v; break;
      case 'linha': { const k = b.dataset.k; S.abertos.has(k) ? S.abertos.delete(k) : S.abertos.add(k); break; }
      case 'fecharModal': $('#modal').innerHTML = ''; break;
      case 'modalAcao': { const fn = S.modalAcoes && S.modalAcoes[+b.dataset.i]; $('#modal').innerHTML = ''; if (fn) await fn(); break; }
      case 'verImport': abrirImportacao(); break;
      case 'removerBase': S.base = null; await salvarMeta('base', null); await log('info', 'Planilha base removida; será usado o modelo padrão'); $('#modal').innerHTML = ''; break;
    }
    agendarRender();
  }
  function aoDigitar(e) {
    const t = e.target;
    if (t.dataset.q) { S.filtros[t.dataset.q].q = t.value; render(true); }
  }
  async function aoMudar(e) {
    const t = e.target;
    if (t.dataset.f) { S.filtros[t.dataset.f].f = t.value; agendarRender(); }
    if (t.dataset.lf) { S.filtros.LOG = t.value; agendarRender(); }
    if (t.dataset.cfg === 'sensiveis') { S.cfg.sensiveis = t.checked; await salvarMeta('cfg', S.cfg); await log('info', `Inclusão de dados pessoais ${t.checked ? 'ATIVADA' : 'desativada'}${t.checked ? ' (vale para as próximas extrações)' : ''}`); }
    if (t.dataset.cfg === 'intervalo') { S.cfg.intervalo = Math.max(0, Math.min(5000, +t.value || 0)); await salvarMeta('cfg', S.cfg); }
    if (t.dataset.usar) { if (t.value) await usarAbaComo(t.dataset.usar, t.value); }
  }

  function modal(html, acoes) {
    S.modalAcoes = (acoes || []).map(a => a[1]);
    $('#modal').innerHTML = `<div class="modal"><div class="mc">${html}<div class="acts"><button data-a="fecharModal">Fechar</button>${(acoes || []).map((a, i) => `<button data-a="modalAcao" data-i="${i}" class="${a[2] || ''}">${h(a[0])}</button>`).join('')}</div></div></div>`;
  }
  function confirmar(titulo, texto, acoes) { modal(`<h2>${h(titulo)}</h2><p>${h(texto)}</p>`, acoes); }
  function aviso(txt) { modal(`<h2>Atenção</h2><p>${h(txt)}</p>`); }

  function abrirConfig() {
    modal(`<h2>Configurações</h2>
<label><input type="checkbox" data-cfg="sensiveis" ${S.cfg.sensiveis ? 'checked' : ''}><span><b>Incluir dados pessoais de identificação</b><br><span class="muted">CPF, e-mail e telefone do solicitante e, no formulário, campos como CPF, Cartão SUS, data de nascimento, nome da mãe, endereço, raça/cor, gênero e deficiência. Desligado por padrão (LGPD: mínimo necessário). Vale para as próximas extrações.</span></span></label>
<label><span style="min-width:230px"><b>Intervalo entre solicitações (ms)</b><br><span class="muted">Pausa entre uma solicitação e outra, para não sobrecarregar o SIGRC.</span></span><input type="number" min="0" max="5000" step="50" data-cfg="intervalo" value="${S.cfg.intervalo}"></label>
<p class="muted">Os dados ficam guardados apenas neste navegador, no endereço do SIGRC, e permitem retomar uma conferência interrompida. Versão ${VERSAO}.</p>`,
    [['Limpar dados locais', pedirLimpeza]]);
  }
  function pedirLimpeza() {
    confirmar('Limpar dados locais', 'Isto apaga deste navegador todas as solicitações extraídas, o andamento, a planilha base importada e o log de auditoria. Exporte o Excel antes se precisar guardar. Continuar?',
      [['Apagar tudo', async () => { await DB.limpar(); S.items.clear(); S.logs = []; S.run = null; S.base = null; S.atualizacao = null; S.abertos.clear(); await salvarMeta('cfg', S.cfg); agendarRender(); }, 'pri']]);
  }

  function abrirImportacao() {
    const b = S.base;
    if (!b) { modal('<h2>Planilha base</h2><p>Nenhuma planilha importada. A exportação usa o modelo padrão (abas Recebidas, Atribuídas, Auditoria, Resumo e Log).</p>', [['Importar planilha', () => $('#arq').click(), 'pri']]); return; }
    const abaInfo = cx => {
      const a = b.abas[cx]; if (!a) return `<p><b>${NOME_CAIXA[cx]}:</b> <span class="muted">nenhuma aba reconhecida — será criada com o modelo padrão.</span></p>`;
      const cols = a.headers.map((hd, i) => `<li>${h(hd || '(sem título)')} → ${a.keyOfCol[i] ? `<b>${h(DEF[a.keyOfCol[i]].h)}</b>` : '<span class="muted">coluna própria, preservada</span>'}</li>`).join('');
      return `<p><b>${NOME_CAIXA[cx]}</b> — aba "${h(a.nome)}": ${a.linhas.length} linha(s)${a.dups.length ? `, <b>${a.dups.length} duplicidade(s) unificada(s)</b>` : ''}${a.semId.length ? `, ${a.semId.length} linha(s) sem número (mantidas)` : ''}.</p><details><summary>Colunas (${a.headers.length})</summary><ul>${cols}</ul></details>`;
    };
    const outras = b.outras.length ? `<p><b>Outras abas</b> (mantidas sem alterações na exportação):</p>${b.outras.map(o => `<p>"${h(o.nome)}" ${o.motivo ? `<span class="muted">(${h(o.motivo)})</span>` : ''} — usar como: <select data-usar="${h(o.nome)}"><option value="">manter sem alterações</option><option value="RECEBIDAS">Recebidas</option><option value="ATRIBUIDAS">Atribuídas</option></select></p>`).join('')}` : '';
    modal(`<h2>Planilha base: ${h(b.arquivo)}</h2><p class="muted">Importada em ${fmtDT(b.importadoEm)}. As colunas e a ordem desta planilha são mantidas; colunas que faltarem são acrescentadas ao final.</p>${abaInfo('RECEBIDAS')}${abaInfo('ATRIBUIDAS')}${outras}`,
      [['Remover planilha base', async () => { S.base = null; await salvarMeta('base', null); await log('info', 'Planilha base removida; será usado o modelo padrão'); agendarRender(); }], ['Importar outra', () => $('#arq').click(), 'pri']]);
  }

  function mostrar() { if (!host || !host.isConnected) { document.body.appendChild(host); } $('#ov').hidden = false; $('#mini').hidden = true; agendarRender(); }

  function render(soTabela) {
    if (!root) return;
    const c = contagens(); const run = S.run;
    const st = run ? run.estado : null; const ex = S.executando;
    if (!soTabela) {
      const bt = a => root.querySelector(`[data-a="${a}"]`);
      bt('iniciar').disabled = ex; bt('pausar').disabled = !ex || S.parar;
      bt('retomar').disabled = ex || !run || !(st === 'pausado' || st === 'interrompido');
      bt('reproc').disabled = ex || !run || !(c.total.erros + c.total.incompletas);
      bt('importar').disabled = ex; bt('atualizar').disabled = ex || !S.items.size; bt('exportar').disabled = ex || !S.items.size;
      const ban = S.banner || (st === 'interrompido' ? { tipo: 'info', txt: 'A última conferência foi interrompida (página recarregada ou fechada). Clique em "Retomar" para continuar de onde parou — o que já foi verificado está guardado.' } : st === 'pausado' && run.motivo ? { tipo: 'info', txt: `Conferência pausada: ${run.motivo}. Clique em "Retomar" para continuar.` } : null);
      $('#banner').innerHTML = ban ? `<div class="banner ${ban.tipo}">${h(ban.txt)}</div>` : '';
      const feitos = c.total.verificadas + c.total.erros + c.total.incompletas; const tot = c.total.naCaixa;
      const pct = tot ? Math.round(feitos / tot * 100) : 0;
      $('#barra').style.width = pct + '%';
      $('#pct').textContent = tot ? `${feitos} de ${tot} analisadas · ${pct}%` : '';
      const ESTADO = { executando: 'em execução', pausado: 'pausada', interrompido: 'interrompida', concluido: 'concluída' };
      $('#etapa').textContent = ex ? (S.etapa || 'Executando…') + ' — não recarregue esta página' : run ? `Conferência ${ESTADO[st] || ''} · iniciada em ${fmtDT(run.inicio)}${run.fim ? ` · concluída em ${fmtDT(run.fim)}` : ''}` : 'Nenhuma conferência executada ainda. Clique em "Iniciar conferência".';
      const dups = S.logs.filter(l => l.tipo === 'dup' && run && l.runId === run.id).length;
      const kp = (cls, v, t) => `<div class="k ${cls}"><b>${v}</b><span>${t}</span></div>`;
      $('#kpis').innerHTML = kp('az', `${c.RECEBIDAS.verificadas}/${c.RECEBIDAS.naCaixa}`, 'Recebidas verificadas') + kp('az', `${c.ATRIBUIDAS.verificadas}/${c.ATRIBUIDAS.naCaixa}`, 'Atribuídas verificadas')
        + kp('pe', c.total.pendentes, 'Pendentes') + kp('er', c.total.erros + c.total.incompletas, 'Com erro / incompletas')
        + kp('ok', c.ATRIBUIDAS.comProposta, 'Com proposta de resposta') + kp('', c.ATRIBUIDAS.semProposta, 'Sem proposta de resposta') + kp(dups ? 'er' : '', dups, 'Duplicidades registradas');
      const n = cx => [...S.items.values()].filter(i => i.caixa === cx && i.naCaixa).length;
      const tabs = [['RECEBIDAS', 'Recebidas', n('RECEBIDAS')], ['ATRIBUIDAS', 'Atribuídas', n('ATRIBUIDAS')], ['AUDITORIA', 'Auditoria', c.total.erros + c.total.incompletas || ''], ['RELATORIO', 'Relatório final', '']];
      $('#nav').innerHTML = tabs.map(([k, t, q]) => `<button data-a="aba" data-v="${k}" class="${S.aba === k ? 'on' : ''}">${t}${q !== '' ? `<span class="cnt">${q}</span>` : ''}</button>`).join('');
      const mini = $('#mini span'); mini.textContent = `Conferência SIGRC · ${feitos}/${tot}${ex ? ' · em execução' : ''}`;
      $('#mini i').className = ex ? 'run' : '';
      $('#mini').dataset.a = 'mostrar';
    }
    const m = $('#main');
    const foco = root.activeElement && root.activeElement.dataset && root.activeElement.dataset.q; const selS = foco ? root.activeElement.selectionStart : 0;
    const scroll = m.scrollTop;
    if (S.aba === 'RECEBIDAS' || S.aba === 'ATRIBUIDAS') m.innerHTML = tabela(S.aba);
    else if (S.aba === 'AUDITORIA') m.innerHTML = auditoria();
    else m.innerHTML = relatorio(c);
    m.scrollTop = scroll;
    if (foco) { const el = root.querySelector(`[data-q="${foco}"]`); if (el) { el.focus(); el.setSelectionRange(selS, selS); } }
  }

  function confDe(it) { if (!it.naCaixa) return 'fora'; return S.run && it.runId === S.run.id ? it.conf : 'pendente'; }
  function tabela(cx) {
    const F = S.filtros[cx]; const q = norm(F.q);
    let itens = [...S.items.values()].filter(i => i.caixa === cx).sort((a, b) => (a.naCaixa === b.naCaixa ? a.id - b.id : a.naCaixa ? -1 : 1));
    if (!itens.length) return `<div class="vazio">Nenhuma solicitação ${cx === 'RECEBIDAS' ? 'recebida' : 'atribuída'} registrada ainda. Clique em <b>Iniciar conferência</b> para ler a caixa ${NOME_CAIXA[cx]} do SIGRC.</div>`;
    itens = itens.filter(i => {
      const cf = confDe(i);
      if (F.f === 'fora') { if (cf !== 'fora') return false; } else if (F.f !== 'todas') {
        if (F.f === 'comp' || F.f === 'semp') { if (cf !== 'verificada' || (F.f === 'comp') !== !!(i.propostas && i.propostas.length)) return false; }
        else if (cf !== F.f) return false;
      }
      if (!q) return true;
      const L = linha(i); return norm([i.id, L.solicitante, L.orgao, L.ultimoStatus, L.responsavel, L.propTexto].join(' ')).includes(q);
    });
    const opts = [['todas', 'Todas'], ['verificada', 'Verificadas'], ['pendente', 'Pendentes'], ['erro', 'Com erro'], ['incompleta', 'Incompletas'], ['fora', 'Fora da caixa']].concat(cx === 'ATRIBUIDAS' ? [['comp', 'Com proposta'], ['semp', 'Sem proposta']] : []);
    const head = cx === 'ATRIBUIDAS' ? ['Nº', 'Solicitante', 'Último status', 'Proposta de resposta', 'SLA', 'Conferência', 'Verificada em'] : ['Nº', 'Solicitante', 'Órgão', 'Último status', 'Abertura', 'SLA', 'Conferência', 'Verificada em'];
    const linhas = itens.map(i => {
      const L = linha(i); const cf = confDe(i); const slaC = /Atrasado/.test(L.sla || '') ? 'late' : L.sla ? 'ontime' : '';
      const pil = `<span class="pill p-${cf}">${cf === 'fora' ? 'Fora da caixa' : CONF_LBL[cf]}</span>`;
      const prop = !i.dados || !i.propostas ? '<span class="muted">—</span>' : i.propostas.length ? `${fmtDT(i.propostas[0].data)}${i.propostas.length > 1 ? ` <span class="muted">(+${i.propostas.length - 1} anterior${i.propostas.length > 2 ? 'es' : ''})</span>` : ''}` : '<span class="muted">Sem proposta</span>';
      const cels = cx === 'ATRIBUIDAS'
        ? [`<span class="num">${i.id}</span>`, h(L.solicitante || ''), h(L.ultimoStatus || ''), prop, `<span class="${slaC}">${h(L.sla || '')}</span>`, pil, h(fmtDT(L.verificadoEm))]
        : [`<span class="num">${i.id}</span>`, h(L.solicitante || ''), h(L.orgao || ''), h(L.ultimoStatus || ''), h(fmtDT(L.dataAbertura)), `<span class="${slaC}">${h(L.sla || '')}</span>`, pil, h(fmtDT(L.verificadoEm))];
      const aberto = S.abertos.has(i.key);
      return `<tr class="it ${S.atual === i.key ? 'cur' : ''}" data-a="linha" data-k="${h(i.key)}">${cels.map(x => `<td>${x}</td>`).join('')}</tr>` + (aberto ? `<tr class="det"><td colspan="${head.length}">${detalhe(i, L)}</td></tr>` : '');
    }).join('');
    return `<div class="flt"><input type="search" placeholder="Buscar por número, solicitante, órgão, status…" data-q="${cx}" value="${h(F.q)}"><select data-f="${cx}">${opts.map(([v, t]) => `<option value="${v}" ${F.f === v ? 'selected' : ''}>${t}</option>`).join('')}</select><span class="muted" style="align-self:center">${itens.length} solicitação(ões) · clique numa linha para ver tudo o que foi extraído</span></div>
<table><thead><tr>${head.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${linhas || `<tr><td colspan="${head.length}" class="muted">Nenhuma solicitação com esse filtro.</td></tr>`}</tbody></table>`;
  }
  function detalhe(it, L) {
    const defs = colsDe(it.caixa).filter(d => d.k !== 'id' && (!d.sens || S.cfg.sensiveis));
    const longos = new Set(['descricao', 'formulario', 'propTexto', 'propAnteriores', 'historicoResumo', 'obs']);
    return `<div class="grid">${defs.map(d => { let v = L[d.k]; if (v instanceof Date) v = fmtDT(v); if (v === undefined || v === null || v === '') v = '—'; return `<div class="f ${longos.has(d.k) ? 'full' : ''}"><small>${h(d.h)}</small><div>${h(v)}</div></div>`; }).join('')}</div>`;
  }

  function auditoria() {
    const run = S.run; const TIPO = { info: 'Informação', ok: 'Verificada', aviso: 'Aviso', erro: 'Erro', dup: 'Duplicidade' };
    const problemas = [...S.items.values()].filter(i => i.naCaixa && run && i.runId === run.id && (i.conf === 'erro' || i.conf === 'incompleta'));
    const dups = S.logs.filter(l => l.tipo === 'dup');
    const lf = S.filtros.LOG;
    const logs = S.logs.filter(l => lf === 'todos' || l.tipo === lf).slice(-800).reverse();
    return `<div class="box"><h3>Falhas e conferências incompletas (${problemas.length})</h3>${problemas.length ? `<table><thead><tr><th>Caixa</th><th>Nº</th><th>Situação</th><th>Tentativas</th><th>Motivo</th></tr></thead><tbody>${problemas.map(i => `<tr><td>${NOME_CAIXA[i.caixa]}</td><td class="num">${i.id}</td><td><span class="pill p-${i.conf}">${CONF_LBL[i.conf]}</span></td><td>${i.tentativas || 0}</td><td>${h([...(i.erros || []), ...(i.problemas || [])].join('; '))}</td></tr>`).join('')}</tbody></table><p class="muted">Use "Reprocessar erros" para tentar de novo só estas solicitações.</p>` : '<p class="muted">Nenhuma falha na conferência atual.</p>'}</div>
<div class="box"><h3>Duplicidades (${dups.length})</h3>${dups.length ? `<ul>${dups.slice(-200).reverse().map(l => `<li>${h(fmtDT(l.ts))} — ${h(l.msg)}</li>`).join('')}</ul>` : '<p class="muted">Nenhuma duplicidade encontrada. Cada solicitação é registrada uma única vez por caixa (chave: caixa + número).</p>'}</div>
<div class="box"><h3>Registro de auditoria</h3><div class="flt"><select data-lf="1">${[['todos', 'Todos os eventos'], ['ok', 'Verificações'], ['erro', 'Erros'], ['aviso', 'Avisos'], ['dup', 'Duplicidades'], ['info', 'Informações']].map(([v, t]) => `<option value="${v}" ${lf === v ? 'selected' : ''}>${t}</option>`).join('')}</select><span class="muted" style="align-self:center">${S.logs.length} evento(s) guardado(s); exibindo os ${logs.length} mais recentes</span></div>
<table class="lg"><thead><tr><th>Data/hora</th><th>Tipo</th><th>Caixa</th><th>Nº</th><th>Mensagem</th></tr></thead><tbody>${logs.map(l => `<tr><td>${h(fmtDT(l.ts))}</td><td class="t-${l.tipo}">${TIPO[l.tipo] || h(l.tipo)}</td><td>${l.caixa ? NOME_CAIXA[l.caixa] : ''}</td><td class="num">${h(l.id || '')}</td><td>${h(l.msg)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Sem eventos.</td></tr>'}</tbody></table></div>`;
  }

  function relatorio(c) {
    const run = S.run;
    if (!run) return '<div class="vazio">O relatório final aparece aqui depois da primeira conferência.</div>';
    const ESTADO = { executando: 'Em execução', pausado: 'Pausada', interrompido: 'Interrompida', concluido: 'Concluída' };
    const L = run.listas || {};
    const ln = (t, a, b, tot) => `<tr><td>${t}</td><td>${a ?? '—'}</td><td>${b ?? '—'}</td><td><b>${tot ?? '—'}</b></td></tr>`;
    const at = S.atualizacao;
    const linhaPl = (t, k) => `<tr><td>${t}</td><td>${at.st.RECEBIDAS[k]}</td><td>${at.st.ATRIBUIDAS[k]}</td></tr>`;
    return `<div class="box"><h3>Conferência ${h(run.id)} · ${ESTADO[run.estado] || ''}</h3><p>Início: <b>${fmtDT(run.inicio)}</b>${run.fim ? ` · Término: <b>${fmtDT(run.fim)}</b>` : ''}${run.operador ? ` · Executada por: <b>${h(run.operador)}</b>` : ''}${run.motivo && run.estado !== 'concluido' ? ` · ${h(run.motivo)}` : ''}</p>
<table class="rel"><thead><tr><th>Indicador</th><th>Recebidas</th><th>Atribuídas</th><th>Total</th></tr></thead><tbody>
${ln('Total informado pelo sistema', L.RECEBIDAS && L.RECEBIDAS.totalSistema, L.ATRIBUIDAS && L.ATRIBUIDAS.totalSistema, (L.RECEBIDAS && L.ATRIBUIDAS) ? (L.RECEBIDAS.totalSistema || 0) + (L.ATRIBUIDAS.totalSistema || 0) : null)}
${ln('Na caixa (listadas)', c.RECEBIDAS.naCaixa, c.ATRIBUIDAS.naCaixa, c.total.naCaixa)}
${ln('Analisadas', c.RECEBIDAS.analisadas, c.ATRIBUIDAS.analisadas, c.total.analisadas)}
${ln('Concluídas (verificadas)', c.RECEBIDAS.verificadas, c.ATRIBUIDAS.verificadas, c.total.verificadas)}
${ln('Pendentes', c.RECEBIDAS.pendentes, c.ATRIBUIDAS.pendentes, c.total.pendentes)}
${ln('&nbsp;&nbsp;das quais com erro', c.RECEBIDAS.erros, c.ATRIBUIDAS.erros, c.total.erros)}
${ln('&nbsp;&nbsp;das quais incompletas', c.RECEBIDAS.incompletas, c.ATRIBUIDAS.incompletas, c.total.incompletas)}
${ln('Com proposta de resposta', null, c.ATRIBUIDAS.comProposta, c.ATRIBUIDAS.comProposta)}
${ln('Sem proposta de resposta', null, c.ATRIBUIDAS.semProposta, c.ATRIBUIDAS.semProposta)}
${ln('Fora da caixa (mantidas para rastreabilidade)', c.RECEBIDAS.fora, c.ATRIBUIDAS.fora, c.total.fora)}
</tbody></table></div>
<div class="box"><h3>Planilha</h3><p>Base: <b>${S.base ? h(S.base.arquivo) : 'modelo padrão (nenhuma planilha importada)'}</b> <button data-a="verImport">Ver estrutura</button></p>
${at ? `<p class="muted">Última atualização: ${fmtDT(at.em)}</p><table class="rel"><thead><tr><th>Linhas</th><th>Recebidas</th><th>Atribuídas</th></tr></thead><tbody>${linhaPl('Novas', 'novas')}${linhaPl('Atualizadas', 'atualizadas')}${linhaPl('Da base sem correspondência nas caixas (mantidas)', 'semCorrespondencia')}${linhaPl('Da base sem número (mantidas)', 'semNumero')}${linhaPl('Duplicidades unificadas da base', 'dupBase')}${linhaPl('Colunas próprias preservadas', 'colunasPreservadas')}</tbody></table>` : '<p class="muted">Clique em "Atualizar planilha" para ver o que vai mudar, ou em "Exportar Excel" para baixar.</p>'}</div>`;
  }

  /* ───────────────────────── inicialização ───────────────────────── */
  async function iniciar() {
    await DB.abrir();
    const [itens, run, cfg, base, atual, logs] = await Promise.all([DB.all('items'), DB.get('meta', 'run'), DB.get('meta', 'cfg'), DB.get('meta', 'base'), DB.get('meta', 'atualizacao'), DB.all('log')]);
    (itens || []).forEach(i => S.items.set(i.key, i));
    S.run = run || null; if (cfg) S.cfg = { ...S.cfg, ...cfg }; S.base = base || null; S.atualizacao = atual || null;
    S.logs = (logs || []).slice(-5000);
    montarUI();
    if (DB.memoria) S.banner = { tipo: 'info', txt: 'O navegador bloqueou o armazenamento local: a conferência funciona, mas não poderá ser retomada se a página for recarregada.' };
    if (S.run && S.run.estado === 'executando') { S.run.estado = 'interrompido'; await salvarMeta('run', S.run); await log('aviso', 'A conferência anterior foi interrompida antes de terminar (página recarregada ou fechada).'); }
    if (S.run && S.run.estado !== 'concluido') S.aba = 'RECEBIDAS';
    render();
  }

  window.__CONF_SIGRC__ = { mostrar, versao: VERSAO, _S: S, _XLSX: XLSX, _exportar: exportarExcel, _iniciar: iniciarConferencia };
  iniciar().catch(e => { console.error('[Conferência SIGRC]', e); alert('Conferência SIGRC: não foi possível iniciar o painel. ' + (e && e.message ? e.message : e)); });
})();
