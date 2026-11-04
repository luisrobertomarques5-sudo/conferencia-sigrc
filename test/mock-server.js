// Servidor simulado do SIGRC (dados fictícios) para testar o painel de ponta a ponta.
const http = require('http');
const url = require('url');

const state = { req: 0, falhar401Apos: null, contagem: {} };
const BASE_TS = Date.UTC(2026, 9, 1, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

function mkList(caixa, n, start) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = start + i * 7;
    out.push({
      id, statusSolicitacao: caixa === 'RECEBIDAS' ? 'ABERTA' : 'EM_ANDAMENTO', protocolo: String(id),
      dataCadastro: iso(BASE_TS + i * 3600e3), dataLimite: iso(BASE_TS + (i + 30) * 86400e3), idPessoa: 1000 + i,
      criticidade: i % 3 ? 'BAIXA' : 'ALTA', idOrgao: 2074, sigilo: false, idRegistroFormulario: 5000 + i,
      tempoRestante: i % 5 === 0 ? { horas: '-5', dias: '-' + (i % 4 + 1), minutos: '-36' } : { horas: '17', dias: String(10 + i % 20), minutos: '32' },
      orgao: { id: 2074, orgao: 'SMS-Ouv.SUS-STS CL-UBS FICTICIA ' + (i % 3) },
      tipoSolicitacao: { id: 1, descricao: 'Ouvidoria SUS - Tipo fictício ' + (i % 2) },
      historicoAtual: { status: { descricao: caixa === 'RECEBIDAS' ? 'TRANSFERENCIA DE DEMANDA' : (i % 2 ? 'PROPOSTA DE RESPOSTA' : 'DEMANDA ATRIBUIDA') } },
      meioComunicacao: { descricao: i % 2 ? 'PORTAL' : 'CRM' }
    });
  }
  return out;
}
const LISTAS = { RECEBIDAS: mkList('RECEBIDAS', 130, 38000001), ATRIBUIDAS: mkList('ATRIBUIDAS', 21, 37800003) };
const caixaDe = id => (LISTAS.RECEBIDAS.find(x => x.id === id) ? 'RECEBIDAS' : LISTAS.ATRIBUIDAS.find(x => x.id === id) ? 'ATRIBUIDAS' : null);
const ERRO_SEMPRE = 38000001 + 7 * 5; // esta solicitação sempre responde 500

function historico(id) {
  const idx = LISTAS.ATRIBUIDAS.findIndex(x => x.id === id);
  const n = idx % 3 === 0 ? 15 : idx % 3 === 1 ? 4 : 10;
  const regs = [];
  for (let k = 0; k < n; k++) {
    let st = k === 0 ? 'DEMANDA ATRIBUIDA' : 'TRANSFERENCIA DE DEMANDA';
    let resp = '<p>Encaminhado</p>';
    if (idx % 3 === 0 && (k === 3 || k === 12)) { st = 'PROPOSTA DE RESPOSTA'; resp = `<p>Informo que n&atilde;o h&aacute; profissional (registro ${k}).</p><p>Continuamos &agrave; disposi&ccedil;&atilde;o.</p>`; }
    if (idx % 3 === 2 && k === 5) { st = 'PROPOSTA DE RESPOSTA'; resp = idx === 5 ? '' : '<p>Resposta &uacute;nica &amp; final &lt;teste&gt;.</p>'; }
    regs.push({
      historico: { id: id * 100 + k, resposta: resp, dataAlteracao: iso(BASE_TS + (n - k) * 86400e3 + idx * 60e3), status: { descricao: st }, notaTratamento: '', orgao: { orgao: 'SMS-Ouv.SUS-STS CL-UBS FICTICIA' }, meioComunicacaoTratamentoDescricao: 'CRM' },
      nomeUsuarioAlteracao: 'Operador Fictício ' + k, loginUsuarioAlteracao: 'X' + (100000 + k), descricaoOrgao: 'SMS-Ouv.SUS-STS CL-UBS FICTICIA'
    });
  }
  return regs;
}

const FORM = { id: 2869, componentes: [
  { htmlId: 'lb_x', htmlTipo: 'SEPARATOR', descricaoComponente: 'Sep' },
  { htmlId: 'sl_regiao', htmlTipo: 'SELECT', descricaoComponente: 'REGIÃO' },
  { htmlId: 'sl_consulta', htmlTipo: 'SELECT', descricaoComponente: '<b>QUAL CONSULTA?</b>' },
  { htmlId: 'ip_cpf_paciente', htmlTipo: 'INPUT', descricaoComponente: 'CPF/CIN - DA(O) PACIENTE' },
  { htmlId: 'ip_nome_paciente', htmlTipo: 'INPUT', descricaoComponente: 'NOME COMPLETO DA(O) PACIENTE' },
  { htmlId: 'ip_cartao_sus', htmlTipo: 'INPUT', descricaoComponente: 'NÚMERO DO CARTÃO SUS' },
  { htmlId: 'cb__declaro', htmlTipo: 'CHECKBOX', descricaoComponente: 'DECLARO QUE OS DADOS SÃO VERDADEIROS' },
  { htmlId: 'fu_anexo', htmlTipo: 'INPUTFILE', descricaoComponente: 'ANEXO' }
] };

function send(res, code, obj, ct = 'application/json') { res.writeHead(code, { 'content-type': ct }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); }

const srv = http.createServer((req, res) => {
  const u = url.parse(req.url, true); const p = u.pathname;
  if (p === '/__ctl') { Object.assign(state, JSON.parse(u.query.s || '{}')); state.req = 0; return send(res, 200, state); }
  if (p.startsWith('/resolucao/api/')) {
    state.req++;
    state.contagem[p.replace(/\d+/g, ':n')] = (state.contagem[p.replace(/\d+/g, ':n')] || 0) + 1;
    if (state.falhar401Apos !== null && state.req > state.falhar401Apos) return send(res, 401, { error: 'unauthorized' });
  }
  let m;
  if (p === '/resolucao/api/usuarios/logged') return send(res, 200, { nome: 'Operador de Teste', login: 'X999' });
  if (p === '/resolucao/api/solicitacoes/caixas') {
    const L = LISTAS[u.query.caixa] || []; const ps = +u.query.pageSize, pg = +u.query.page;
    if (ps > 100) return send(res, 500, { status: 500 });
    const ord = [...L].sort((a, b) => (u.query.sortField === 'id' ? a.id - b.id : b.id - a.id));
    return send(res, 200, { total: L.length, resultado: ord.slice((pg - 1) * ps, pg * ps) });
  }
  if ((m = p.match(/^\/resolucao\/api\/solicitacoes\/detalhes\/(\d+)$/))) {
    const id = +m[1]; const cx = caixaDe(id); if (!cx) return send(res, 404, { status: 404 });
    if (id === ERRO_SEMPRE) return send(res, 500, { status: 500 });
    const li = LISTAS[cx].find(x => x.id === id); const i = LISTAS[cx].indexOf(li);
    return send(res, 200, {
      id, idOrgao: 2074, orgaoTratamento: li.orgao.orgao, statusSolicitacao: li.statusSolicitacao, descricao: i === 2 ? '<p>Descri&ccedil;&atilde;o com <b>HTML</b></p><p>Segunda linha</p>' : 'Relato fictício número ' + i + '\ncom quebra de linha',
      anexos: i % 2 ? ['a.pdf'] : [], dataCadastro: li.dataCadastro, dataLimite: li.dataLimite, sigilo: false, idFormulario: 2869, idRegistroFormulario: li.idRegistroFormulario,
      tempoRestante: { dias: +li.tempoRestante.dias, horas: +li.tempoRestante.horas, minutos: +li.tempoRestante.minutos }, criticidade: 0,
      tipoSolicitacao: li.tipoSolicitacao, historicoAtual: { dataAlteracao: iso(BASE_TS + 5 * 86400e3), status: li.historicoAtual.status },
      meioComunicacao: li.meioComunicacao, pessoa: { id: 1, nome: 'Munícipe Fictício ' + i, cpf: '000.000.000-0' + (i % 10), email: `ficticio${i}@exemplo.test`, telefones: [{ ddd: 11, numero: 900000000 + i }] },
      usuarioTratamento: cx === 'ATRIBUIDAS' ? { nome: 'Responsável Fictício', login: 'X1' } : null
    });
  }
  if ((m = p.match(/^\/resolucao\/api\/solicitacoes\/(\d+)\/breadcrumb$/))) return send(res, 200, ['Ouvidoria SUS']);
  if ((m = p.match(/^\/resolucao\/api\/solicitacoes\/(\d+)\/historico\/$/))) {
    if (!u.query.idOrgao) return send(res, 400, { status: 400 });
    const regs = historico(+m[1]); const pg = +u.query.page;
    return send(res, 200, { historicos: regs.slice((pg - 1) * 10, pg * 10), filtro: { page: pg, pageSize: 10 }, total: regs.length });
  }
  if ((m = p.match(/^\/resolucao\/api\/formulario\/(\d+)$/))) return send(res, 200, FORM);
  if ((m = p.match(/^\/resolucao\/api\/formulario\/(\d+)\/registro\/(\d+)$/))) return send(res, 200, { id: +m[2], idVersaoFormulario: 1, sl_regiao: 'CAMPO LIMPO', sl_consulta: 'FONOAUDIOLOGIA', ip_cpf_paciente: '111.111.111-11', ip_nome_paciente: 'Paciente Fictício', ip_cartao_sus: '700000000000000', cb__declaro: 'on', fu_anexo: 'x.pdf', campo_extra: 'valor extra' });
  if (p.startsWith('/resolucao/')) return send(res, 200, '<!doctype html><html><head><meta charset="utf-8"><title>Resolução (simulado)</title></head><body><app-root><h1>SIGRC simulado</h1></app-root></body></html>', 'text/html; charset=utf-8');
  send(res, 404, 'not found', 'text/plain');
});
srv.listen(8765, () => console.log('mock on 8765'));
module.exports = { LISTAS, ERRO_SEMPRE };
