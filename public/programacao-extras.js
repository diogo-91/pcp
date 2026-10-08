// Abas Agenda, Painel, Compras de terceiros, Parafusos e Calculadora da Programação.
// Só imprime o que o servidor calcula (ocupação, totais, valores, quantidade a comprar) e salva o que o PCP edita.

const { api, esc, fmtData, $, mostrarToast } = window.PCP;

const brl = (n) => (n === null || n === undefined ? '' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const num = (n) => (n === null || n === undefined ? '' : n.toLocaleString('pt-BR', { maximumFractionDigits: 2 }));
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const completo = () => window.PCP.programacao?.perfil !== 'consulta';

const E = { aba: 'pedidos', agenda: null, ini: '', fim: '', painel: null, compras: null, perfil: 'completo' };

// ---------------------------------------------------------------- abas

const RENDER = { agenda: carregarAgenda, painel: carregarPainel, compras: carregarCompras, parafusos: carregarParafusos, calculadora: renderCalculadora };

function mostrarAba(aba) {
  E.aba = aba;
  document.querySelectorAll('#pg-abas [data-aba]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.aba === aba)));
  for (const nome of ['pedidos', 'agenda', 'painel', 'compras', 'parafusos', 'calculadora']) {
    $(`pg-sec-${nome}`).hidden = nome !== aba;
  }
  if (aba === 'pedidos') window.PCP.programacao?.recarregar?.();
  else RENDER[aba]();
}

$('pg-abas').addEventListener('click', (e) => {
  const b = e.target.closest('[data-aba]');
  if (b) mostrarAba(b.dataset.aba);
});

async function salvando(fn) {
  try {
    await window.PCP.programacao?.garantirUsuario?.();
    return await fn();
  } catch (erro) {
    mostrarToast(erro.message);
    return null;
  }
}

// ---------------------------------------------------------------- agenda (arrastar e soltar)

const cartaoItem = (i, arrastavel) =>
  `<div class="pg-cartao" ${arrastavel ? `draggable="true" data-arrasta="${i.id}"` : ''} data-pedido="${i.pedidoId}" title="${esc(`${i.categoriaRotulo} · prazo ${fmtData(i.prazoVigente) || '—'}`)}">
    <b>#${i.numeroPedido}</b> ${esc(i.cliente)}
    <span class="pg-sub">${esc(i.rota || 'sem rota')} · ${esc(i.situacaoRotulo)} · ${esc(i.categoriaRotulo)}</span>
    <span class="pg-sub">${num(i.metros)} m${i.metrosPintados ? ` · pint. ${num(i.metrosPintados)}` : ''}${i.eps ? ` · EPS ${num(i.eps)}` : ''}${i.valorPedido ? ` · ${brl(i.valorPedido)}` : ''}</span>
  </div>`;

async function carregarAgenda() {
  const q = new URLSearchParams();
  if (E.ini) q.set('de', E.ini);
  if (E.fim) q.set('ate', E.fim);
  try {
    E.agenda = await api(`/api/programacao/agenda?${q}`);
    E.ini = E.agenda.de;
    E.fim = E.agenda.ate;
    renderAgenda();
  } catch (erro) {
    mostrarToast(`Não foi possível carregar a agenda: ${erro.message}`);
  }
}

function renderAgenda() {
  const a = E.agenda;
  const edita = completo();
  const dias = a.dias
    .map((d) => {
      const [ano, mes, dia] = d.data.split('-');
      return `<div class="pg-dia${d.util ? '' : ' folga'}" data-dia="${d.data}">
        <div class="pg-dia-topo"><b>${DIAS[d.diaSemana]} ${dia}/${mes}</b>${d.feriado ? `<span class="pg-tag sem_data">${esc(d.feriado)}</span>` : d.util ? '' : '<span class="pg-tag sem_data">sem expediente</span>'}</div>
        <div class="pg-barra-ocup" title="${d.ocupacaoPct}% da capacidade"><span class="${d.nivel}" style="width:${Math.min(100, d.ocupacaoPct)}%"></span></div>
        <div class="pg-sub" style="margin:3px 0 6px"><b>${num(d.metros)}</b> / ${num(d.capacidade)} m (${d.ocupacaoPct}%) · livre ${num(d.livre)} m${d.metrosPintados ? `<br>pintura ${num(d.metrosPintados)} m` : ''}${d.eps ? ` · EPS ${num(d.eps)} m` : ''}${d.valor ? ` · ${brl(d.valor)}` : ''}</div>
        ${d.itens.map((i) => cartaoItem(i, edita)).join('') || '<div class="pg-sub" style="padding:8px 0">Nenhum item</div>'}
      </div>`;
    })
    .join('');

  $('pg-sec-agenda').innerHTML = `
    <div class="pg-barra-topo">
      <button type="button" class="btn-sync" data-ag="ant">‹ Semana anterior</button>
      <button type="button" class="btn-sync" data-ag="hoje">Esta semana</button>
      <button type="button" class="btn-sync" data-ag="prox">Próxima semana ›</button>
      <input type="date" id="ag-de" value="${esc(a.de)}" aria-label="De"><span>até</span><input type="date" id="ag-ate" value="${esc(a.ate)}" aria-label="Até">
      <span class="pg-sub" style="margin-left:auto">Capacidade: ${num(a.capacidade)} m/dia · ${edita ? 'arraste um item para outro dia' : 'somente leitura'}</span>
      ${edita ? '<button type="button" class="btn-sync" data-ag="feriados">Feriados</button>' : ''}
    </div>
    <div class="pg-agenda">
      <aside class="pg-lateral" data-solta-lista>
        <h4>A programar (${a.aProgramar.length})</h4>
        <div class="pg-sub" style="margin-bottom:6px">Liberados e ainda sem data. Arraste para um dia.</div>
        ${a.aProgramar.map((i) => cartaoItem(i, edita)).join('') || '<div class="pg-sub">Nada a programar.</div>'}
        ${a.vencidas.length ? `<h4 style="margin-top:14px;color:#b23a47">Programação vencida (${a.vencidas.length})</h4>${a.vencidas.map((i) => cartaoItem(i, edita)).join('')}` : ''}
      </aside>
      <div class="pg-dias">${dias}</div>
    </div>`;
}

const mover = (dias) => {
  const soma = (iso, n) => {
    const [a, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
  };
  E.ini = soma(E.ini, dias);
  E.fim = soma(E.fim, dias);
  carregarAgenda();
};

$('pg-sec-agenda').addEventListener('click', async (e) => {
  const ag = e.target.closest('[data-ag]')?.dataset.ag;
  if (ag === 'ant') return mover(-7);
  if (ag === 'prox') return mover(7);
  if (ag === 'hoje') { E.ini = ''; E.fim = ''; return carregarAgenda(); }
  if (ag === 'feriados') return abrirFeriados();
  const cartao = e.target.closest('[data-pedido]');
  if (cartao) window.PCP.programacao?.abrirPedido?.(Number(cartao.dataset.pedido));
});

$('pg-sec-agenda').addEventListener('change', (e) => {
  if (e.target.id === 'ag-de' || e.target.id === 'ag-ate') {
    E.ini = $('ag-de').value;
    E.fim = $('ag-ate').value;
    if (E.ini && E.fim) carregarAgenda();
  }
});

let arrastando = null;
$('pg-sec-agenda').addEventListener('dragstart', (e) => {
  const c = e.target.closest('[data-arrasta]');
  if (!c) return;
  arrastando = Number(c.dataset.arrasta);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(arrastando));
});
$('pg-sec-agenda').addEventListener('dragover', (e) => {
  if (arrastando !== null && e.target.closest('[data-dia],[data-solta-lista]')) e.preventDefault();
});
$('pg-sec-agenda').addEventListener('drop', async (e) => {
  const dia = e.target.closest('[data-dia]');
  const lista = e.target.closest('[data-solta-lista]');
  if (arrastando === null || (!dia && !lista)) return;
  e.preventDefault();
  const id = arrastando;
  arrastando = null;
  const item = [...E.agenda.aProgramar, ...E.agenda.vencidas, ...E.agenda.dias.flatMap((d) => d.itens)].find((i) => i.id === id);
  // Item novo ("a programar") que ganha dia passa a Programado; voltar para a lista tira a data.
  const corpo = dia
    ? { dataProgramacao: dia.dataset.dia, ...(item?.situacao === 'PROGRAMAR' ? { situacao: 'PROGRAMADO' } : {}) }
    : { dataProgramacao: null, ...(item?.situacao === 'PROGRAMADO' ? { situacao: 'PROGRAMAR' } : {}) };
  await salvando(() => api(`/api/programacao/itens/${id}`, { method: 'PATCH', body: JSON.stringify(corpo) }));
  await carregarAgenda();
});
$('pg-sec-agenda').addEventListener('dragend', () => { arrastando = null; });

async function abrirFeriados() {
  const dlg = $('pg-dlg-extra');
  const desenhar = (lista) => {
    $('pg-dlg-titulo').textContent = 'Feriados (dias sem produção)';
    $('pg-dlg-corpo').innerHTML = `<p class="pg-sub">Sábados e domingos já ficam de fora. Feriados cadastrados também não contam como dia de trabalho na agenda e nas médias por dia útil.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0"><input type="date" id="fer-data"><input id="fer-nome" placeholder="Nome (ex.: Natal)"><button type="button" class="pg-btn" data-fer="add">Adicionar</button></div>
      <table class="pg-consumos">${lista.map((f) => `<tr><td>${esc(fmtData(f.data))}</td><td>${esc(f.nome)}</td><td><button type="button" class="pg-mini" data-fer="del" data-data="${esc(f.data)}">remover</button></td></tr>`).join('') || '<tr><td>Nenhum feriado cadastrado.</td></tr>'}</table>`;
  };
  desenhar(await api('/api/programacao/feriados'));
  dlg.showModal();
  $('pg-dlg-corpo').onclick = async (e) => {
    const b = e.target.closest('[data-fer]');
    if (!b) return;
    const lista = await salvando(() =>
      b.dataset.fer === 'add'
        ? api('/api/programacao/feriados', { method: 'PUT', body: JSON.stringify({ data: $('fer-data').value, nome: $('fer-nome').value }) })
        : api(`/api/programacao/feriados/${b.dataset.data}`, { method: 'DELETE' })
    );
    if (lista) { desenhar(lista); carregarAgenda(); }
  };
}

// ---------------------------------------------------------------- painel

async function carregarPainel() {
  const q = new URLSearchParams();
  if (E.painelDe) q.set('de', E.painelDe);
  if (E.painelAte) q.set('ate', E.painelAte);
  try {
    E.painel = await api(`/api/programacao/painel?${q}`);
    renderPainel();
  } catch (erro) {
    mostrarToast(`Não foi possível carregar o painel: ${erro.message}`);
  }
}

function renderPainel() {
  const p = E.painel;
  const linhaSoma = (t, rotulo) =>
    `<tr><td>${esc(rotulo)}</td><td class="n">${num(t.itens)}</td><td class="n">${num(t.metros)}</td><td class="n">${num(t.metrosPintados)}</td><td class="n">${num(t.eps)}</td><td class="n">${num(t.bobinaKg)}</td><td class="n">${brl(t.valor)}</td></tr>`;
  $('pg-sec-painel').innerHTML = `
    <div class="pg-barra-topo"><span>Período (prazo vigente dos itens em aberto; meses no quadro 3):</span>
      <input type="date" id="pn-de" value="${esc(p.de || '')}" aria-label="De"><span>até</span><input type="date" id="pn-ate" value="${esc(p.ate || '')}" aria-label="Até">
      <button type="button" class="btn-sync" data-pn="limpar">Sem filtro</button></div>

    <article class="panel pg-quadro"><div class="panelhead"><h2>1. Em aberto por situação</h2></div>
      <div class="pg-wrap" style="max-height:none"><table class="pg-tabela"><thead><tr><th>Situação</th><th>Itens</th><th>Metros</th><th>Metros pintados</th><th>EPS (m)</th><th>Bobina (kg)</th><th>Valor</th></tr></thead>
      <tbody>${p.porSituacao.map((s) => linhaSoma(s, s.rotulo)).join('') || '<tr><td colspan="7" class="pg-vazio">Nada em aberto neste período.</td></tr>'}</tbody>
      <tfoot><tr><td>Total</td><td class="n">${num(p.totalEmAberto.itens)}</td><td class="n">${num(p.totalEmAberto.metros)}</td><td class="n">${num(p.totalEmAberto.metrosPintados)}</td><td class="n">${num(p.totalEmAberto.eps)}</td><td class="n">${num(p.totalEmAberto.bobinaKg)}</td><td class="n">${brl(p.totalEmAberto.valor)}</td></tr></tfoot></table></div></article>

    <article class="panel pg-quadro"><div class="panelhead"><h2>2. Em aberto por rota</h2><small>${p.porRota.length} rotas</small></div>
      ${p.porRota
        .map(
          (r) => `<details class="pg-rota"><summary><b>${esc(r.rota)}</b> · ${r.pedidos.length} pedidos · ${num(r.metros)} m · ${brl(r.valor)}</summary>
        <table class="pg-tabela"><thead><tr><th>Pedido</th><th>Cliente</th><th>Cidade</th><th>Prazo</th><th>Situação</th><th>Itens</th><th>Metros</th></tr></thead><tbody>
        ${r.pedidos.map((x) => `<tr><td><button type="button" class="pg-ped" data-abrir-pedido="${x.pedidoId}">${x.numeroPedido}</button></td><td>${esc(x.cliente)}</td><td>${esc(x.cidade)}</td><td>${esc(fmtData(x.prazoVigente) || '—')} <span class="pg-tag ${esc(x.statusPrazo)}">${esc(x.statusPrazo.replace(/_/g, ' '))}</span></td><td>${esc(x.situacaoRotulo)}</td><td class="n">${x.itens}</td><td class="n">${num(x.metros)}</td></tr>`).join('')}
        </tbody></table></details>`
        )
        .join('') || '<div class="pg-vazio">Nada em aberto.</div>'}</article>

    <article class="panel pg-quadro"><div class="panelhead"><h2>3. Produção x vendas por mês</h2><small>produzido = data produzida · vendido = data do pedido (Nomus)</small></div>
      <div class="pg-wrap" style="max-height:none"><table class="pg-tabela"><thead><tr><th>Mês</th><th>Dias úteis</th><th>Produzido (m)</th><th>Pintados (m)</th><th>Média/dia</th><th>Vendido (m)</th><th>Pintados (m)</th><th>Média/dia</th><th>Entregues</th><th>No prazo</th></tr></thead><tbody>
      ${p.mensal.map((m) => `<tr><td><b>${esc(m.rotulo)}</b></td><td class="n">${m.diasUteis}</td><td class="n">${num(m.produzido.metros)}</td><td class="n">${num(m.produzido.metrosPintados)}</td><td class="n">${num(m.produzido.mediaDiaMetros)}</td><td class="n">${num(m.vendido.metros)}</td><td class="n">${num(m.vendido.metrosPintados)}</td><td class="n">${num(m.vendido.mediaDiaMetros)}</td><td class="n">${m.entregues}</td><td class="n">${m.pontualidadePct === null ? '—' : `${m.pontualidadePct}%`}</td></tr>`).join('')}
      </tbody></table></div></article>`;
}

$('pg-sec-painel').addEventListener('change', (e) => {
  if (e.target.id === 'pn-de' || e.target.id === 'pn-ate') {
    E.painelDe = $('pn-de').value;
    E.painelAte = $('pn-ate').value;
    carregarPainel();
  }
});
$('pg-sec-painel').addEventListener('click', (e) => {
  if (e.target.dataset.pn === 'limpar') { E.painelDe = ''; E.painelAte = ''; carregarPainel(); }
  const ped = e.target.closest('[data-abrir-pedido]');
  if (ped) window.PCP.programacao?.abrirPedido?.(Number(ped.dataset.abrirPedido));
});

// ---------------------------------------------------------------- compras de terceiros

E.filtroCompras = { tipo: '', status: '', fornecedor: '', q: '' };

async function carregarCompras() {
  const q = new URLSearchParams(Object.entries(E.filtroCompras).filter(([, v]) => v));
  try {
    E.compras = await api(`/api/programacao/compras?${q}`);
    renderCompras();
  } catch (erro) {
    mostrarToast(`Não foi possível carregar as compras: ${erro.message}`);
  }
}

const opcoesHtml = (lista, atual, vazio) =>
  `${vazio !== undefined ? `<option value="">${esc(vazio)}</option>` : ''}${lista.map((o) => `<option value="${esc(o.valor ?? o.id)}"${String(o.valor ?? o.id) === String(atual ?? '') ? ' selected' : ''}>${esc(o.rotulo ?? o.nome)}</option>`).join('')}`;

function renderCompras() {
  const c = E.compras;
  const f = E.filtroCompras;
  const edita = completo();
  $('pg-sec-compras').innerHTML = `
    <div class="pg-barra-topo">
      <select id="cp-tipo" aria-label="Tipo">${opcoesHtml(c.opcoes.tipos, f.tipo, 'Todos os tipos')}</select>
      <select id="cp-status" aria-label="Status">${opcoesHtml(c.opcoes.status, f.status, 'Todos os status')}</select>
      <select id="cp-forn" aria-label="Fornecedor">${opcoesHtml(c.fornecedores, f.fornecedor, 'Todos os fornecedores')}</select>
      <input id="cp-q" type="search" placeholder="Buscar pedido, cliente, material, cotação…" value="${esc(f.q)}" style="min-width:220px">
      ${edita ? '<button type="button" class="pg-btn" data-cp="nova" style="margin-left:auto">+ Nova compra</button>' : ''}
    </div>
    <article class="panel pg-quadro"><div class="panelhead"><h2>Compras</h2><small>${c.totais.compras} compras · ${num(c.totais.metros)} m · ${brl(c.totais.valor)} (sem canceladas)</small></div>
      <div class="pg-wrap" style="max-height:none"><table class="pg-tabela"><thead><tr><th>Tipo</th><th>Pedido</th><th>Cliente</th><th>Prazo</th><th>Fornecedor</th><th>Medidas</th><th>Metros</th><th>Material / TR</th><th>Cotação</th><th>Valor</th><th>Status</th><th>Comprado</th><th></th></tr></thead><tbody>
      ${c.compras
        .map(
          (x) => `<tr class="${x.status === 'CANCELADO' ? 'cancelado' : ''}"><td>${esc(x.tipoRotulo)}</td>
          <td>${x.pedido ? `<button type="button" class="pg-ped" data-abrir-pedido="${x.pedido.id}">${x.pedido.numero}</button>` : '—'}</td>
          <td>${x.pedido ? `${esc(x.pedido.cliente)}<span class="pg-sub">${esc(x.pedido.cidade)}${x.pedido.telefone ? ` · ${esc(x.pedido.telefone)}` : ''}</span>` : '—'}</td>
          <td>${x.pedido ? `${esc(fmtData(x.pedido.prazoVigente) || '—')}<span class="pg-sub">${esc(x.pedido.situacaoRotulo || '')}</span>` : '—'}</td>
          <td>${edita ? `<select class="pg-in" data-cp-campo="fornecedorId" data-id="${x.id}">${opcoesHtml(c.fornecedores, x.fornecedor?.id, '—')}</select>` : esc(x.fornecedor?.nome || '—')}</td>
          <td>${esc(x.medidasTexto || '—')}</td>
          <td class="n">${num(x.totalMetros)}${x.pecas !== null ? `<span class="pg-sub">${x.pecas} peças</span>` : ''}</td>
          <td>${esc(x.material || '—')}${x.tr ? ` <span class="pg-sub">${esc(x.tr)}</span>` : ''}</td>
          <td>${esc(x.cotacao || '—')}</td>
          <td class="n">${x.valor === null ? '—' : brl(x.valor)}${x.valorManual ? '<span class="pg-sub">manual</span>' : ''}</td>
          <td>${edita ? `<select class="pg-in" data-cp-campo="status" data-id="${x.id}">${opcoesHtml(c.opcoes.status, x.status)}</select>` : esc(x.statusRotulo)}</td>
          <td>${x.compradoEm ? `${esc(fmtData(x.compradoEm))}<span class="pg-sub">${esc(x.compradoPor)}</span>` : '—'}</td>
          <td>${edita ? `<button type="button" class="pg-mini" data-cp="editar" data-id="${x.id}">Editar</button>` : ''}</td></tr>`
        )
        .join('') || '<tr><td colspan="13" class="pg-vazio"><b>Nenhuma compra</b>Cadastre a primeira em “+ Nova compra”.</td></tr>'}
      </tbody></table></div></article>

    <article class="panel pg-quadro"><div class="panelhead"><h2>Fornecedores: comprado, pago e saldo</h2><small>conta só compras Comprado/Recebido/Retirado</small></div>
      <div class="pg-wrap" style="max-height:none"><table class="pg-tabela"><thead><tr><th>Fornecedor</th><th>Fornece</th><th>Total comprado</th><th>Total pago</th><th>Saldo a pagar</th><th></th></tr></thead><tbody>
      ${c.fornecedores.map((x) => `<tr><td><b>${esc(x.nome)}</b></td><td>${esc(x.fornece || '—')}</td><td class="n">${brl(x.totalComprado)}</td><td class="n">${brl(x.totalPago)}</td><td class="n"><b>${brl(x.saldoAPagar)}</b></td>
        <td><button type="button" class="pg-mini" data-cp="pagamentos" data-id="${x.id}">Pagamentos</button></td></tr>`).join('')}
      </tbody></table></div></article>`;
}

$('pg-sec-compras').addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'cp-tipo') E.filtroCompras.tipo = el.value;
  else if (el.id === 'cp-status') E.filtroCompras.status = el.value;
  else if (el.id === 'cp-forn') E.filtroCompras.fornecedor = el.value;
  else if (el.dataset.cpCampo) {
    const corpo = { [el.dataset.cpCampo]: el.dataset.cpCampo === 'fornecedorId' ? (el.value === '' ? null : Number(el.value)) : el.value };
    await salvando(() => api(`/api/programacao/compras/${el.dataset.id}`, { method: 'PATCH', body: JSON.stringify(corpo) }));
  } else return;
  carregarCompras();
});

let timerCompras;
$('pg-sec-compras').addEventListener('input', (e) => {
  if (e.target.id !== 'cp-q') return;
  E.filtroCompras.q = e.target.value;
  clearTimeout(timerCompras);
  timerCompras = setTimeout(carregarCompras, 350);
});

$('pg-sec-compras').addEventListener('click', (e) => {
  const ped = e.target.closest('[data-abrir-pedido]');
  if (ped) return void window.PCP.programacao?.abrirPedido?.(Number(ped.dataset.abrirPedido));
  const b = e.target.closest('[data-cp]');
  if (!b) return;
  if (b.dataset.cp === 'nova') formCompra(null);
  else if (b.dataset.cp === 'editar') formCompra(E.compras.compras.find((x) => x.id === Number(b.dataset.id)));
  else if (b.dataset.cp === 'pagamentos') abrirPagamentos(Number(b.dataset.id));
});

/** "14x5,90 + 2x3" -> [{qtd:14, comprimento_m:5.9}, ...]. Texto fora do formato devolve null. */
function lerMedidasTexto(t) {
  const partes = t.split(/[+;\n]/).map((s) => s.trim()).filter(Boolean);
  const r = [];
  for (const p of partes) {
    const m = /^(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*m?$/i.exec(p);
    if (!m) return null;
    r.push({ qtd: Number(m[1]), comprimento_m: Number(m[2].replace(',', '.')) });
  }
  return r;
}

function formCompra(x) {
  const c = E.compras;
  $('pg-dlg-titulo').textContent = x ? `Editar compra #${x.id}` : 'Nova compra de terceiros';
  const medidasTxt = x ? x.medidas.map((m) => `${m.qtd}x${String(m.comprimento_m).replace('.', ',')}`).join(' + ') : '';
  $('pg-dlg-corpo').innerHTML = `<div class="pg-grid">
    <div class="pg-campo"><label>Tipo</label><select id="f-tipo">${opcoesHtml(c.opcoes.tipos, x?.tipo)}</select></div>
    <div class="pg-campo"><label>Nº do pedido (Programação)</label><input id="f-pedido" type="number" min="1" value="${x?.pedido?.numero ?? ''}" placeholder="opcional"></div>
    <div class="pg-campo"><label>Fornecedor</label><select id="f-forn">${opcoesHtml(c.fornecedores, x?.fornecedor?.id, '—')}</select></div>
    <div class="pg-campo"><label>Status</label><select id="f-status">${opcoesHtml(c.opcoes.status, x?.status ?? 'A_COTAR')}</select></div>
    <div class="pg-campo"><label>Medidas (ex.: 14x5,90 + 2x3)</label><input id="f-medidas" value="${esc(medidasTxt)}"></div>
    <div class="pg-campo"><label>Ou total de metros</label><input id="f-total" type="number" min="0" step="0.01" value="${x && !x.medidas.length ? x.totalMetros : ''}"></div>
    <div class="pg-campo"><label>Tipo/cor do material</label><input id="f-material" value="${esc(x?.material ?? '')}" placeholder="ex.: amadeirado escuro"></div>
    <div class="pg-campo"><label>TR</label><select id="f-tr">${opcoesHtml([{ valor: 'TR25', rotulo: 'TR25' }, { valor: 'TR40', rotulo: 'TR40' }], x?.tr, '—')}</select></div>
    <div class="pg-campo"><label>Comprimento da peça (m) — forro PVC</label><input id="f-peca" type="number" min="0" step="0.01" value="${x?.comprimentoPecaM ?? ''}"></div>
    <div class="pg-campo"><label>Nº da cotação/pedido no fornecedor</label><input id="f-cotacao" value="${esc(x?.cotacao ?? '')}"></div>
    <div class="pg-campo"><label>Valor (R$) — vazio usa metros × preço${x ? '' : ` (forro Anfer: ${brl(c.opcoes.precoForroAnfer)}/m)`}</label><input id="f-valor" type="number" min="0" step="0.01" value="${x?.valorManual ? x.valor : ''}"></div>
  </div>
  <div class="pg-campo" style="margin-top:10px"><label>Observação</label><textarea id="f-obs">${esc(x?.observacao ?? '')}</textarea></div>
  <div style="margin-top:10px;display:flex;gap:8px;align-items:center"><button type="button" class="pg-btn" id="f-salvar">Salvar</button><span class="pg-sub" id="f-erro" style="color:#b23a47"></span></div>`;
  $('pg-dlg-extra').showModal();

  $('f-salvar').onclick = async () => {
    const medidas = lerMedidasTexto($('f-medidas').value);
    if (medidas === null) return void ($('f-erro').textContent = 'Medidas fora do formato: use 14x5,90 + 2x3.');
    const corpo = {
      tipo: $('f-tipo').value,
      fornecedorId: $('f-forn').value === '' ? null : Number($('f-forn').value),
      status: $('f-status').value,
      medidas,
      material: $('f-material').value,
      tr: $('f-tr').value || null,
      comprimentoPecaM: $('f-peca').value === '' ? null : Number($('f-peca').value),
      cotacao: $('f-cotacao').value,
      valor: $('f-valor').value === '' ? null : Number($('f-valor').value),
      observacao: $('f-obs').value,
    };
    if (!medidas.length && $('f-total').value !== '') corpo.totalMetros = Number($('f-total').value);
    if ($('f-pedido').value !== '') corpo.numeroPedido = Number($('f-pedido').value);
    else if (x) corpo.pedidoId = null;
    try {
      await window.PCP.programacao?.garantirUsuario?.();
      await api(x ? `/api/programacao/compras/${x.id}` : '/api/programacao/compras', { method: x ? 'PATCH' : 'POST', body: JSON.stringify(corpo) });
      $('pg-dlg-extra').close();
      carregarCompras();
    } catch (erro) {
      $('f-erro').textContent = erro.message;
    }
  };
}

async function abrirPagamentos(fornecedorId) {
  const forn = E.compras.fornecedores.find((f) => f.id === fornecedorId);
  const desenhar = (lista) => {
    $('pg-dlg-titulo').textContent = `Pagamentos a ${forn.nome}`;
    $('pg-dlg-corpo').innerHTML = `<p class="pg-sub">Comprado ${brl(forn.totalComprado)} · pago ${brl(forn.totalPago)} · saldo ${brl(forn.saldoAPagar)}</p>
      ${completo() ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0"><input type="date" id="pg-pag-data"><input type="number" min="0" step="0.01" id="pg-pag-valor" placeholder="Valor (R$)"><input id="pg-pag-obs" placeholder="Observação"><button type="button" class="pg-btn" data-pag="add">Lançar pagamento</button></div>` : ''}
      <table class="pg-consumos"><tr><th>Data</th><th>Valor</th><th>Observação</th><th></th></tr>${lista.map((p) => `<tr><td>${esc(fmtData(p.data))}</td><td>${brl(p.valor)}</td><td>${esc(p.observacao)}</td><td>${completo() ? `<button type="button" class="pg-mini" data-pag="del" data-id="${p.id}">remover</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4">Nenhum pagamento lançado.</td></tr>'}</table>`;
  };
  desenhar(await api(`/api/programacao/fornecedores/${fornecedorId}/pagamentos`));
  $('pg-dlg-extra').showModal();
  $('pg-dlg-corpo').onclick = async (e) => {
    const b = e.target.closest('[data-pag]');
    if (!b) return;
    const r = await salvando(async () => {
      if (b.dataset.pag === 'add') {
        return api(`/api/programacao/fornecedores/${fornecedorId}/pagamentos`, {
          method: 'POST',
          body: JSON.stringify({ data: $('pg-pag-data').value || undefined, valor: Number($('pg-pag-valor').value), observacao: $('pg-pag-obs').value }),
        });
      }
      await api(`/api/programacao/pagamentos/${b.dataset.id}`, { method: 'DELETE' });
      return api(`/api/programacao/fornecedores/${fornecedorId}/pagamentos`);
    });
    if (r) {
      desenhar(r);
      carregarCompras();
    }
  };
}

// ---------------------------------------------------------------- parafusos

async function carregarParafusos() {
  try {
    const p = await api('/api/programacao/parafusos');
    const edita = completo();
    $('pg-sec-parafusos').innerHTML = `<article class="panel pg-quadro"><div class="panelhead"><h2>Necessidade de parafusos</h2><small>consumo médio dos últimos 6 meses fechados (${esc(p.mesesBase[0])} a ${esc(p.mesesBase[5])}) · comprar = demanda + 2 × consumo médio − estoque</small></div>
      <p class="pg-sub" style="padding:0 16px">A quantidade de cada pedido é lançada na gaveta do pedido (Consumos). O estoque é a contagem feita pela equipe, com a data.</p>
      <div class="pg-wrap" style="max-height:none"><table class="pg-tabela"><thead><tr><th>Parafuso</th><th>Consumo médio/mês</th><th>Demanda (pedidos em aberto)</th><th>Estoque atual</th><th>Contagem em</th><th>Comprar</th></tr></thead><tbody>
      ${p.itens.map((x) => `<tr><td><b>${esc(x.nome)}</b></td><td class="n">${num(x.consumoMedioMes)}</td><td class="n">${num(x.demanda)}</td>
        <td class="n">${edita ? `<input class="pg-in" type="number" min="0" step="1" style="width:110px;text-align:right" value="${x.estoque}" data-estoque="${esc(x.codigo)}">` : num(x.estoque)}</td>
        <td>${esc(fmtData(x.contadoEm) || '—')}</td><td class="n"><b style="color:${x.comprar > 0 ? '#b23a47' : '#25785a'}">${num(x.comprar)}</b></td></tr>`).join('')}
      </tbody></table></div></article>`;
  } catch (erro) {
    mostrarToast(`Não foi possível carregar os parafusos: ${erro.message}`);
  }
}

$('pg-sec-parafusos').addEventListener('change', async (e) => {
  if (!e.target.dataset.estoque) return;
  const r = await salvando(() => api(`/api/programacao/parafusos/${e.target.dataset.estoque}/estoque`, { method: 'PUT', body: JSON.stringify({ quantidade: Number(e.target.value) }) }));
  if (r) carregarParafusos();
});

// ---------------------------------------------------------------- calculadora de bobina

function renderCalculadora() {
  if ($('pg-sec-calculadora').childElementCount) return;
  $('pg-sec-calculadora').innerHTML = `<article class="panel pg-quadro"><div class="panelhead"><h2>Calculadora de bobina</h2></div>
    <div class="pg-sec"><p class="pg-sub">Preencha espessura, largura e densidade, e informe o <b>peso</b> (para achar o comprimento) <b>ou</b> o <b>comprimento</b> (para achar o peso).</p>
    <div class="pg-grid tres" style="max-width:720px">
      <div class="pg-campo"><label>Espessura da chapa (mm)</label><input id="cb-esp" type="number" step="0.01" min="0" value="0.5"></div>
      <div class="pg-campo"><label>Largura da bobina (m)</label><input id="cb-larg" type="number" step="0.01" min="0" value="1.2"></div>
      <div class="pg-campo"><label>Densidade (kg/m³)</label><input id="cb-dens" type="number" step="1" min="0" value="7850"></div>
      <div class="pg-campo"><label>Peso (kg)</label><input id="cb-peso" type="number" step="0.01" min="0"></div>
      <div class="pg-campo"><label>Comprimento (m)</label><input id="cb-comp" type="number" step="0.01" min="0"></div>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px;align-items:center"><button type="button" class="pg-btn" id="cb-calc">Calcular</button><span id="cb-res" style="font-size:14px"></span></div></div></article>`;

  $('cb-calc').addEventListener('click', async () => {
    const q = new URLSearchParams({ espessura: $('cb-esp').value, largura: $('cb-larg').value, densidade: $('cb-dens').value });
    const peso = $('cb-peso').value;
    const comp = $('cb-comp').value;
    if (peso !== '') q.set('peso', peso);
    else if (comp !== '') q.set('comprimento', comp);
    try {
      const r = await api(`/api/programacao/calculadora?${q}`);
      $('cb-res').innerHTML = `<b>${num(r.pesoKg)} kg</b> = <b>${num(r.comprimentoM)} m</b> <span class="pg-sub">(${num(r.kgPorMetro)} kg por metro de chapa)</span>`;
    } catch (erro) {
      $('cb-res').textContent = erro.message;
    }
  });
}

// ---------------------------------------------------------------- ponte

// O app.js mostra/esconde a view inteira; as abas lembram em qual estavam.
const antes = window.PCP.programacao;
const original = antes?.ativar;
if (antes) {
  antes.ativar = () => {
    if (E.aba === 'pedidos') original?.();
    else RENDER[E.aba]();
  };
  const orig2 = antes.recarregar;
  antes.recarregar = () => {
    orig2?.();
    if (!$('view-programacao').hidden && E.aba !== 'pedidos' && E.aba !== 'calculadora') RENDER[E.aba]();
  };
}
