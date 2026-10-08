// Tela "Programação de produção". Só IMPRIME o que o servidor calcula (status de prazo, pronta entrega, totais,
// indicadores, alertas) e salva o que o PCP edita. Nenhuma regra de negócio mora aqui.

const { api, esc, fmtData, $, mostrarToast } = window.PCP;

const CHAVE_VISOES = 'pcp_prog_visoes';
const NOMES_TIPO = { PINTURA: 'Pintura', SEM_PINTURA: 'Sem pintura', PRE_PINTADA: 'Pré-pintada' };
const CAMPOS_FILTRO = ['situacao', 'statusPrazo', 'rota', 'produto', 'tipo', 'cor'];

const filtrosPadrao = () => ({
  visao: 'em_aberto', situacao: [], statusPrazo: [], rota: [], produto: [], tipo: [], cor: [],
  campoData: 'prazo', de: '', ate: '', soAlertas: false, q: '',
});

const S = {
  dados: null,
  f: filtrosPadrao(),
  agrupar: true,
  colapsados: new Set(),
  sel: new Set(),
  cols: { consumos: false, parafusos: false, componentes: false, terceiros: false },
  detalhe: null, // { pedidoId, d }
  montado: false,
  carregando: false,
  timerRefresh: null,
  timerBusca: null,
};

const brl = (n) => (n === null || n === undefined ? '' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const num = (n) => (n === null || n === undefined ? '' : n.toLocaleString('pt-BR', { maximumFractionDigits: 2 }));
const pc = () => S.dados?.perfil === 'completo';
const dis = () => (pc() ? '' : ' disabled');

function msg(texto, ok = true) {
  const el = $('pg-salvo');
  el.textContent = texto;
  el.className = ok ? 'ok' : 'err';
  if (ok) setTimeout(() => { if (el.textContent === texto) el.textContent = ' '; }, 3500);
}

// ---------------------------------------------------------------- dados

function queryString(f) {
  const p = new URLSearchParams();
  if (f.visao) p.set('visao', f.visao);
  for (const k of CAMPOS_FILTRO) if (f[k].length) p.set(k, f[k].join(','));
  if (f.de || f.ate) {
    p.set('campoData', f.campoData);
    if (f.de) p.set('de', f.de);
    if (f.ate) p.set('ate', f.ate);
  }
  if (f.soAlertas) p.set('soAlertas', '1');
  if (f.q.trim()) p.set('q', f.q.trim());
  return p.toString();
}

async function carregar({ silencioso = false } = {}) {
  if (S.carregando) return;
  S.carregando = true;
  try {
    const dados = await api(`/api/programacao?${queryString(S.f)}`);
    const editando = document.activeElement?.closest?.('#pg-wrap') && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (silencioso && editando && S.dados) {
      // Quem está digitando não perde o cursor: só indicadores, totais e rodapé são atualizados.
      Object.assign(S.dados, { indicadores: dados.indicadores, totais: dados.totais, sync: dados.sync, hoje: dados.hoje });
      renderStats();
      renderRodape();
    } else {
      S.dados = dados;
      for (const id of [...S.sel]) if (!dados.itens.some((i) => i.id === id)) S.sel.delete(id);
      renderTudo();
    }
  } catch (erro) {
    if (!silencioso) mostrarToast(`Não foi possível carregar a programação: ${erro.message}`);
  } finally {
    S.carregando = false;
  }
}

function agendarRefresh() {
  clearTimeout(S.timerRefresh);
  S.timerRefresh = setTimeout(() => carregar({ silencioso: true }), 600);
}

async function garantirUsuario() {
  if (window.PCP.lerUsuario()) return;
  const nome = (prompt('Seu nome (aparece no histórico das alterações):') || '').trim();
  if (nome) {
    try { localStorage.setItem('pcp_usuario', nome.slice(0, 60)); } catch { /* sem storage: segue como "PCP" */ }
  }
}

async function patchItem(id, corpo, el) {
  el?.classList.add('salvando');
  try {
    await garantirUsuario();
    const nova = await api(`/api/programacao/itens/${id}`, { method: 'PATCH', body: JSON.stringify(corpo) });
    const i = S.dados.itens.findIndex((x) => x.id === id);
    if (i >= 0 && nova.id) S.dados.itens[i] = nova;
    msg('Salvo');
    agendarRefresh();
    if (S.detalhe) await abrirDetalhe(S.detalhe.pedidoId, { manterRolagem: true });
    return nova;
  } catch (erro) {
    el?.classList.add('erro');
    mostrarToast(erro.message);
    msg(erro.message, false);
    renderTabela();
    if (S.detalhe) abrirDetalhe(S.detalhe.pedidoId, { manterRolagem: true });
    return null;
  } finally {
    el?.classList.remove('salvando');
  }
}

async function patchPedido(pedidoId, corpo) {
  try {
    await garantirUsuario();
    await api(`/api/programacao/pedidos/${pedidoId}`, { method: 'PATCH', body: JSON.stringify(corpo) });
    msg('Salvo');
    await carregar({ silencioso: true });
    if (S.detalhe) await abrirDetalhe(S.detalhe.pedidoId, { manterRolagem: true });
    return true;
  } catch (erro) {
    mostrarToast(erro.message);
    msg(erro.message, false);
    renderTabela();
    return false;
  }
}

// ---------------------------------------------------------------- colunas da grade

const alertasHtml = (l) =>
  l.alertas.length ? `<span class="pg-alerta" title="${esc(l.alertas.map((a) => a.texto).join('\n'))}">${l.alertas.length}</span>` : '';

function selectHtml(opcoes, atual, attrs, vazio) {
  const itens = opcoes.map((o) => `<option value="${esc(o.valor)}"${String(o.valor) === String(atual ?? '') ? ' selected' : ''}>${esc(o.rotulo)}</option>`);
  return `<select class="pg-in" ${attrs}${dis()}>${vazio !== undefined ? `<option value="">${esc(vazio)}</option>` : ''}${itens.join('')}</select>`;
}

const dataIn = (l, campo) =>
  pc()
    ? `<input type="date" class="pg-in data" value="${esc(l[campo] ?? '')}" data-item="${l.id}" data-campo="${campo}" min="2000-01-01" max="2100-12-31">`
    : esc(fmtData(l[campo]) || '—');

function consumoQtd(l, material) {
  const v = l.consumos.filter((c) => c.material === material).reduce((s, c) => s + c.quantidade, 0);
  return v > 0 ? num(v) : '';
}

function listaPorGrupo(l, grupo) {
  const materiais = new Set(S.dados.opcoes.materiais.filter((m) => m.grupo === grupo).map((m) => m.codigo));
  return l.consumos
    .filter((c) => materiais.has(c.material))
    .map((c) => `${esc(c.nome.replace(/^Parafuso /, ''))}: ${num(c.quantidade)}`)
    .join(' · ');
}

function colunas() {
  const o = S.dados.opcoes;
  const base = [
    {
      id: 'pedido', t: 'Pedido', o: 'n',
      fn: (l) => `<button type="button" class="pg-ped" data-abrir="${l.pedidoId}" title="Abrir o pedido">${l.numeroPedido}</button>${l.itemSeq ? `<span class="pg-sub">item ${esc(l.itemSeq)}</span>` : ''}${alertasHtml(l)}`,
    },
    { id: 'cliente', t: 'Cliente', o: 'n', cls: 'truncar', fn: (l) => `${esc(l.cliente)}${l.telefone ? `<span class="pg-sub">${esc(l.telefone)}</span>` : ''}` },
    { id: 'cidade', t: 'Cidade', o: 'n', fn: (l) => esc(l.cidade || '—') },
    {
      id: 'rota', t: 'Rota', o: 'p',
      fn: (l) => selectHtml(o.rotas.map((r) => ({ valor: r.id, rotulo: `${r.id} · ${r.nome}` })), l.rota?.id, `data-pedido="${l.pedidoId}" data-campo="rotaId"`, 'Sem rota'),
    },
    {
      id: 'prazo', t: 'Prazo vigente', o: 'n',
      fn: (l) => `${esc(fmtData(l.prazoVigente) || '—')}${l.prazoNegociado ? `<span class="pg-sub" title="Prazo original: ${esc(fmtData(l.prazoOriginal))}">negociado</span>` : ''}`,
    },
    {
      id: 'statusPrazo', t: 'Status de prazo', o: 'c',
      fn: (l) => `<span class="pg-tag ${esc(l.statusPrazo.codigo)}">${esc(l.statusPrazo.texto)}</span>`,
    },
    {
      id: 'situacao', t: 'Situação', o: 'p',
      fn: (l) =>
        `<select class="pg-in sit pg-sit-${esc(l.grupo)}" data-item="${l.id}" data-campo="situacao"${dis()}>${o.situacoes
          .map((s) => `<option value="${s.valor}"${s.valor === l.situacao ? ' selected' : ''}>${esc(s.rotulo)}</option>`)
          .join('')}</select>`,
    },
    {
      id: 'produto', t: 'Produto', o: 'n', cls: 'truncar',
      fn: (l) => `${esc(l.categoriaRotulo)}<span class="pg-sub" title="${esc(l.produtoDescricao)}">${esc(l.produtoDescricao.slice(0, 44))}</span>`,
    },
    { id: 'tipo', t: 'Tipo', o: 'n', fn: (l) => esc(NOMES_TIPO[l.tipoPintura] || '—') },
    { id: 'cor', t: 'Cor', o: 'n', cls: 'truncar', fn: (l) => `<span title="${esc(l.cor?.nome || '')}">${esc(l.cor?.nome?.slice(0, 26) || '—')}</span>` },
    { id: 'tr', t: 'TR', o: 'n', fn: (l) => esc(l.trapezio?.replace('TR', '') || '—') },
    { id: 'faces', t: 'Faces', o: 'n', fn: (l) => String(l.facesPintura) },
    {
      id: 'medidas', t: 'Medidas', o: 'n', cls: 'truncar',
      fn: (l) =>
        l.medidasTexto
          ? `<span title="${esc(l.infoAdicional)}">${esc(l.medidasTexto)}</span>${l.medidasOrigem === 'manual' ? '<span class="pg-sub">ajustado</span>' : ''}`
          : `<span class="pg-sub" title="${esc(l.infoAdicional)}">${l.medidasOrigem === 'quantidade' ? 'só quantidade' : 'sem medidas'}</span>`,
    },
    { id: 'metros', t: 'Metros chapa', o: 'c', cls: 'n', fn: (l) => num(l.metrosChapa) },
    {
      id: 'ops', t: 'OP(s)', o: 'n', cls: 'truncar',
      fn: (l) => (l.ops.length ? `<span title="${esc(l.ops.map((x) => `${x.numero} (${x.status})`).join('\n'))}">${esc(l.ops.map((x) => x.numero.replace(/^OS\s*/, '')).join(', '))}</span>` : '—'),
    },
    { id: 'dProg', t: 'Data programação', o: 'p', fn: (l) => dataIn(l, 'dataProgramacao') },
    { id: 'dLib', t: 'Data liberação', o: 'p', fn: (l) => dataIn(l, 'dataLiberacaoProducao') },
    { id: 'dProd', t: 'Data produzida', o: 'p', fn: (l) => dataIn(l, 'dataProduzida') },
    { id: 'dEnt', t: 'Data entrega', o: 'p', fn: (l) => dataIn(l, 'dataEntregaRealizada') },
    { id: 'valor', t: 'Valor a receber', o: 'n', cls: 'n', fn: (l, primeiro) => (primeiro ? brl(l.valorPedido) : '<span class="pg-sub">↳ pedido</span>') },
    {
      id: 'obs', t: 'Observação', o: 'p', cls: 'truncar',
      fn: (l) => (l.observacao ? `<span title="${esc(l.observacao)}">${esc(l.observacao.slice(0, 60))}</span>` : '<span class="pg-sub">—</span>'),
    },
  ];

  const extras = [];
  if (S.cols.consumos) {
    extras.push(
      { id: 'bobina', t: 'Bobina (kg)', o: 'c', cls: 'n', fn: (l) => consumoQtd(l, 'bobina') },
      { id: 'eps', t: 'EPS (m)', o: 'c', cls: 'n', fn: (l) => consumoQtd(l, 'eps') },
      { id: 'cola', t: 'Cola (kg)', o: 'c', cls: 'n', fn: (l) => consumoQtd(l, 'cola') },
      { id: 'tinta', t: 'Tinta (kg)', o: 'c', cls: 'n', fn: (l) => (consumoQtd(l, 'tinta') ? `${consumoQtd(l, 'tinta')}${l.cor ? `<span class="pg-sub">${esc(l.cor.nome.slice(0, 22))}</span>` : ''}` : '') }
    );
  }
  if (S.cols.parafusos) extras.push({ id: 'parafusos', t: 'Parafusos (un)', o: 'p', cls: 'truncar', fn: (l) => listaPorGrupo(l, 'parafusos') || '—' });
  if (S.cols.componentes) extras.push({ id: 'componentes', t: 'Componentes', o: 'p', cls: 'truncar', fn: (l) => listaPorGrupo(l, 'componentes') || '—' });
  if (S.cols.terceiros) {
    extras.push(
      {
        id: 'terceiro', t: 'Fornecedor terceiro', o: 'p',
        fn: (l) => (pc() ? `<input class="pg-in" style="width:150px" value="${esc(l.fornecedorTerceiro)}" data-item="${l.id}" data-campo="fornecedorTerceiro" maxlength="100">` : esc(l.fornecedorTerceiro || '—')),
      },
      { id: 'dTerc', t: 'Entrega terceiro', o: 'p', fn: (l) => dataIn(l, 'dataEntregaTerceiro') }
    );
  }
  return [...base.slice(0, 19), ...extras, ...base.slice(19)];
}

// ---------------------------------------------------------------- render

const ORIGEM = {
  n: '<i class="pg-orig n" title="Vem da Nomus (somente leitura)">N</i>',
  p: '<i class="pg-orig p" title="Do PCP (editável)">P</i>',
  c: '<i class="pg-orig c" title="Calculado pelo sistema">C</i>',
};

function renderStats() {
  const i = S.dados.indicadores;
  const pct = (p) => (p === null ? '—' : `${p}%`);
  const cartoes = [
    ['Itens em aberto', num(i.itensEmAberto), 'Sem cancelados nem devolvidos', 'blue', 'em_aberto'],
    ['Metros em aberto', `${num(i.metrosEmAberto)} m`, 'Metros de chapa dos itens em aberto', 'gold', ''],
    ['R$ em aberto', brl(i.valorEmAberto), 'Valor dos pedidos com item em aberto (cada pedido uma vez)', 'green', ''],
    ['Atrasados', num(i.atrasados.itens), `${brl(i.atrasados.valor)} · mediana ${i.atrasados.diasMediano === null ? '—' : `${num(i.atrasados.diasMediano)} dias`}`, 'red', 'atrasados'],
    ['Pontualidade do mês', pct(i.pontualidadeMes.percentual), `${i.pontualidadeMes.noPrazo} de ${i.pontualidadeMes.entregues} entregues no prazo`, 'green', ''],
    ['Liberados após o prazo', pct(i.liberadosAposPrazo.percentual), `${i.liberadosAposPrazo.itens} de ${i.liberadosAposPrazo.base} itens com data de liberação`, 'red', 'liberados_apos_prazo'],
  ];
  $('pg-stats').innerHTML = cartoes
    .map(([t, v, s, cor, visao]) => `<${visao ? 'button type="button"' : 'div'} class="pg-stat ${cor}" ${visao ? `data-visao="${visao}" style="text-align:left;cursor:pointer"` : ''}><span>${esc(t)}</span><strong>${esc(v)}</strong><small>${esc(s)}</small></${visao ? 'button' : 'div'}>`)
    .join('');
}

function renderVisoes() {
  $('pg-visoes').innerHTML = S.dados.opcoes.visoes
    .map((v) => `<button type="button" role="tab" class="pg-visao" data-visao="${v.id}" aria-selected="${S.f.visao === v.id}">${esc(v.rotulo)}</button>`)
    .join('');
}

function montarMulti(id, titulo, opcoes) {
  const el = $(`pg-f-${id}`);
  const aberto = el.querySelector('details')?.open;
  const sel = S.f[id];
  el.innerHTML = `<details${aberto ? ' open' : ''}><summary class="${sel.length ? 'ativo' : ''}">${esc(titulo)}${sel.length ? ` (${sel.length})` : ''}</summary>
    <div class="pg-multi-caixa">${opcoes
      .map((o) => `<label><input type="checkbox" data-filtro="${id}" value="${esc(o.valor)}"${sel.includes(String(o.valor)) ? ' checked' : ''}> ${esc(o.rotulo)}</label>`)
      .join('')}${sel.length ? `<hr><button type="button" class="limpar-sel" data-limpar="${id}">Limpar seleção</button>` : ''}</div></details>`;
}

function renderFiltros() {
  const o = S.dados.opcoes;
  montarMulti('situacao', 'Situação', o.situacoes.map((s) => ({ valor: s.valor, rotulo: s.rotulo })));
  montarMulti('statusPrazo', 'Status de prazo', o.statusPrazo);
  montarMulti('rota', 'Rota', [{ valor: 'sem', rotulo: 'Sem rota' }, ...o.rotas.map((r) => ({ valor: r.id, rotulo: `${r.id} · ${r.nome}` }))]);
  montarMulti('produto', 'Produto', o.categorias);
  montarMulti('tipo', 'Tipo', o.tiposPintura.map((t) => ({ valor: t, rotulo: NOMES_TIPO[t] })));
  montarMulti('cor', 'Cor', [{ valor: '', rotulo: 'Sem cor' }, ...o.cores.map((c) => ({ valor: c.id, rotulo: c.nome }))]);

  const colunasEl = $('pg-colunas');
  const aberto = colunasEl.querySelector('details')?.open;
  const grupos = [['consumos', 'Consumos (bobina, EPS, cola, tinta)'], ['parafusos', 'Parafusos'], ['componentes', 'Componentes'], ['terceiros', 'Terceiros']];
  colunasEl.innerHTML = `<details${aberto ? ' open' : ''}><summary>Colunas</summary><div class="pg-multi-caixa">${grupos
    .map(([k, t]) => `<label><input type="checkbox" data-coluna="${k}"${S.cols[k] ? ' checked' : ''}> ${esc(t)}</label>`)
    .join('')}</div></details>`;

  const massaSit = $('pg-massa-situacao');
  if (massaSit.options.length <= 1) massaSit.insertAdjacentHTML('beforeend', o.situacoes.map((s) => `<option value="${s.valor}">${esc(s.rotulo)}</option>`).join(''));
  const massaRota = $('pg-massa-rota');
  if (massaRota.options.length <= 1) massaRota.insertAdjacentHTML('beforeend', o.rotas.map((r) => `<option value="${r.id}">${r.id} · ${esc(r.nome)}</option>`).join(''));

  $('pg-busca').value !== S.f.q && ($('pg-busca').value = S.f.q);
  $('pg-campodata').value = S.f.campoData;
  $('pg-de').value = S.f.de;
  $('pg-ate').value = S.f.ate;
  $('pg-soalertas').checked = S.f.soAlertas;
  $('pg-agrupar').checked = S.agrupar;
  renderSalvas();
}

function renderSalvas() {
  const salvas = lerVisoes();
  const sel = $('pg-salvas');
  const atual = sel.value;
  sel.innerHTML = `<option value="">Visões salvas…</option>${Object.keys(salvas).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}`;
  sel.value = atual in salvas ? atual : '';
  $('pg-excluir-visao').hidden = !sel.value;
}

function lerVisoes() {
  try { return JSON.parse(localStorage.getItem(CHAVE_VISOES) || '{}'); } catch { return {}; }
}
function gravarVisoes(v) {
  try { localStorage.setItem(CHAVE_VISOES, JSON.stringify(v)); } catch { mostrarToast('Não foi possível guardar a visão neste navegador.'); }
}

function cabecalho(cols) {
  return `<tr><th><input type="checkbox" id="pg-sel-todos" title="Selecionar todos os itens listados"${pc() ? '' : ' hidden'}></th>${cols
    .map((c) => `<th>${esc(c.t)}${ORIGEM[c.o] || ''}</th>`)
    .join('')}</tr>`;
}

function renderTabela() {
  const cols = colunas();
  const itens = S.dados.itens;
  $('pg-thead').innerHTML = cabecalho(cols);

  if (itens.length === 0) {
    $('pg-tbody').innerHTML = `<tr><td colspan="${cols.length + 1}" class="pg-vazio"><b>Nenhum item nesta visão</b>${
      S.dados.totalGeral === 0
        ? 'Ainda não há itens: a programação é preenchida pela sincronização com a Nomus (botão “Sincronizar” no topo).'
        : 'Ajuste os filtros ou escolha outra visão acima.'
    }</td></tr>`;
    renderRodape();
    return;
  }

  const linhas = [];
  const vistos = new Set();
  const porPedido = new Map();
  for (const l of itens) porPedido.set(l.pedidoId, [...(porPedido.get(l.pedidoId) ?? []), l]);

  const linhaItem = (l, primeiro) =>
    `<tr data-id="${l.id}" class="${S.sel.has(l.id) ? 'sel' : ''}${l.situacao === 'CANCELADO' || l.situacao === 'DEVOLUCAO' ? ' cancelado' : ''}"><td>${
      pc() ? `<input type="checkbox" data-sel="${l.id}"${S.sel.has(l.id) ? ' checked' : ''}>` : ''
    }</td>${cols.map((c) => `<td class="${c.cls || ''}">${c.fn(l, primeiro)}</td>`).join('')}</tr>`;

  if (S.agrupar) {
    for (const l of itens) {
      if (vistos.has(l.pedidoId)) continue;
      vistos.add(l.pedidoId);
      const grupo = porPedido.get(l.pedidoId);
      const fechado = S.colapsados.has(l.pedidoId);
      const todosSel = grupo.every((x) => S.sel.has(x.id));
      const alertas = grupo.reduce((s, x) => s + x.alertas.length, 0);
      linhas.push(
        `<tr class="grp" data-grupo="${l.pedidoId}"><td>${pc() ? `<input type="checkbox" data-sel-pedido="${l.pedidoId}"${todosSel ? ' checked' : ''}>` : ''}</td>
         <td colspan="${cols.length}"><button type="button" class="tg" data-toggle="${l.pedidoId}" aria-expanded="${!fechado}">${fechado ? '▸' : '▾'}</button>
         <button type="button" class="pg-ped" data-abrir="${l.pedidoId}">Pedido ${l.numeroPedido}</button> · ${esc(l.cliente)} · ${esc(l.cidade || 'sem cidade')} ·
         ${grupo.length} ${grupo.length === 1 ? 'item' : 'itens'} · ${brl(l.valorPedido)} ·
         prazo ${esc(fmtData(l.prazoVigente) || '—')}${alertas ? ` <span class="pg-alerta" title="${alertas} alerta(s) nos itens">${alertas}</span>` : ''}</td></tr>`
      );
      if (!fechado) grupo.forEach((x, i) => linhas.push(linhaItem(x, i === 0)));
    }
  } else {
    for (const l of itens) {
      const primeiro = !vistos.has(l.pedidoId);
      vistos.add(l.pedidoId);
      linhas.push(linhaItem(l, primeiro));
    }
  }

  $('pg-tbody').innerHTML = linhas.join('');
  const todos = $('pg-sel-todos');
  if (todos) todos.checked = itens.length > 0 && itens.every((l) => S.sel.has(l.id));
  renderRodape();
}

function renderRodape() {
  const t = S.dados.totais;
  const cols = colunas().length + 1;
  $('pg-tfoot').innerHTML = `<tr><td colspan="${cols}">Total da visão: ${num(t.itens)} itens · ${num(t.pedidos)} pedidos · ${num(t.metrosChapa)} m de chapa · ${num(t.metrosTelha)} m de telha · ${brl(t.valor)} (valor somado uma vez por pedido; sem cancelados/devolvidos)</td></tr>`;
  $('pg-contagem').textContent = `${S.dados.itens.length} de ${S.dados.totalGeral} itens`;
  const sync = S.dados.sync;
  $('pg-sync').textContent = sync
    ? `Última leitura da Nomus: ${sync.finalizadoEm ? new Date(sync.finalizadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'em andamento'} · ${sync.criados} novos, ${sync.atualizados} atualizados${sync.erros ? `, ${sync.erros} com erro` : ''}`
    : 'Ainda sem leitura da Nomus';
  $('pg-perfil').textContent = pc() ? 'Nomus + PCP' : 'Somente leitura';
  renderMassa();
}

function renderMassa() {
  $('pg-massa').hidden = !pc() || S.sel.size === 0;
  $('pg-massa-n').textContent = `${S.sel.size} ${S.sel.size === 1 ? 'selecionado' : 'selecionados'}`;
}

function renderTudo() {
  renderStats();
  renderVisoes();
  renderFiltros();
  $('pg-config-abrir').hidden = !pc();
  renderTabela();
}

// ---------------------------------------------------------------- gaveta de detalhe

const opt = (lista, atual, vazio) =>
  `${vazio !== undefined ? `<option value="">${esc(vazio)}</option>` : ''}${lista
    .map((o) => `<option value="${esc(o.valor)}"${String(o.valor) === String(atual ?? '') ? ' selected' : ''}>${esc(o.rotulo)}</option>`)
    .join('')}`;

function campoDataDr(l, campo, rotulo) {
  return `<div class="pg-campo"><label>${rotulo}</label>${
    pc() ? `<input type="date" value="${esc(l[campo] ?? '')}" data-item="${l.id}" data-campo="${campo}" min="2000-01-01" max="2100-12-31">` : `<div class="ro">${esc(fmtData(l[campo]) || '—')}</div>`
  }</div>`;
}

function itemDrawer(l, o) {
  const manual = (campo) => (l.camposManuais.includes(campo) && pc() ? ` <button type="button" class="pg-mini" data-acao="resetar" data-item="${l.id}" data-campo="${campo}" title="Voltar ao cálculo automático">auto</button>` : '');
  const sel = (campo, opcoes, atual, vazio) => `<select data-item="${l.id}" data-campo="${campo}"${dis()}>${opt(opcoes, atual, vazio)}</select>`;
  const medidas = l.medidas.length ? l.medidas : [];

  return `<div class="pg-item" data-item-card="${l.id}">
    <div class="pg-item-topo"><div><b>${esc(l.categoriaRotulo)}${l.itemSeq ? ` · item ${esc(l.itemSeq)}` : ''}</b><div style="font-size:12px;color:#6c7d8f">${esc(l.produtoDescricao)}</div></div>
      <span class="pg-tag ${esc(l.statusPrazo.codigo)}">${esc(l.statusPrazo.texto)}</span></div>
    ${l.infoAdicional ? `<div class="pg-pre">${esc(l.infoAdicional)}</div>` : ''}
    ${l.alertas.length ? `<div class="pg-alertas">${l.alertas.map((a) => `<div><span>${esc(a.texto)}</span>${a.codigo === 'alterado_erp' && pc() ? `<button type="button" data-acao="reconhecer" data-item="${l.id}">Reconhecer</button>` : ''}</div>`).join('')}</div>` : ''}
    <div class="pg-grid">
      <div class="pg-campo"><label>Situação</label>${sel('situacao', o.situacoes.map((s) => ({ valor: s.valor, rotulo: s.rotulo })), l.situacao)}</div>
      <div class="pg-campo"><label>Fornecedor terceiro</label><input value="${esc(l.fornecedorTerceiro)}" data-item="${l.id}" data-campo="fornecedorTerceiro" maxlength="100"${dis()}></div>
      ${campoDataDr(l, 'dataProgramacao', 'Data de programação')}
      ${campoDataDr(l, 'dataLiberacaoProducao', 'Liberação da produção')}
      ${campoDataDr(l, 'dataProduzida', 'Data produzida')}
      ${campoDataDr(l, 'dataEntregaRealizada', 'Data de entrega')}
      ${campoDataDr(l, 'dataEntregaTerceiro', 'Entrega do terceiro')}
    </div>
    <div class="pg-grid tres" style="margin-top:12px">
      <div class="pg-campo"><label>Categoria${manual('categoria')}</label>${sel('categoria', o.categorias, l.categoria)}</div>
      <div class="pg-campo"><label>Tipo${manual('tipoPintura')}</label>${sel('tipoPintura', o.tiposPintura.map((t) => ({ valor: t, rotulo: NOMES_TIPO[t] })), l.tipoPintura, '—')}</div>
      <div class="pg-campo"><label>Cor${manual('corId')}</label>${sel('corId', o.cores.map((c) => ({ valor: c.id, rotulo: c.nome })), l.cor?.id, '—')}</div>
      <div class="pg-campo"><label>Trapézio${manual('trapezio')}</label>${sel('trapezio', [{ valor: 'TR25', rotulo: 'TR25' }, { valor: 'TR40', rotulo: 'TR40' }], l.trapezio, '—')}</div>
      <div class="pg-campo"><label>Faces de pintura${manual('facesPintura')}</label>${sel('facesPintura', [0, 1, 2].map((n) => ({ valor: n, rotulo: String(n) })), l.facesPintura)}</div>
      <div class="pg-campo"><label>Metros chapa${manual('metrosChapa')}</label><input type="number" min="0" step="0.01" value="${l.metrosChapa}" data-item="${l.id}" data-campo="metrosChapa"${dis()}></div>
    </div>
    <div class="pg-campo" style="margin-top:12px"><label>Medidas (qtd × comprimento em m)${manual('medidas')} · ${num(l.metrosTelha)} m de telha${l.medidasOrigem === 'quantidade' ? ' (só da quantidade)' : ''}</label>
      <div class="pg-medidas" data-medidas="${l.id}">${medidas.map((m) => medidaLinha(m)).join('')}</div>
      ${pc() ? `<div style="margin-top:6px;display:flex;gap:6px"><button type="button" class="pg-mini" data-acao="add-medida" data-item="${l.id}">+ medida</button><button type="button" class="pg-mini" data-acao="salvar-medidas" data-item="${l.id}">Salvar medidas</button></div>` : ''}
    </div>
    <div class="pg-campo" style="margin-top:12px"><label>OPs (Nomus)</label><div class="ro">${l.ops.length ? l.ops.map((x) => `${esc(x.numero)} <span style="color:#8a9aab">(${esc(x.status)}${x.inicioPlanejado ? `, início ${esc(fmtData(x.inicioPlanejado))}` : ''})</span>`).join('<br>') : '—'}</div></div>
    <div class="pg-campo" style="margin-top:6px"><label>Consumos</label>
      ${l.consumos.length ? `<table class="pg-consumos"><tr><th>Material</th><th>Quantidade</th><th>Origem</th></tr>${l.consumos.map((c) => `<tr><td>${esc(c.nome)}${c.cor ? ` <small style="color:#8a9aab">${esc(c.cor)}</small>` : ''}</td><td>${num(c.quantidade)} ${esc(c.unidade)}</td><td>${c.origem === 'calculado' ? 'calculado' : esc(c.origem)}</td></tr>`).join('')}</table>` : '<div class="ro">—</div>'}
      ${pc() ? `<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap"><select data-novo-consumo-material="${l.id}">${o.materiais.map((m) => `<option value="${m.codigo}">${esc(m.nome)} (${m.unidade})</option>`).join('')}</select><input type="number" min="0" step="any" placeholder="quantidade" data-novo-consumo-qtd="${l.id}" style="width:110px"><button type="button" class="pg-mini" data-acao="add-consumo" data-item="${l.id}">Lançar (0 remove)</button></div>` : ''}
    </div>
  </div>`;
}

const medidaLinha = (m) =>
  `<div class="pg-medida"><input type="number" min="1" step="1" value="${m.qtd}" data-m-qtd> × <input type="number" min="0.01" max="30" step="0.01" value="${m.comprimento_m}" data-m-comp> m
   <button type="button" class="pg-mini" data-acao="rm-medida">remover</button></div>`;

function drawerHtml(d) {
  const p = d.pedido;
  const o = d.opcoes;
  const eventos = d.eventos
    .map((e) => `<li><b>${esc(rotuloCampo(e.campo))}</b>: ${esc(e.valorAntigo ?? '—')} → ${esc(e.valorNovo ?? '—')}<small>${esc(e.usuario)}${e.origem !== 'usuario' ? ` (${esc(e.origem)})` : ''} · ${esc(new Date(e.em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }))}</small></li>`)
    .join('');

  return `<div class="pg-dr-topo"><div><h3>Pedido ${p.numeroPedido}</h3><small>${esc(p.cliente)}${p.telefone ? ` · ${esc(p.telefone)}` : ''} · ${esc(p.cidade || 'sem cidade')}</small></div>
      <button type="button" class="pg-dr-fechar" data-acao="fechar" aria-label="Fechar">×</button></div>
    <div class="pg-sec"><h4>Pedido</h4>
      <div class="pg-grid">
        <div class="pg-campo"><label>Data do pedido ${ORIGEM.n}</label><div class="ro">${esc(fmtData(p.dataPedido) || '—')}</div></div>
        <div class="pg-campo"><label>Valor a receber ${ORIGEM.n}</label><div class="ro">${brl(p.valor) || '—'}</div></div>
        <div class="pg-campo"><label>Prazo original do cliente ${ORIGEM.n}</label><div class="ro">${esc(fmtData(p.prazoOriginal) || '—')}</div></div>
        <div class="pg-campo"><label>Prazo negociado com o cliente ${ORIGEM.p}</label>${pc() ? `<input type="date" value="${esc(p.prazoNegociado ?? '')}" data-pedido-campo="dataEntregaNegociada" min="2000-01-01" max="2100-12-31">` : `<div class="ro">${esc(fmtData(p.prazoNegociado) || '—')}</div>`}</div>
        <div class="pg-campo"><label>Rota ${ORIGEM.p}</label><select data-pedido-campo="rotaId"${dis()}>${opt(o.rotas.map((r) => ({ valor: r.id, rotulo: `${r.id} · ${r.nome}` })), p.rotaId, 'Sem rota')}</select>
          ${pc() && p.cidade ? `<label class="pg-check" style="margin-top:5px"><input type="checkbox" id="pg-lembrar"> lembrar para ${esc(p.cidade)}</label>` : ''}</div>
        <div class="pg-campo"><label>Prazo vigente</label><div class="ro"><b>${esc(fmtData(p.prazoVigente) || '—')}</b></div></div>
        <div class="pg-campo"><label>Situação do pedido</label><div class="ro">${esc(o.situacoes.find((s) => s.valor === p.situacao)?.rotulo || '—')}</div></div>
      </div>
      <div class="pg-campo" style="margin-top:10px"><label>Observação ${ORIGEM.p}</label><textarea id="pg-obs" maxlength="4000"${dis()}>${esc(p.observacao)}</textarea>
        ${pc() ? `<div style="margin-top:6px;display:flex;gap:6px"><button type="button" class="pg-btn" data-acao="salvar-obs">Salvar observação</button><button type="button" class="btn-sync" data-acao="sync-pedido" title="Busca este pedido na Nomus agora">Sincronizar este pedido</button></div>` : ''}</div>
    </div>
    <div class="pg-sec"><h4>Itens (${d.itens.length})</h4>${d.itens.map((l) => itemDrawer(l, o)).join('')}</div>
    <div class="pg-sec"><h4>Histórico de alterações</h4>${eventos ? `<ul class="pg-linha">${eventos}</ul>` : '<div class="ro" style="color:#8a9aab;font-size:12px">Nenhuma alteração registrada.</div>'}</div>`;
}

const ROTULOS_CAMPO = {
  situacao: 'Situação', data_programacao: 'Data de programação', data_liberacao_producao: 'Liberação da produção', data_produzida: 'Data produzida',
  data_entrega_realizada: 'Data de entrega', fornecedor_terceiro: 'Fornecedor terceiro', data_entrega_terceiro: 'Entrega do terceiro',
  data_entrega_cliente_negociada: 'Prazo negociado', observacao: 'Observação', rota_id: 'Rota', categoria: 'Categoria', tipo_pintura: 'Tipo',
  cor_id: 'Cor', faces_pintura: 'Faces', trapezio: 'Trapézio', metros_chapa: 'Metros chapa', metros_telha: 'Metros telha',
  alterado_no_erp: 'Alterado no ERP', removido_no_erp: 'Removido no ERP',
};
const rotuloCampo = (c) => ROTULOS_CAMPO[c] || c;

async function abrirDetalhe(pedidoId, { manterRolagem = false } = {}) {
  const el = $('pg-drawer');
  const rolagem = manterRolagem ? el.scrollTop : 0;
  try {
    const d = await api(`/api/programacao/pedidos/${pedidoId}`);
    S.detalhe = { pedidoId, d };
    el.innerHTML = drawerHtml(d);
    el.hidden = false;
    el.scrollTop = rolagem;
  } catch (erro) {
    mostrarToast(`Não foi possível abrir o pedido: ${erro.message}`);
  }
}

function fecharDetalhe() {
  S.detalhe = null;
  $('pg-drawer').hidden = true;
}

function lerMedidas(itemId) {
  const linhas = [...document.querySelectorAll(`[data-medidas="${itemId}"] .pg-medida`)];
  return linhas
    .map((r) => ({ qtd: Number(r.querySelector('[data-m-qtd]').value), comprimento_m: Number(r.querySelector('[data-m-comp]').value) }))
    .filter((m) => m.qtd > 0 && m.comprimento_m > 0);
}

// ---------------------------------------------------------------- configurações

async function abrirConfig() {
  const dlg = $('pg-config');
  const corpo = $('pg-config-corpo');
  corpo.innerHTML = '<p class="dica">Carregando…</p>';
  dlg.showModal();
  try {
    const [parametros, produtos] = await Promise.all([api('/api/programacao/parametros'), api('/api/programacao/produtos')]);
    const o = S.dados.opcoes;
    const sync = S.dados.sync;
    corpo.innerHTML = `
      <h4>Parâmetros de cálculo</h4>
      <p class="dica">Mudar um parâmetro recalcula os itens ainda não produzidos; os já produzidos ficam congelados. Valores iniciais vieram da planilha: confirme os marcados como pergunta aberta.</p>
      <table><tr><th>Parâmetro</th><th>Valor</th><th>Descrição</th></tr>${parametros
        .map((p) => `<tr><td><code>${esc(p.chave)}</code></td><td><input type="number" step="any" min="0" value="${p.valor}" data-parametro="${esc(p.chave)}" style="width:100px"></td><td>${esc(p.descricao)}</td></tr>`)
        .join('')}</table>
      <h4>Cidade → rota</h4>
      <p class="dica">Cidades sem rota aparecem com alerta. Ao escolher a rota de um pedido na gaveta, marque “lembrar para a cidade”, ou cadastre aqui. Pedidos com rota escolhida à mão não são alterados.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="cfg-cidade" placeholder="Cidade-UF (ex.: Sorocaba-SP)" style="min-width:240px"><select id="cfg-rota">${o.rotas.map((r) => `<option value="${r.id}">${r.id} · ${esc(r.nome)}</option>`).join('')}</select><button type="button" class="pg-btn" data-cfg="cidade-rota">Gravar</button></div>
      <h4>Produtos da Nomus → categoria</h4>
      <p class="dica">A categoria é deduzida da descrição do produto. Corrija aqui o que ficou errado: os itens que usam o produto são refeitos.</p>
      <table><tr><th>Código</th><th>Descrição</th><th>Categoria</th></tr>${produtos
        .map((p) => `<tr><td>${esc(p.codigo)}</td><td>${esc(p.descricao)}</td><td><select data-produto="${p.nomusId}">${opt(o.categorias, p.categoria)}</select>${p.categoriaManual ? ' <small>(ajustado)</small>' : ''}</td></tr>`)
        .join('') || '<tr><td colspan="3" class="dica">Nenhum produto lido ainda (rode a sincronização).</td></tr>'}</table>
      <h4>Importar histórico da planilha</h4>
      <p class="dica">Uso único: traz da planilha “Programação de Produção 2026.xlsx” (abas <b>Base</b> e <b>Rotas</b>) só o que não existe na Nomus: situação, datas de programação/liberação/produção/entrega, prazo negociado, observação e rota. Primeiro <b>simule</b>: nada é gravado e você baixa o relatório com o que seria importado, ajustado e rejeitado. Ao gravar, o sistema tira um backup do banco antes. Itens editados no sistema depois da carga são preservados.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><input type="file" id="cfg-arquivo" accept=".xlsx"><button type="button" class="pg-btn" data-cfg="simular">Simular (não grava)</button>
        <label class="pg-check"><input type="checkbox" id="cfg-forcar"> sobrescrever também o que foi editado no sistema</label></div>
      <div id="cfg-import-resultado" class="dica" style="margin-top:10px"></div>
      <h4>Última leitura da Nomus</h4>
      <p class="dica">${sync ? `${sync.pedidosLidos} pedidos lidos, ${sync.criados} novos, ${sync.atualizados} atualizados, ${sync.erros} com erro.` : 'Nenhuma leitura ainda.'}${sync?.detalheErros?.length ? `<br>${sync.detalheErros.map((e) => esc(e)).join('<br>')}` : ''}</p>`;
  } catch (erro) {
    corpo.innerHTML = `<p class="dica">Não foi possível carregar: ${esc(erro.message)}</p>`;
  }
}

// ---------------------------------------------------------------- eventos

const grade = $('pg-tbody');

grade.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.sel) {
    const id = Number(el.dataset.sel);
    el.checked ? S.sel.add(id) : S.sel.delete(id);
    el.closest('tr').classList.toggle('sel', el.checked);
    renderMassa();
    return;
  }
  if (el.dataset.selPedido) {
    for (const l of S.dados.itens.filter((x) => x.pedidoId === Number(el.dataset.selPedido))) el.checked ? S.sel.add(l.id) : S.sel.delete(l.id);
    renderTabela();
    return;
  }

  if (el.dataset.item && el.dataset.campo) {
    const campo = el.dataset.campo;
    let valor = el.value;
    if (el.type === 'date') {
      if (valor && !/^(20\d\d)-\d\d-\d\d$/.test(valor)) return; // ano ainda sendo digitado
      valor = valor || null;
    }
    const corpo = { [campo]: valor };
    const linha = S.dados.itens.find((x) => x.id === Number(el.dataset.item));
    // Produzido pede a data: se não houver, assume hoje (o servidor exige e deixa editar depois).
    if (campo === 'situacao' && valor === 'PRODUZIDO' && linha && !linha.dataProduzida) corpo.dataProduzida = S.dados.hoje;
    await patchItem(Number(el.dataset.item), corpo, el);
    return;
  }

  if (el.dataset.pedido && el.dataset.campo === 'rotaId') {
    el.classList.add('salvando');
    await patchPedido(Number(el.dataset.pedido), { rotaId: el.value === '' ? null : Number(el.value) });
  }
});

grade.addEventListener('click', (e) => {
  const abrir = e.target.closest('[data-abrir]');
  if (abrir) return void abrirDetalhe(Number(abrir.dataset.abrir));
  const tg = e.target.closest('[data-toggle]');
  if (tg) {
    const id = Number(tg.dataset.toggle);
    S.colapsados.has(id) ? S.colapsados.delete(id) : S.colapsados.add(id);
    renderTabela();
  }
});

$('pg-thead').addEventListener('change', (e) => {
  if (e.target.id !== 'pg-sel-todos') return;
  for (const l of S.dados.itens) e.target.checked ? S.sel.add(l.id) : S.sel.delete(l.id);
  renderTabela();
});

$('pg-visoes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-visao]');
  if (!b) return;
  S.f.visao = b.dataset.visao;
  S.f.situacao = [];
  carregar();
});

$('pg-stats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-visao]');
  if (!b) return;
  S.f.visao = b.dataset.visao;
  carregar();
});

document.querySelector('.pg-filtros').addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.filtro) {
    const k = el.dataset.filtro;
    S.f[k] = el.checked ? [...S.f[k], el.value] : S.f[k].filter((v) => v !== el.value);
    if (k === 'situacao' && S.f.situacao.length) S.f.visao = 'todos'; // escolher a situação manda: a visão não pode escondê-la
    carregar();
  } else if (el.id === 'pg-campodata' || el.id === 'pg-de' || el.id === 'pg-ate') {
    S.f.campoData = $('pg-campodata').value;
    S.f.de = $('pg-de').value;
    S.f.ate = $('pg-ate').value;
    if (el.id !== 'pg-campodata' || S.f.de || S.f.ate) carregar();
  } else if (el.id === 'pg-soalertas') {
    S.f.soAlertas = el.checked;
    carregar();
  }
});

document.querySelector('.pg-filtros').addEventListener('click', (e) => {
  const l = e.target.closest('[data-limpar]');
  if (!l) return;
  S.f[l.dataset.limpar] = [];
  carregar();
});

$('pg-busca').addEventListener('input', (e) => {
  S.f.q = e.target.value;
  clearTimeout(S.timerBusca);
  S.timerBusca = setTimeout(() => carregar(), 350);
});

$('pg-agrupar').addEventListener('change', (e) => {
  S.agrupar = e.target.checked;
  renderTabela();
});

$('pg-colunas').addEventListener('change', (e) => {
  if (!e.target.dataset.coluna) return;
  S.cols[e.target.dataset.coluna] = e.target.checked;
  renderTabela();
});

// Fecha as caixas de seleção ao clicar fora delas.
document.addEventListener('click', (e) => {
  document.querySelectorAll('.pg-multi details[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
});

$('pg-limpar').addEventListener('click', () => {
  S.f = filtrosPadrao();
  $('pg-busca').value = '';
  carregar();
});

$('pg-salvar-visao').addEventListener('click', () => {
  const nome = (prompt('Nome da visão:') || '').trim().slice(0, 40);
  if (!nome) return;
  const v = lerVisoes();
  v[nome] = JSON.parse(JSON.stringify(S.f));
  gravarVisoes(v);
  renderSalvas();
  $('pg-salvas').value = nome;
  $('pg-excluir-visao').hidden = false;
  msg(`Visão “${nome}” salva neste navegador`);
});

$('pg-salvas').addEventListener('change', (e) => {
  const v = lerVisoes()[e.target.value];
  $('pg-excluir-visao').hidden = !v;
  if (!v) return;
  S.f = { ...filtrosPadrao(), ...v };
  carregar();
});

$('pg-excluir-visao').addEventListener('click', () => {
  const nome = $('pg-salvas').value;
  if (!nome || !confirm(`Excluir a visão “${nome}”?`)) return;
  const v = lerVisoes();
  delete v[nome];
  gravarVisoes(v);
  renderSalvas();
});

$('pg-exportar').addEventListener('click', async () => {
  try {
    let token = '';
    try { token = localStorage.getItem('pcp_token') || ''; } catch { /* sem storage */ }
    const res = await fetch(`/api/programacao/exportar.csv?${queryString(S.f)}`, { headers: token ? { 'x-pcp-token': token } : {} });
    if (!res.ok) throw new Error(`Erro ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: `programacao-${S.dados.hoje}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (erro) {
    mostrarToast(`Não foi possível exportar: ${erro.message}`);
  }
});

$('pg-massa-limpar').addEventListener('click', () => {
  S.sel.clear();
  renderTabela();
});

$('pg-massa-aplicar').addEventListener('click', async () => {
  const corpo = { ids: [...S.sel] };
  if ($('pg-massa-situacao').value) corpo.situacao = $('pg-massa-situacao').value;
  if ($('pg-massa-data').value) corpo.dataProgramacao = $('pg-massa-data').value;
  if ($('pg-massa-rota').value) corpo.rotaId = Number($('pg-massa-rota').value);
  if (Object.keys(corpo).length === 1) return mostrarToast('Escolha ao menos uma situação, data ou rota para aplicar.');
  if (!confirm(`Aplicar a ${corpo.ids.length} item(ns)?`)) return;
  try {
    await garantirUsuario();
    const r = await api('/api/programacao/lote', { method: 'POST', body: JSON.stringify(corpo) });
    msg(`${r.atualizados} item(ns) atualizados`);
    S.sel.clear();
    for (const id of ['pg-massa-situacao', 'pg-massa-data', 'pg-massa-rota']) $(id).value = '';
    await carregar();
  } catch (erro) {
    mostrarToast(erro.message); // edição em massa é atômica: se um item falhar, nada foi gravado
    msg(`Nada foi alterado: ${erro.message}`, false);
  }
});

$('pg-config-abrir').addEventListener('click', abrirConfig);

$('pg-config').addEventListener('change', async (e) => {
  const el = e.target;
  try {
    if (el.dataset.parametro) {
      const r = await api('/api/programacao/parametros', { method: 'PATCH', body: JSON.stringify({ chave: el.dataset.parametro, valor: Number(el.value) }) });
      mostrarToast(`Parâmetro salvo. ${r.recalculados} item(ns) recalculados.`);
      carregar({ silencioso: true });
    } else if (el.dataset.produto) {
      const r = await api(`/api/programacao/produtos/${el.dataset.produto}`, { method: 'PATCH', body: JSON.stringify({ categoria: el.value }) });
      mostrarToast(`Categoria salva. ${r.itensAfetados} item(ns) refeitos.`);
      carregar({ silencioso: true });
    }
  } catch (erro) {
    mostrarToast(erro.message);
  }
});

let ultimoCsv = '';

async function enviarPlanilha(gravar) {
  const arquivo = $('cfg-arquivo').files[0];
  const saida = $('cfg-import-resultado');
  if (!arquivo) return void (saida.textContent = 'Escolha o arquivo .xlsx primeiro.');
  saida.textContent = gravar ? 'Gravando… (pode levar alguns segundos)' : 'Simulando…';
  try {
    let token = '';
    try { token = localStorage.getItem('pcp_token') || ''; } catch { /* sem storage */ }
    const res = await fetch(`/api/programacao/importar?gravar=${gravar ? 1 : 0}&forcar=${$('cfg-forcar').checked ? 1 : 0}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...(token ? { 'x-pcp-token': token } : {}) },
      body: arquivo,
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.erro || `Erro ${res.status}`);
    ultimoCsv = r.csv;
    const x = r.resumo;
    saida.innerHTML = `<b>${r.gravou ? 'Importação GRAVADA' : 'Simulação (nada foi gravado)'}</b>${r.backup ? ` · backup: ${esc(r.backup)}` : ''}<br>
      ${x.importada} importadas · ${x.ajustada} ajustadas · ${x.rejeitada} rejeitadas · ${x.sem_mudanca} sem mudança · ${x.ignorada} ignoradas (vazias) ·
      rotas: ${x.rotasNovas} novas, ${x.rotasDivergentes} divergentes mantidas<br>
      <button type="button" class="pg-mini" data-cfg="baixar-relatorio">Baixar relatório (CSV)</button>
      ${r.gravou ? '' : '<button type="button" class="pg-btn" data-cfg="gravar" style="margin-left:6px">Gravar importação</button>'}`;
    if (r.gravou) carregar({ silencioso: true });
  } catch (erro) {
    saida.textContent = `Não foi possível importar: ${erro.message}`;
  }
}

$('pg-config').addEventListener('click', async (e) => {
  const acao = e.target.dataset.cfg;
  if (acao === 'simular') return void enviarPlanilha(false);
  if (acao === 'gravar') {
    if (confirm('Gravar a importação? Um backup do banco é feito antes.')) enviarPlanilha(true);
    return;
  }
  if (acao === 'baixar-relatorio') {
    const url = URL.createObjectURL(new Blob([ultimoCsv], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `importacao-planilha-${S.dados.hoje}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }
  if (acao !== 'cidade-rota') return;
  try {
    const r = await api('/api/programacao/cidades-rota', { method: 'PUT', body: JSON.stringify({ cidade: $('cfg-cidade').value, rotaId: Number($('cfg-rota').value) }) });
    mostrarToast(`Rota gravada. ${r.pedidosAfetados} pedido(s) atualizados.`);
    $('cfg-cidade').value = '';
    carregar({ silencioso: true });
  } catch (erro) {
    mostrarToast(erro.message);
  }
});

// Gaveta
const gaveta = $('pg-drawer');

gaveta.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.item && el.dataset.campo) {
    let valor = el.value;
    if (el.type === 'date') {
      if (valor && !/^(20\d\d)-\d\d-\d\d$/.test(valor)) return;
      valor = valor || null;
    } else if (el.type === 'number') {
      valor = Number(valor);
    } else if (el.dataset.campo === 'corId' || el.dataset.campo === 'facesPintura') {
      valor = valor === '' ? null : Number(valor);
    } else if (valor === '' && ['tipoPintura', 'trapezio'].includes(el.dataset.campo)) {
      valor = null;
    }
    const corpo = { [el.dataset.campo]: valor };
    const linha = S.detalhe?.d.itens.find((x) => x.id === Number(el.dataset.item));
    if (el.dataset.campo === 'situacao' && valor === 'PRODUZIDO' && linha && !linha.dataProduzida) corpo.dataProduzida = S.detalhe.d.hoje;
    await patchItem(Number(el.dataset.item), corpo, el);
  } else if (el.dataset.pedidoCampo) {
    const campo = el.dataset.pedidoCampo;
    const corpo = { [campo]: el.value === '' ? null : campo === 'rotaId' ? Number(el.value) : el.value };
    if (campo === 'dataEntregaNegociada' && el.value && !/^(20\d\d)-\d\d-\d\d$/.test(el.value)) return;
    if (campo === 'rotaId') corpo.lembrarCidade = $('pg-lembrar')?.checked || false;
    await patchPedido(S.detalhe.pedidoId, corpo);
  }
});

gaveta.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-acao]');
  if (!b) return;
  const acao = b.dataset.acao;
  const item = Number(b.dataset.item);

  if (acao === 'fechar') return fecharDetalhe();
  if (acao === 'add-medida') {
    b.closest('.pg-campo').querySelector('.pg-medidas').insertAdjacentHTML('beforeend', medidaLinha({ qtd: 1, comprimento_m: 1 }));
  } else if (acao === 'rm-medida') {
    b.closest('.pg-medida').remove();
  } else if (acao === 'salvar-medidas') {
    await patchItem(item, { medidas: lerMedidas(item) }, b);
  } else if (acao === 'resetar') {
    await patchItem(item, { resetar: [b.dataset.campo] }, b);
  } else if (acao === 'reconhecer') {
    await patchItem(item, { reconhecerAlteracaoErp: true }, b);
  } else if (acao === 'salvar-obs') {
    await patchPedido(S.detalhe.pedidoId, { observacao: $('pg-obs').value });
  } else if (acao === 'add-consumo') {
    const material = document.querySelector(`[data-novo-consumo-material="${item}"]`).value;
    const quantidade = Number(document.querySelector(`[data-novo-consumo-qtd="${item}"]`).value);
    try {
      await garantirUsuario();
      await api(`/api/programacao/itens/${item}/consumos`, { method: 'PUT', body: JSON.stringify({ material, quantidade }) });
      msg('Consumo lançado');
      await carregar({ silencioso: true });
      await abrirDetalhe(S.detalhe.pedidoId, { manterRolagem: true });
    } catch (erro) {
      mostrarToast(erro.message);
    }
  } else if (acao === 'sync-pedido') {
    b.disabled = true;
    try {
      await api(`/api/programacao/pedidos/${S.detalhe.pedidoId}/sincronizar`, { method: 'POST' });
      msg('Pedido sincronizado com a Nomus');
      await carregar({ silencioso: true });
      await abrirDetalhe(S.detalhe.pedidoId, { manterRolagem: true });
    } catch (erro) {
      mostrarToast(`Não foi possível sincronizar: ${erro.message}`);
    } finally {
      b.disabled = false;
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('pg-drawer').hidden) fecharDetalhe();
});

// ---------------------------------------------------------------- ponte com o app.js

window.PCP.programacao = {
  abrirPedido: (id) => abrirDetalhe(id),
  get perfil() { return S.dados?.perfil; },
  garantirUsuario,
  ativar() {
    if (!S.montado) S.montado = true;
    carregar();
  },
  recarregar() {
    if (!$('view-programacao').hidden) carregar({ silencioso: true });
  },
};

// Atualiza sozinha (outra pessoa pode ter editado), sem atrapalhar quem digita.
setInterval(() => {
  if (!$('view-programacao').hidden && !document.hidden) carregar({ silencioso: true });
}, 90_000);
