// Botão "Pedidos Problemáticos" da Tabela de pedidos: três tabelas de registro do PCP.
//  1. Pedidos Urgentes (pedido + data de entrega combinada)
//  2. Pedidos de Devolução (pedido + forma de pagamento + valor)  <- preenche sozinha a partir do pedido de venda
//  3. Clientes / Defeitos (pedido + causa + motorista)
// O número do pedido é um campo de BUSCA (por número ou nome do cliente). Só imprime o que o servidor devolve.

const { api, esc, fmtData, $, mostrarToast } = window.PCP;

const brl = (n) => (n === null || n === undefined ? '' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

const TABELAS = {
  urgentes: {
    titulo: 'Pedidos Urgentes',
    vazio: 'Nenhum pedido urgente cadastrado.',
    campos: [{ k: 'dataEntregaCombinada', rotulo: 'Data de entrega combinada', tipo: 'date', obrigatorio: true }],
  },
  devolucoes: {
    titulo: 'Pedidos de Devolução',
    vazio: 'Nenhuma devolução cadastrada.',
    campos: [
      { k: 'formaPagamento', rotulo: 'Forma de pagamento', tipo: 'text', max: 80 },
      { k: 'valor', rotulo: 'Valor', tipo: 'number' },
    ],
  },
  defeitos: {
    titulo: 'Clientes / Defeitos',
    vazio: 'Nenhum registro de defeito cadastrado.',
    campos: [
      { k: 'causa', rotulo: 'Causa', tipo: 'text', max: 500, obrigatorio: true },
      { k: 'motorista', rotulo: 'Motorista', tipo: 'text', max: 100 },
    ],
  },
};

const P = { aba: 'urgentes', dados: { urgentes: [], devolucoes: [], defeitos: [] }, sel: { urgentes: null, devolucoes: null, defeitos: null }, timer: null, carregou: false };

// ---------------------------------------------------------------- estrutura do painel

function montar() {
  $('pb-raiz').innerHTML = `
    <nav class="pg-abas pb-abas" id="pb-abas">${Object.entries(TABELAS)
      .map(([k, t]) => `<button type="button" data-aba="${k}" aria-selected="${k === P.aba}">${esc(t.titulo)} <span class="pb-n" data-n="${k}"></span></button>`)
      .join('')}</nav>
    <div id="pb-painel"></div>`;
  renderPainel();
}

function renderPainel() {
  const t = TABELAS[P.aba];
  const lista = P.dados[P.aba];
  const sel = P.sel[P.aba];

  const campoForm = (c) =>
    `<div class="pg-campo"><label>${esc(c.rotulo)}${c.obrigatorio ? ' *' : ''}</label><input id="pb-f-${c.k}" type="${c.tipo}" ${c.tipo === 'number' ? 'min="0" step="0.01" placeholder="0,00"' : ''} ${c.max ? `maxlength="${c.max}"` : ''} ${c.tipo === 'date' ? 'min="2000-01-01" max="2100-12-31"' : ''}></div>`;

  const linhas = lista
    .map(
      (r) => `<tr data-id="${r.id}">
        <td><b>${r.numeroPedido}</b>${r.cliente ? `<span class="pg-sub">${esc(r.cliente)}</span>` : ''}</td>
        ${t.campos.map((c) => `<td><input class="pg-in" type="${c.tipo}" data-campo="${c.k}" value="${esc(r[c.k] ?? '')}" ${c.tipo === 'number' ? 'min="0" step="0.01"' : ''} ${c.max ? `maxlength="${c.max}"` : ''} ${c.tipo === 'date' ? 'min="2000-01-01" max="2100-12-31"' : ''} aria-label="${esc(c.rotulo)} do pedido ${r.numeroPedido}"></td>`).join('')}
        <td class="pb-acoes"><button type="button" class="pg-mini" data-remover="${r.id}" title="Excluir este registro" aria-label="Excluir registro do pedido ${r.numeroPedido}">Excluir</button></td></tr>`
    )
    .join('');

  $('pb-painel').innerHTML = `
    <div class="pb-form">
      <div class="pg-campo pb-busca-campo"><label>Número do pedido *</label>
        <input id="pb-busca" type="search" autocomplete="off" placeholder="Digite o número do pedido ou o nome do cliente…" ${sel ? 'hidden' : ''}>
        <ul class="pb-res" id="pb-res" hidden></ul>
        <div class="pb-sel" id="pb-sel" ${sel ? '' : 'hidden'}>${sel ? selHtml(sel) : ''}</div>
      </div>
      ${t.campos.map(campoForm).join('')}
      <div class="pg-campo"><label>&nbsp;</label><button type="button" class="pg-btn" id="pb-add">Adicionar</button></div>
    </div>
    <div class="pg-sub" id="pb-dica" style="padding:4px 2px 0">${dicaDaAba()}</div>
    <div class="pb-erro" id="pb-erro" role="alert"></div>
    <div class="pg-wrap" style="max-height:340px"><table class="pg-tabela pb-tabela">
      <thead><tr><th>Número do pedido</th>${t.campos.map((c) => `<th>${esc(c.rotulo)}</th>`).join('')}<th></th></tr></thead>
      <tbody>${linhas || `<tr><td colspan="${t.campos.length + 2}" class="pg-vazio">${esc(t.vazio)}</td></tr>`}</tbody></table></div>`;

  document.querySelectorAll('#pb-abas [data-aba]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.aba === P.aba)));
  for (const k of Object.keys(TABELAS)) {
    const el = document.querySelector(`[data-n="${k}"]`);
    if (el) el.textContent = P.dados[k].length ? String(P.dados[k].length) : '';
  }
}

const selHtml = (s) =>
  `<span class="pb-chip"><b>Pedido ${s.numero}</b>${s.cliente ? ` · ${esc(s.cliente)}` : ''}<button type="button" data-limpar-sel aria-label="Trocar o pedido">×</button></span>`;

function dicaDaAba() {
  const s = P.sel[P.aba];
  if (!s) return P.aba === 'devolucoes' ? 'Escolha o pedido: forma de pagamento e valor são preenchidos sozinhos com os dados do pedido de venda (você pode ajustar).' : 'Digite o número ou o nome do cliente e escolha o pedido na lista.';
  if (s.carregando) return 'Buscando os dados do pedido…';
  if (P.aba === 'urgentes' && s.prazoEntrega) return `Prazo de entrega atual do pedido: ${esc(fmtData(s.prazoEntrega))}.`;
  if (P.aba === 'devolucoes' && s.preenchido) return 'Forma de pagamento e valor preenchidos com os dados do pedido de venda da Nomus.';
  return '';
}

// ---------------------------------------------------------------- dados

async function carregar() {
  try {
    P.dados = await api('/api/problematicos');
    P.carregou = true;
    renderPainel();
  } catch (erro) {
    mostrarToast(`Não foi possível carregar os registros: ${erro.message}`);
  }
}

function erro(msg) {
  const el = $('pb-erro');
  if (el) el.textContent = msg || '';
}

// ---------------------------------------------------------------- busca do pedido

async function pesquisar(texto) {
  const ul = $('pb-res');
  if (!texto.trim()) { ul.hidden = true; return; }
  try {
    const lista = await api(`/api/problematicos/pedidos?q=${encodeURIComponent(texto)}`);
    ul.innerHTML = lista.length
      ? lista.map((p) => `<li><button type="button" data-escolher="${p.numero}" data-cliente="${esc(p.cliente)}"><b>${p.numero}</b> ${esc(p.cliente || 'sem nome')}${p.origem === 'nomus' ? ' <em>(só na Nomus)</em>' : ''}</button></li>`).join('')
      : '<li class="pb-nada">Nenhum pedido encontrado.</li>';
    ul.hidden = false;
  } catch (e) {
    ul.innerHTML = `<li class="pb-nada">${esc(e.message)}</li>`;
    ul.hidden = false;
  }
}

async function escolher(numero, cliente) {
  const aba = P.aba;
  P.sel[aba] = { numero, cliente, carregando: true };
  renderPainel();
  try {
    const d = await api(`/api/problematicos/pedidos/${numero}`);
    if (!P.sel[aba] || P.sel[aba].numero !== numero) return;
    P.sel[aba] = { numero, cliente: d.cliente || cliente, prazoEntrega: d.prazoEntrega, carregando: false };
    renderPainel();
    // Devolução: forma de pagamento e valor saem do pedido de venda.
    if (aba === 'devolucoes' && P.aba === aba) {
      if ($('pb-f-formaPagamento')) $('pb-f-formaPagamento').value = d.formaPagamento || '';
      if ($('pb-f-valor')) $('pb-f-valor').value = d.valor ?? '';
      P.sel[aba].preenchido = !!(d.formaPagamento || d.valor !== null);
      $('pb-dica').innerHTML = d.formaPagamento || d.valor !== null ? dicaDaAba() : 'A Nomus não trouxe forma de pagamento/valor deste pedido: preencha à mão.';
    }
  } catch (e) {
    P.sel[aba] = null;
    renderPainel();
    erro(e.message);
  }
}

// ---------------------------------------------------------------- ações

async function adicionar() {
  erro('');
  const t = TABELAS[P.aba];
  const sel = P.sel[P.aba];
  if (!sel || sel.carregando) return erro('Escolha o pedido na busca primeiro.');
  const corpo = { numeroPedido: sel.numero, cliente: sel.cliente };
  for (const c of t.campos) {
    const v = $(`pb-f-${c.k}`).value.trim();
    if (c.tipo === 'number') { if (v !== '') corpo[c.k] = Number(v); }
    else if (v !== '' || c.obrigatorio) corpo[c.k] = v;
  }
  try {
    await window.PCP.programacao?.garantirUsuario?.();
    const r = await api(`/api/problematicos/${P.aba}`, { method: 'POST', body: JSON.stringify(corpo) });
    P.dados = { urgentes: r.urgentes, devolucoes: r.devolucoes, defeitos: r.defeitos };
    P.sel[P.aba] = null;
    renderPainel();
    mostrarToast(`Pedido ${sel.numero} cadastrado em ${t.titulo}.`);
  } catch (e) {
    erro(e.message);
  }
}

async function salvarLinha(el) {
  const id = el.closest('tr').dataset.id;
  const c = TABELAS[P.aba].campos.find((x) => x.k === el.dataset.campo);
  let v = el.value.trim();
  if (c.tipo === 'date' && v && !/^(20\d\d)-\d\d-\d\d$/.test(v)) return; // ano ainda sendo digitado
  if (c.tipo === 'number') v = v === '' ? null : Number(v);
  if (c.tipo === 'date' && v === '') { el.value = P.dados[P.aba].find((r) => String(r.id) === id)?.[c.k] ?? ''; return; }
  el.classList.add('salvando');
  try {
    await window.PCP.programacao?.garantirUsuario?.();
    const r = await api(`/api/problematicos/${P.aba}/${id}`, { method: 'PATCH', body: JSON.stringify({ [c.k]: v }) });
    P.dados = r;
    el.classList.remove('erro');
  } catch (e) {
    el.classList.add('erro');
    mostrarToast(e.message);
  } finally {
    el.classList.remove('salvando');
  }
}

async function remover(id) {
  const r = P.dados[P.aba].find((x) => String(x.id) === id);
  if (!r || !confirm(`Excluir o registro do pedido ${r.numeroPedido}?`)) return;
  try {
    P.dados = await api(`/api/problematicos/${P.aba}/${id}`, { method: 'DELETE' });
    renderPainel();
  } catch (e) {
    mostrarToast(e.message);
  }
}

// ---------------------------------------------------------------- eventos

const dlg = $('view-problematicos');

dlg.addEventListener('click', (e) => {
  const aba = e.target.closest('#pb-abas [data-aba]');
  if (aba) { P.aba = aba.dataset.aba; return renderPainel(); }
  const esc_ = e.target.closest('[data-escolher]');
  if (esc_) return void escolher(Number(esc_.dataset.escolher), esc_.dataset.cliente);
  if (e.target.closest('[data-limpar-sel]')) { P.sel[P.aba] = null; renderPainel(); return $('pb-busca')?.focus(); }
  if (e.target.id === 'pb-add') return void adicionar();
  const rem = e.target.closest('[data-remover]');
  if (rem) return void remover(rem.dataset.remover);
  if (!e.target.closest('.pb-busca-campo') && $('pb-res')) $('pb-res').hidden = true;
});

dlg.addEventListener('input', (e) => {
  if (e.target.id !== 'pb-busca') return;
  clearTimeout(P.timer);
  P.timer = setTimeout(() => pesquisar(e.target.value), 250);
});

dlg.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'pb-busca') {
    e.preventDefault();
    const primeiro = document.querySelector('#pb-res [data-escolher]');
    if (primeiro) escolher(Number(primeiro.dataset.escolher), primeiro.dataset.cliente);
  } else if (e.key === 'Enter' && e.target.matches('.pb-form input')) {
    e.preventDefault();
    adicionar();
  }
});

dlg.addEventListener('change', (e) => {
  if (e.target.matches('.pb-tabela input[data-campo]')) salvarLinha(e.target);
});

$('pb-voltar').addEventListener('click', () => window.PCP.mostrarView('tabela'));

window.PCP.problematicos = {
  async abrir() {
    if (!$('pb-raiz').childElementCount) montar();
    window.PCP.mostrarView('problematicos');
    await carregar();
  },
};
