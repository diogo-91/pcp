// Tela "Pedidos problemáticos" (abre pelo botão da Tabela de pedidos): três tabelas de registro do PCP.
//  1. Pedidos Urgentes (pedido + data de entrega combinada)
//  2. Pedidos de Devolução (pedido + forma de pagamento + valor)  <- preenche sozinha a partir do pedido de venda
//  3. Clientes / Defeitos (pedido + causa + motorista + ação + prazo da ação)
// O número do pedido é um campo de BUSCA. Os indicadores (pendentes, variação, minigráfico) vêm calculados do servidor.

const { api, esc, fmtData, $, mostrarToast } = window.PCP;

const brl = (n) => (n === null || n === undefined ? '' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

// ---------------------------------------------------------------- ícones (traço, herdam a cor do texto)
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICONE = {
  alerta: svg('<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5M12 18h.01"/>'),
  devolucao: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  pessoas: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>'),
  plus: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  lista: svg('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
  filtro: svg('<path d="M3 5h18l-7 8v6l-4-2v-4L3 5Z"/>'),
  busca: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  calendario: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/>'),
  camadas: svg('<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>'),
  atualizar: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
  mais: svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  etapas: svg('<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>'),
  clipe: svg('<path d="m21 11-9 9a5.5 5.5 0 0 1-8-8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8-8"/>'),
  lixo: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
};

const ILUSTRACAO_VAZIA = `<svg class="pb-vazio-img" viewBox="0 0 160 130" aria-hidden="true">
  <ellipse cx="80" cy="118" rx="52" ry="7" fill="#fff3a8"/>
  <rect x="38" y="16" width="70" height="90" rx="9" fill="#eceff3" stroke="#c9d0d9" stroke-width="2"/>
  <rect x="58" y="9" width="30" height="14" rx="5" fill="#b9c1cc"/>
  <g stroke="#b9c1cc" stroke-width="3" stroke-linecap="round" fill="none"><path d="M50 42h8M64 42h30M50 58h8M64 58h30M50 74h8M64 74h24"/></g>
  <path d="M110 70 148 112H72L110 70Z" fill="#ffd633" stroke="#f0b800" stroke-width="2" stroke-linejoin="round" transform="translate(-4 -2)"/>
  <path d="M106 86v12M106 106h.01" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
</svg>`;

// Todo registro nasce "Não realizada"; ao marcar "Realizada" ele some da lista (continua gravado; o filtro Status traz de volta).
const STATUS = { k: 'status', rotulo: 'Status', tipo: 'status' };
const NOMES_STATUS = { NAO_REALIZADA: 'Não realizada', REALIZADA: 'Realizada' };
const statusSelect = (atrib, atual, extra = '') =>
  `<select ${atrib} class="pb-st pb-st-${atual}" ${extra}>${Object.entries(NOMES_STATUS).map(([v, n]) => `<option value="${v}"${v === atual ? ' selected' : ''}>${n}</option>`).join('')}</select>`;

const TABELAS = {
  urgentes: {
    aba: 'Pedidos Urgentes', icone: 'alerta', cor: 'ouro',
    cardTitulo: 'Cadastrar novo pedido urgente', cardSub: 'Inclua um pedido com prioridade de tratamento.',
    listaTitulo: 'Pedidos urgentes', listaSub: 'Fila de pedidos com prioridade de tratamento.',
    vazio: 'Nenhum pedido urgente cadastrado.', vazioSub: 'Não há pedidos urgentes para exibir no momento.',
    campos: [{ k: 'dataEntregaCombinada', rotulo: 'Data de entrega combinada', tipo: 'date', obrigatorio: true }, STATUS],
    data: { campo: 'dataEntregaCombinada', rotulo: 'Data de entrega', tipo: 'futura' },
  },
  devolucoes: {
    aba: 'Pedidos de Devolução', icone: 'devolucao', cor: 'verde',
    cardTitulo: 'Cadastrar nova devolução', cardSub: 'Forma de pagamento e valor vêm do pedido de venda da Nomus.',
    listaTitulo: 'Pedidos de devolução', listaSub: 'Pedidos devolvidos e o valor a devolver.',
    vazio: 'Nenhuma devolução cadastrada.', vazioSub: 'Não há devoluções para exibir no momento.',
    campos: [
      { k: 'formaPagamento', rotulo: 'Forma de pagamento', tipo: 'text', max: 300 },
      { k: 'valor', rotulo: 'Valor da devolução', tipo: 'number' },
      STATUS,
    ],
    data: { campo: 'criadoEm', rotulo: 'Data do cadastro', tipo: 'cadastro' },
  },
  defeitos: {
    aba: 'Clientes / Defeitos', icone: 'pessoas', cor: 'ouro',
    cardTitulo: 'Cadastrar cliente / defeito', cardSub: 'Registre o defeito, a causa e a ação para resolver.',
    listaTitulo: 'Clientes / defeitos', listaSub: 'Defeitos reclamados e o que será feito.',
    vazio: 'Nenhum registro de defeito cadastrado.', vazioSub: 'Não há defeitos para exibir no momento.',
    campos: [
      { k: 'causa', rotulo: 'Causa', tipo: 'text', max: 500, obrigatorio: true },
      { k: 'motorista', rotulo: 'Motorista', tipo: 'text', max: 100 },
      { k: 'acao', rotulo: 'Ação', tipo: 'text', max: 500 },
      { k: 'prazoAcao', rotulo: 'Prazo da ação', tipo: 'date' },
      STATUS,
    ],
    data: { campo: 'prazoAcao', rotulo: 'Prazo da ação', tipo: 'futura' },
  },
};

const OPCOES_DATA = {
  futura: [['', 'Todas as datas'], ['vencidas', 'Vencidas'], ['hoje', 'Hoje'], ['semana', 'Próximos 7 dias'], ['sem', 'Sem data']],
  cadastro: [['', 'Todas as datas'], ['hoje', 'Cadastradas hoje'], ['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias']],
};

const filtroInicial = () => ({ q: '', data: '', status: 'pendentes' });

const P = {
  aba: 'urgentes',
  dados: { urgentes: [], devolucoes: [], defeitos: [] },
  resumo: null,
  hoje: '',
  sel: { urgentes: null, devolucoes: null, defeitos: null },
  f: { urgentes: filtroInicial(), devolucoes: filtroInicial(), defeitos: filtroInicial() },
  atualizadoEm: null,
  montada: null,
  timer: null,
};

// ---------------------------------------------------------------- indicadores, abas e cabeçalho

function sparkline(serie, cor) {
  const max = Math.max(1, ...serie);
  const w = 130, h = 46, pad = 5;
  const pts = serie.map((v, i) => [pad + (i * (w - 2 * pad)) / (serie.length - 1), h - pad - (v / max) * (h - 2 * pad)]);
  const linha = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const [ux, uy] = pts[pts.length - 1];
  return `<svg class="pb-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><defs><linearGradient id="g-${cor}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--c-${cor})" stop-opacity=".28"/><stop offset="1" style="stop-color:var(--c-${cor})" stop-opacity="0"/></linearGradient></defs>
    <path d="${linha} L${ux.toFixed(1)} ${h} L${pts[0][0].toFixed(1)} ${h} Z" fill="url(#g-${cor})"/><path d="${linha}" fill="none" stroke="var(--c-${cor})" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${ux.toFixed(1)}" cy="${uy.toFixed(1)}" r="3.2" fill="var(--c-${cor})"/></svg>`;
}

function tendencia(r) {
  if (r.anteriores7 === 0 && r.ultimos7 === 0) return { cls: 'igual', txt: 'sem novos' };
  if (r.anteriores7 === 0) return { cls: 'sobe', txt: `+${r.ultimos7} novos` };
  const pct = Math.round(((r.ultimos7 - r.anteriores7) / r.anteriores7) * 100);
  if (pct === 0) return { cls: 'igual', txt: '= igual' };
  return pct > 0 ? { cls: 'sobe', txt: `↑ +${pct}%` } : { cls: 'desce', txt: `↓ −${Math.abs(pct)}%` };
}

function renderKpis() {
  if (!P.resumo) return;
  $('pb-kpis').innerHTML = Object.entries(TABELAS)
    .map(([k, t]) => {
      const r = P.resumo[k];
      const tr = tendencia(r);
      return `<button type="button" class="pb-kpi${k === P.aba ? ' ativo' : ''}" data-aba="${k}" title="vs. últimos 7 dias" aria-label="${esc(t.aba)}: ${r.pendentes} pendentes">
        <span class="pb-ico ${t.cor}">${ICONE[t.icone]}</span>
        <div class="pb-kpi-meio"><b>${esc(t.aba.replace('Pedidos ', '').replace('de ', ''))}</b>
          <div class="pb-kpi-num"><strong>${r.pendentes}</strong><span class="pb-trend ${tr.cls}" title="Novos cadastros: últimos 7 dias contra os 7 anteriores">${esc(tr.txt)}</span></div></div>
        ${sparkline(r.serie, t.cor === 'verde' ? 'verde' : 'ouro')}</button>`;
    })
    .join('');
}

function renderAbas() {
  $('pb-abas').innerHTML = Object.entries(TABELAS)
    .map(([k, t]) => {
      const n = P.resumo ? P.resumo[k].pendentes : 0;
      return `<button type="button" data-aba="${k}" aria-selected="${k === P.aba}">${ICONE[t.icone]}<span>${esc(t.aba)}</span><i class="pb-n">${n}</i></button>`;
    })
    .join('');
}

function renderSync() {
  const h = P.atualizadoEm;
  $('pb-sync-txt').textContent = h ? `Registros do PCP · atualizados às ${h.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}` : 'Carregando…';
}

// ---------------------------------------------------------------- cartões da aba (montados uma vez por aba)

function montarAba() {
  const t = TABELAS[P.aba];
  P.montada = P.aba;
  const f = P.f[P.aba];

  // A tela mostra só a tabela; o cadastro abre num modal (botão "Adicionar").
  $('pb-grid').innerHTML = `
    <article class="pb-card pb-listagem">
      <div class="pb-card-topo">
        <span class="pb-ico ${t.cor}">${ICONE.lista}</span><div><h3>${esc(t.listaTitulo)}</h3><p>${esc(t.listaSub)}</p></div>
        <div class="pb-topo-acoes">
          <button type="button" class="pb-botao" data-atualizar>${ICONE.atualizar} Atualizar</button>
          <details class="pb-menu"><summary class="pb-botao pb-botao-icone" aria-label="Mais opções">${ICONE.mais}</summary>
            <div class="pb-menu-caixa"><button type="button" data-exportar>Exportar CSV da lista</button></div></details>
          <button type="button" class="pb-novo" data-novo><b>+</b> Adicionar</button>
        </div>
      </div>
      <div class="pb-filtros">
        <span class="pb-filtros-rotulo">${ICONE.filtro} Filtros rápidos</span>
        <div class="pb-entrada-icone pb-filtro-busca">${ICONE.busca}<input id="pb-fq" type="search" placeholder="Pedido ou cliente" value="${esc(f.q)}" aria-label="Filtrar por pedido ou cliente"></div>
        <label class="pb-select-icone">${ICONE.calendario}<select id="pb-fdata" aria-label="Filtrar por ${esc(t.data.rotulo)}">${OPCOES_DATA[t.data.tipo].map(([v, n]) => `<option value="${v}"${v === f.data ? ' selected' : ''}>${v === '' ? esc(t.data.rotulo) : esc(n)}</option>`).join('')}</select></label>
        <label class="pb-select-icone">${ICONE.camadas}<select id="pb-fstatus" aria-label="Filtrar por status">
          <option value="pendentes"${f.status === 'pendentes' ? ' selected' : ''}>Não realizadas</option>
          <option value="realizadas"${f.status === 'realizadas' ? ' selected' : ''}>Realizadas</option>
          <option value="todas"${f.status === 'todas' ? ' selected' : ''}>Todas</option></select></label>
      </div>
      <div id="pb-lista"></div>
    </article>`;
}

// ---------------------------------------------------------------- modal de cadastro

function abrirModal() {
  const t = TABELAS[P.aba];
  P.sel[P.aba] = null;

  const campoForm = (c) =>
    c.tipo === 'status'
      ? `<div class="pb-campo"><label>${esc(c.rotulo)}</label>${statusSelect('id="pb-f-status"', 'NAO_REALIZADA')}</div>`
      : `<div class="pb-campo"><label>${esc(c.rotulo)}${c.obrigatorio ? ' <i>*</i>' : ''}</label><input id="pb-f-${c.k}" type="${c.tipo}" ${c.tipo === 'number' ? 'min="0" step="0.01" placeholder="0,00"' : ''} ${c.max ? `maxlength="${c.max}"` : ''} ${c.tipo === 'date' ? 'min="2000-01-01" max="2100-12-31"' : ''}></div>`;

  $('pb-modal').innerHTML = `
    <div class="pb-modal-topo">
      <span class="pb-ico ${t.cor}">${ICONE.plus}</span><div><h3>${esc(t.cardTitulo)}</h3><p>${esc(t.cardSub)}</p></div>
      <button type="button" class="pb-fechar" data-fechar aria-label="Fechar">×</button>
    </div>
    <div class="pb-cadastro">
      <div class="pb-campos">
        <div class="pb-campo pb-busca-campo"><label>Número do pedido <i>*</i></label>
          <div class="pb-entrada-icone" id="pb-entrada">${ICONE.busca}<input id="pb-busca" type="search" autocomplete="off" placeholder="Número ou nome do cliente"></div>
          <ul class="pb-res" id="pb-res" hidden></ul>
          <div class="pb-sel" id="pb-sel" hidden></div>
        </div>
        ${t.campos.map(campoForm).join('')}
      </div>
      <div class="pb-dica" id="pb-dica"></div>
      <div class="pb-erro" id="pb-erro" role="alert"></div>
      <div class="pb-modal-acoes">
        <button type="button" class="pb-botao" data-fechar>Cancelar</button>
        <button type="button" class="pb-adicionar" id="pb-add"><b>+</b> Adicionar</button>
      </div>
    </div>`;
  renderSelecao();
  $('pb-modal').showModal();
  $('pb-busca').focus();
}

const selHtml = (s) =>
  `<span class="pb-chip"><b>Pedido ${s.numero}</b>${s.cliente ? ` · ${esc(s.cliente)}` : ''}<button type="button" data-limpar-sel aria-label="Trocar o pedido">×</button></span>`;

function dicaDaAba() {
  const s = P.sel[P.aba];
  if (!s) return P.aba === 'devolucoes' ? 'Escolha o pedido: forma de pagamento e valor são preenchidos sozinhos com os dados do pedido de venda (você pode ajustar).' : 'Digite o número ou o nome do cliente e escolha o pedido na lista.';
  if (s.carregando) return 'Buscando os dados do pedido na Nomus… (pode levar alguns segundos)';
  if (s.aviso) return `<span class="pb-aviso">${esc(s.aviso)}</span> <button type="button" class="pb-link" data-tentar="${s.numero}">Tentar de novo</button>`;
  if (P.aba === 'urgentes' && s.prazoEntrega) return `Prazo de entrega atual do pedido: ${esc(fmtData(s.prazoEntrega))}.`;
  if (P.aba === 'devolucoes' && s.preenchido) {
    const dividido = s.valorTotal && s.valor !== null && Math.abs(s.valorTotal - s.valor) > 0.005;
    return dividido
      ? `Forma de pagamento preenchida pelo pedido de venda. O valor é o da <b>entrada</b> (${esc(brl(s.valor))}); o total do pedido é ${esc(brl(s.valorTotal))}.`
      : 'Forma de pagamento e valor (pago de uma vez) preenchidos com os dados do pedido de venda da Nomus.';
  }
  return '';
}

/** Mostra o pedido escolhido no lugar da busca (ou a busca, se nenhum): só mexe nesses elementos, o resto do formulário fica como está. */
function renderSelecao() {
  const s = P.sel[P.aba];
  const entrada = $('pb-entrada');
  if (!entrada) return;
  entrada.hidden = !!s;
  $('pb-sel').hidden = !s;
  $('pb-sel').innerHTML = s ? selHtml(s) : '';
  $('pb-dica').innerHTML = dicaDaAba();
}

// ---------------------------------------------------------------- lista (tabela + filtros)

const diaSP = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) : '');
const somarDias = (iso, n) => {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
};

function registrosFiltrados() {
  const t = TABELAS[P.aba];
  const f = P.f[P.aba];
  const q = f.q.trim().toLowerCase();
  return P.dados[P.aba].filter((r) => {
    if (f.status === 'pendentes' && r.status === 'REALIZADA') return false;
    if (f.status === 'realizadas' && r.status !== 'REALIZADA') return false;
    if (q && ![r.numeroPedido, r.cliente, r.causa, r.motorista, r.acao, r.formaPagamento].join(' ').toLowerCase().includes(q)) return false;
    if (f.data) {
      const d = t.data.tipo === 'cadastro' ? diaSP(r[t.data.campo]) : r[t.data.campo];
      if (t.data.tipo === 'futura') {
        if (f.data === 'vencidas' && !(d && d < P.hoje)) return false;
        if (f.data === 'hoje' && d !== P.hoje) return false;
        if (f.data === 'semana' && !(d && d >= P.hoje && d <= somarDias(P.hoje, 7))) return false;
        if (f.data === 'sem' && d) return false;
      } else {
        if (f.data === 'hoje' && d !== P.hoje) return false;
        if (f.data === '7' && !(d && d >= somarDias(P.hoje, -6))) return false;
        if (f.data === '30' && !(d && d >= somarDias(P.hoje, -29))) return false;
      }
    }
    return true;
  });
}

function renderLista() {
  const alvo = $('pb-lista');
  if (!alvo) return;
  const t = TABELAS[P.aba];
  const lista = registrosFiltrados();
  const total = P.dados[P.aba].length;

  if (!lista.length) {
    const filtrando = total > 0;
    alvo.innerHTML = `<div class="pb-vazio">${ILUSTRACAO_VAZIA}<h4>${esc(filtrando ? 'Nenhum registro com esses filtros.' : t.vazio)}</h4>
      <p>${esc(filtrando ? 'Ajuste os filtros acima para ver outros registros.' : t.vazioSub)}</p></div>`;
    return;
  }

  const linhas = lista
    .map(
      (r) => `<tr data-id="${r.id}">
        <td><b>${r.numeroPedido}</b>${r.cliente ? `<span class="pb-sub">${esc(r.cliente)}</span>` : ''}</td>
        ${t.campos.map((c) => (c.tipo === 'status'
          ? `<td>${statusSelect('data-campo="status"', r.status || 'NAO_REALIZADA', `aria-label="Status do pedido ${r.numeroPedido}"`)}</td>`
          : `<td><input class="pb-in" type="${c.tipo}" data-campo="${c.k}" value="${esc(r[c.k] ?? '')}" ${c.tipo === 'number' ? 'min="0" step="0.01"' : ''} ${c.max ? `maxlength="${c.max}"` : ''} ${c.tipo === 'date' ? 'min="2000-01-01" max="2100-12-31"' : ''} aria-label="${esc(c.rotulo)} do pedido ${r.numeroPedido}"></td>`)).join('')}
        <td class="pb-acoes">${P.aba === 'devolucoes' ? `<button type="button" class="pb-acoes-btn" data-acoes="${r.id}" title="Etapas do atendimento desta devolução" aria-label="Ações do pedido ${r.numeroPedido}: ${r.etapasFeitas || 0} de 5 etapas">${ICONE.etapas} Ações <i>${r.etapasFeitas || 0}/5</i></button>` : ''}<button type="button" class="pb-excluir" data-remover="${r.id}" title="Excluir este registro" aria-label="Excluir registro do pedido ${r.numeroPedido}">${ICONE.lixo}<span>Excluir</span></button></td></tr>`
    )
    .join('');

  alvo.innerHTML = `<div class="pb-tabela-wrap"><table class="pb-tabela">
    <thead><tr><th>Número do pedido</th>${t.campos.map((c) => `<th>${esc(c.rotulo)}</th>`).join('')}<th></th></tr></thead>
    <tbody>${linhas}</tbody></table></div>
    <div class="pb-rodape">${lista.length} ${lista.length === 1 ? 'registro' : 'registros'}${lista.length !== total ? ` de ${total}` : ''}</div>`;
}

function renderTudo() {
  renderKpis();
  renderAbas();
  renderSync();
  if (P.montada !== P.aba) montarAba();
  renderLista();
}

// ---------------------------------------------------------------- dados

function aplicar(r) {
  P.dados = { urgentes: r.urgentes, devolucoes: r.devolucoes, defeitos: r.defeitos };
  P.resumo = r.resumo;
  P.hoje = r.hoje;
  P.atualizadoEm = new Date();
}

async function carregar({ silencioso = false } = {}) {
  try {
    aplicar(await api('/api/problematicos'));
    renderTudo();
  } catch (erro) {
    if (!silencioso) mostrarToast(`Não foi possível carregar os registros: ${erro.message}`);
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
  renderSelecao();
  try {
    const d = await api(`/api/problematicos/pedidos/${numero}`);
    if (!P.sel[aba] || P.sel[aba].numero !== numero) return;
    P.sel[aba] = { numero, cliente: d.cliente || cliente, prazoEntrega: d.prazoEntrega, carregando: false, aviso: d.aviso || '', valor: d.valor, valorTotal: d.valorTotal };
    // Devolução: forma de pagamento e valor saem do pedido de venda (só em campo vazio: o que foi digitado vale mais).
    if (aba === 'devolucoes') {
      if ($('pb-f-formaPagamento') && !$('pb-f-formaPagamento').value) $('pb-f-formaPagamento').value = d.formaPagamento || '';
      if ($('pb-f-valor') && !$('pb-f-valor').value) $('pb-f-valor').value = d.valor ?? '';
      P.sel[aba].preenchido = !!(d.formaPagamento || d.valor !== null);
    }
    if (P.aba === aba) {
      renderSelecao();
      if (aba === 'devolucoes' && !d.aviso && !P.sel[aba].preenchido) $('pb-dica').textContent = 'A Nomus não trouxe forma de pagamento/valor deste pedido: preencha à mão.';
    }
  } catch (e) {
    P.sel[aba] = null;
    if (P.aba === aba) { renderSelecao(); erro(e.message); }
  }
}

// ---------------------------------------------------------------- ações

async function adicionar() {
  erro('');
  const t = TABELAS[P.aba];
  const sel = P.sel[P.aba];
  if (!sel) return erro('Escolha o pedido na busca primeiro.');
  if (sel.carregando && P.aba === 'devolucoes') return erro('Aguarde um instante: buscando a forma de pagamento e o valor do pedido na Nomus…');
  const corpo = { numeroPedido: sel.numero, cliente: sel.cliente };
  for (const c of t.campos) {
    const v = $(`pb-f-${c.k}`).value.trim();
    if (c.tipo === 'number') { if (v !== '') corpo[c.k] = Number(v); }
    else if (v !== '' || c.obrigatorio) corpo[c.k] = v;
  }
  const aba = P.aba;
  try {
    await window.PCP.programacao?.garantirUsuario?.();
    aplicar(await api(`/api/problematicos/${aba}`, { method: 'POST', body: JSON.stringify(corpo) }));
    P.sel[aba] = null;
    $('pb-modal').close(); // o cadastro fecha ao concluir
    renderKpis();
    renderAbas();
    renderLista();
    mostrarToast(corpo.status === 'REALIZADA' ? `Pedido ${sel.numero} cadastrado como realizada: oculto da lista.` : `Pedido ${sel.numero} cadastrado em ${t.aba}.`);
  } catch (e) {
    erro(e.message);
  }
}

async function salvarLinha(el) {
  const id = el.closest('tr').dataset.id;
  const aba = P.aba;
  const c = TABELAS[aba].campos.find((x) => x.k === el.dataset.campo);
  let v = el.value.trim();
  if (c.tipo === 'date' && v && !/^(20\d\d)-\d\d-\d\d$/.test(v)) return; // ano ainda sendo digitado
  if (c.tipo === 'number') v = v === '' ? null : Number(v);
  if (c.tipo === 'date' && v === '') {
    // Data obrigatória não pode ser apagada; a opcional (ex.: prazo da ação) pode ser limpa.
    if (c.obrigatorio) { el.value = P.dados[aba].find((r) => String(r.id) === id)?.[c.k] ?? ''; return; }
    v = null;
  }
  el.classList.add('salvando');
  try {
    await window.PCP.programacao?.garantirUsuario?.();
    aplicar(await api(`/api/problematicos/${aba}/${id}`, { method: 'PATCH', body: JSON.stringify({ [c.k]: v }) }));
    el.classList.remove('erro');
    renderKpis();
    renderAbas();
    if (c.k === 'status') {
      const numero = P.dados[aba].find((x) => String(x.id) === id)?.numeroPedido;
      renderLista(); // realizada some da lista (filtro "Não realizadas"); a cor muda nos demais casos
      if (v === 'REALIZADA' && P.f[aba].status === 'pendentes') {
        mostrarToast(`Pedido ${numero} marcado como realizada e ocultado.`, async () => {
          try {
            aplicar(await api(`/api/problematicos/${aba}/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'NAO_REALIZADA' }) }));
            renderTudo();
          } catch (e2) { mostrarToast(e2.message); }
        });
      }
    }
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
    aplicar(await api(`/api/problematicos/${P.aba}/${id}`, { method: 'DELETE' }));
    renderKpis();
    renderAbas();
    renderLista();
  } catch (e) {
    mostrarToast(e.message);
  }
}

function exportarCsv() {
  const t = TABELAS[P.aba];
  const lista = registrosFiltrados();
  const celula = (c, r) => {
    const v = r[c.k];
    if (c.tipo === 'status') return NOMES_STATUS[v] || '';
    if (c.tipo === 'date') return v ? fmtData(v) : '';
    if (c.tipo === 'number') return v === null || v === undefined ? '' : String(v).replace('.', ',');
    return v ?? '';
  };
  const esc2 = (x) => {
    let s = String(x ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // não deixa o Excel tratar texto como fórmula
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cab = ['Número do pedido', 'Cliente', ...t.campos.map((c) => c.rotulo)];
  const linhas = lista.map((r) => [r.numeroPedido, r.cliente, ...t.campos.map((c) => celula(c, r))].map(esc2).join(';'));
  const url = URL.createObjectURL(new Blob(['﻿' + [cab.join(';'), ...linhas].join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${P.aba}-${P.hoje || 'lista'}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------- eventos

const raiz = $('view-problematicos');

raiz.addEventListener('click', (e) => {
  const ir = e.target.closest('[data-ir]');
  if (ir) return void window.PCP.mostrarView(ir.dataset.ir);
  const aba = e.target.closest('[data-aba]');
  if (aba) { P.aba = aba.dataset.aba; return renderTudo(); }
  if (e.target.closest('[data-atualizar]')) return void carregar();
  if (e.target.closest('[data-novo]')) return abrirModal();
  if (e.target.closest('[data-fechar]')) return e.target.closest('dialog')?.close();
  if (e.target.id === 'pb-modal' || e.target.id === 'pb-acoes-modal') return e.target.close(); // clicar fora também fecha
  const ac = e.target.closest('[data-acoes]');
  if (ac) return void abrirAcoes(ac.dataset.acoes);
  const delPrint = e.target.closest('[data-del-print]');
  if (delPrint) return void removerPrint(delPrint.dataset.delPrint);
  const verPrint = e.target.closest('[data-ver-print]');
  if (verPrint) return void window.open(verPrint.src, '_blank', 'noopener');
  if (e.target.closest('[data-exportar]')) { e.target.closest('details')?.removeAttribute('open'); return exportarCsv(); }
  const esc_ = e.target.closest('[data-escolher]');
  if (esc_) { $('pb-res').hidden = true; return void escolher(Number(esc_.dataset.escolher), esc_.dataset.cliente); }
  const tentar = e.target.closest('[data-tentar]');
  if (tentar) return void escolher(Number(tentar.dataset.tentar), P.sel[P.aba]?.cliente || '');
  if (e.target.closest('[data-limpar-sel]')) { P.sel[P.aba] = null; renderSelecao(); return $('pb-busca')?.focus(); }
  if (e.target.closest('#pb-add')) return void adicionar();
  const rem = e.target.closest('[data-remover]');
  if (rem) return void remover(rem.dataset.remover);
  if (!e.target.closest('.pb-busca-campo') && $('pb-res')) $('pb-res').hidden = true;
});

raiz.addEventListener('input', (e) => {
  if (e.target.matches('#pb-acoes-modal [data-ac]') && e.target.type !== 'radio' && e.target.type !== 'date') return void campoAcoes(e.target, false);
  if (e.target.id === 'pb-busca') {
    clearTimeout(P.timer);
    P.timer = setTimeout(() => pesquisar(e.target.value), 250);
  } else if (e.target.id === 'pb-fq') {
    P.f[P.aba].q = e.target.value;
    renderLista();
  }
});

raiz.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'pb-busca') {
    e.preventDefault();
    const primeiro = document.querySelector('#pb-res [data-escolher]');
    if (primeiro) escolher(Number(primeiro.dataset.escolher), primeiro.dataset.cliente);
  } else if (e.target.matches('.pb-cadastro input')) {
    e.preventDefault();
    adicionar();
  }
});

raiz.addEventListener('change', (e) => {
  if (e.target.matches('#pb-acoes-modal [data-ac]')) return void campoAcoes(e.target, true);
  if (e.target.matches('#pb-acoes-modal [data-arquivo]')) { const f = [...e.target.files]; e.target.value = ''; return void anexarArquivos(e.target.dataset.arquivo, f); }
  if (e.target.id === 'pb-fdata') { P.f[P.aba].data = e.target.value; return renderLista(); }
  if (e.target.id === 'pb-fstatus') { P.f[P.aba].status = e.target.value; return renderLista(); }
  if (e.target.id === 'pb-f-status') { e.target.className = `pb-st pb-st-${e.target.value}`; return; }
  if (e.target.matches('.pb-tabela [data-campo]')) salvarLinha(e.target);
});

// Atualiza sozinha (outra pessoa pode ter cadastrado), sem atrapalhar quem está editando uma linha.
setInterval(() => {
  if (raiz.hidden || document.hidden || document.activeElement?.closest?.('#pb-lista')) return;
  carregar({ silencioso: true });
}, 30_000);

window.PCP.problematicos = {
  async abrir() {
    window.PCP.mostrarView('problematicos');
    if (P.resumo) renderTudo(); // já tem dados: mostra na hora e atualiza em seguida
    await carregar();
  },
};

$('pb-modal').addEventListener('close', () => {
  for (const k of Object.keys(P.sel)) P.sel[k] = null;
});

// ---------------------------------------------------------------- Devoluções > Ações (etapas do atendimento)

const ETAPAS_ACOES = [
  { k: 'sac', n: 1, titulo: 'SAC', quem: true, prints: true },
  { k: 'vera', n: 2, titulo: 'Vera', prints: true },
  { k: 'dirceu', n: 3, titulo: 'Dirceu', prints: true },
];

const AC = { id: null, dados: null, sujo: new Map(), fila: Promise.resolve(), timer: null, urls: new Map(), enviando: new Set() };

const etapaFeita = (k, d) => {
  if (k === 'sac') return !!(d.sac.quem || d.sac.conversa || d.sac.prints.length);
  if (k === 'vera' || k === 'dirceu') return !!(d[k].conversa || d[k].prints.length);
  if (k === 'decisao') return !!d.decisao;
  return !!d.financeiro.realizada;
};

function miniaturasHtml(k) {
  const lista = AC.dados[k].prints;
  const enviando = AC.enviando.has(k) ? '<span class="ac-enviando">Enviando…</span>' : '';
  return lista.map((p) => `<figure class="ac-print"><img data-ver-print data-print-id="${p.id}" alt="${esc(p.nome)}" title="${esc(p.nome)} — clique para ampliar"><button type="button" class="ac-print-x" data-del-print="${p.id}" aria-label="Remover print ${esc(p.nome)}">×</button></figure>`).join('') + enviando;
}

function carregarMiniaturas() {
  for (const img of document.querySelectorAll('#pb-acoes-modal img[data-print-id]')) {
    const id = img.dataset.printId;
    if (AC.urls.has(id)) { img.src = AC.urls.get(id); continue; }
    window.PCP.apiBlob(`/api/problematicos/prints/${id}`).then((b) => {
      const url = URL.createObjectURL(b);
      AC.urls.set(id, url);
      if (img.isConnected) img.src = url;
    }).catch(() => { img.alt = 'não foi possível carregar'; });
  }
}

function blocoPrints(k) {
  return `<div class="ac-anexo"><label class="ac-anexar">${ICONE.clipe} Anexar print<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden data-arquivo="${k}"></label>
    <span class="ac-dica">ou cole com Ctrl+V</span></div><div class="ac-prints" id="ac-prints-${k}">${miniaturasHtml(k)}</div>`;
}

function progressoHtml() {
  const d = AC.dados;
  const marcas = ['sac', 'vera', 'dirceu', 'decisao', 'financeiro'];
  return `<div class="ac-prog-barra">${marcas.map((k) => `<i class="${etapaFeita(k, d) ? 'on' : ''}"></i>`).join('')}</div><span>${d.feitas} de 5 etapas preenchidas</span>`;
}

function renderAcoes(r) {
  const d = AC.dados;
  const etapaTexto = (e) => `
    <section class="ac-etapa${etapaFeita(e.k, d) ? ' feita' : ''}" data-etapa="${e.k}">
      <span class="ac-num">${e.n}</span>
      <div class="ac-corpo"><h4>Etapa ${e.n} — ${e.titulo}</h4>
        ${e.quem ? `<label class="ac-campo">Quem falou com o cliente?<input data-ac="sacQuem" maxlength="120" value="${esc(d.sac.quem)}" placeholder="Nome de quem atendeu"></label>` : ''}
        <label class="ac-campo">O que foi conversado<textarea data-ac="${e.k}Conversa" rows="3" maxlength="3000" placeholder="Resumo da conversa">${esc(d[e.k].conversa)}</textarea></label>
        ${blocoPrints(e.k)}
      </div>
    </section>`;
  const opcao = (nome, valor, texto, marcado) => `<label class="ac-opcao"><input type="radio" name="ac-${nome}" data-ac="${nome}" value="${valor}"${marcado ? ' checked' : ''}><span>${texto}</span></label>`;
  $('pb-acoes-modal').innerHTML = `
    <div class="pb-modal-topo">
      <span class="pb-ico verde">${ICONE.etapas}</span><div><h3>Ações da devolução</h3><p>Pedido <b>${r.numeroPedido}</b>${r.cliente ? ` · ${esc(r.cliente)}` : ''}</p></div>
      <button type="button" class="pb-fechar" data-fechar aria-label="Fechar">×</button>
    </div>
    <div class="ac-prog" id="ac-prog">${progressoHtml()}</div>
    <div class="ac-lista">
      ${ETAPAS_ACOES.map(etapaTexto).join('')}
      <section class="ac-etapa${etapaFeita('decisao', d) ? ' feita' : ''}" data-etapa="decisao">
        <span class="ac-num">4</span>
        <div class="ac-corpo"><h4>Etapa 4 — Decisão</h4>
          <div class="ac-opcoes" role="radiogroup" aria-label="Decisão">${opcao('decisao', 'MANTEM', 'Mantém o pedido', d.decisao === 'MANTEM')}${opcao('decisao', 'CANCELAR', 'Cliente quer cancelar mesmo', d.decisao === 'CANCELAR')}</div></div>
      </section>
      <section class="ac-etapa${etapaFeita('financeiro', d) ? ' feita' : ''}" data-etapa="financeiro">
        <span class="ac-num">5</span>
        <div class="ac-corpo"><h4>Etapa 5 — Financeiro</h4>
          <div class="ac-campo">Devolução realizada?
            <div class="ac-opcoes" role="radiogroup" aria-label="Devolução realizada">${opcao('finRealizada', 'SIM', 'Sim', d.financeiro.realizada === 'SIM')}${opcao('finRealizada', 'NAO', 'Não', d.financeiro.realizada === 'NAO')}</div></div>
          <label class="ac-campo" id="ac-fin-data"${d.financeiro.realizada === 'SIM' ? '' : ' hidden'}>Qual foi a data?<input type="date" data-ac="finData" min="2000-01-01" max="2100-12-31" value="${esc(d.financeiro.data || '')}"></label>
        </div>
      </section>
    </div>
    <div class="ac-rodape"><span id="ac-salvo" class="ac-salvo" role="status">Salvo automaticamente</span><button type="button" class="pb-botao" data-fechar>Fechar</button></div>`;
  carregarMiniaturas();
}

async function abrirAcoes(id) {
  const r = P.dados.devolucoes.find((x) => String(x.id) === String(id));
  if (!r) return;
  try {
    AC.id = Number(id);
    AC.sujo.clear();
    AC.enviando.clear();
    AC.dados = await api(`/api/problematicos/devolucoes/${id}/acoes`);
    renderAcoes(r);
    $('pb-acoes-modal').showModal();
    $('pb-acoes-modal').scrollTop = 0; // o foco automático não deve rolar o título para fora
  } catch (e) {
    mostrarToast(`Não foi possível abrir as ações: ${e.message}`);
  }
}

function atualizarEtapas() {
  const d = AC.dados;
  $('ac-prog').innerHTML = progressoHtml();
  for (const sec of document.querySelectorAll('#pb-acoes-modal [data-etapa]')) sec.classList.toggle('feita', etapaFeita(sec.dataset.etapa, d));
  const r = P.dados.devolucoes.find((x) => x.id === AC.id);
  if (r) {
    r.etapasFeitas = d.feitas;
    const i = document.querySelector(`[data-acoes="${AC.id}"] i`);
    if (i) i.textContent = `${d.feitas}/5`;
  }
}

function marcarSalvo(texto, erroMsg = false) {
  const el = $('ac-salvo');
  if (!el) return;
  el.textContent = texto;
  el.classList.toggle('erro', erroMsg);
}

/** Envia o que foi digitado (um pedido por vez, na ordem, para uma gravação não passar por cima de outra). */
function salvarAcoes() {
  clearTimeout(AC.timer);
  if (!AC.sujo.size) return AC.fila;
  const id = AC.id;
  const corpo = Object.fromEntries(AC.sujo);
  AC.sujo.clear();
  marcarSalvo('Salvando…');
  AC.fila = AC.fila.then(async () => {
    try {
      await window.PCP.programacao?.garantirUsuario?.();
      const novo = await api(`/api/problematicos/devolucoes/${id}/acoes`, { method: 'PUT', body: JSON.stringify(corpo) });
      if (AC.id === id) {
        // Mantém as listas de prints locais (não mudam por aqui) e atualiza o resto sem mexer no que está sendo digitado.
        AC.dados = novo;
        atualizarEtapas();
        marcarSalvo('Salvo ✓');
      }
    } catch (e) {
      marcarSalvo(`Não salvou: ${e.message}`, true);
      mostrarToast(e.message);
    }
  });
  return AC.fila;
}

function campoAcoes(el, agora) {
  const campo = el.dataset.ac;
  if (el.type === 'radio') {
    if (!el.checked) return;
    AC.sujo.set(campo, el.value);
    if (campo === 'finRealizada') {
      const caixa = $('ac-fin-data');
      caixa.hidden = el.value !== 'SIM';
      if (el.value !== 'SIM') caixa.querySelector('input').value = '';
    }
    return void salvarAcoes();
  }
  if (el.type === 'date') {
    if (el.value && !/^(20\d\d)-\d\d-\d\d$/.test(el.value)) return; // ano ainda sendo digitado
    AC.sujo.set(campo, el.value || null);
    return void salvarAcoes();
  }
  AC.sujo.set(campo, el.value);
  marcarSalvo('Digitando…');
  clearTimeout(AC.timer);
  if (agora) return void salvarAcoes();
  AC.timer = setTimeout(salvarAcoes, 900);
}

// ---- prints

const lerComoBase64 = (blob) => new Promise((ok, falha) => {
  const fr = new FileReader();
  fr.onload = () => ok(String(fr.result).split(',')[1] || '');
  fr.onerror = () => falha(new Error('Não foi possível ler a imagem.'));
  fr.readAsDataURL(blob);
});

/** Imagens grandes (foto de celular, tela cheia) são reduzidas antes de enviar: o print continua legível e o banco não incha. */
async function prepararImagem(arquivo) {
  const tiposOk = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!tiposOk.includes(arquivo.type)) throw new Error(`"${arquivo.name || 'arquivo'}" não é uma imagem PNG, JPG, WEBP ou GIF.`);
  const nome = arquivo.name && arquivo.name !== 'image.png' ? arquivo.name : `print-${new Date().toLocaleString('pt-BR').replace(/[\/:]/g, '-').replace(', ', '_')}.png`;
  if (arquivo.type === 'image/gif' || arquivo.size <= 1_200_000) {
    if (arquivo.size > 4 * 1024 * 1024) throw new Error(`"${nome}" passa de 4 MB.`);
    return { nome, tipo: arquivo.type, dados: await lerComoBase64(arquivo) };
  }
  const bmp = await createImageBitmap(arquivo);
  const escala = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const tela = document.createElement('canvas');
  tela.width = Math.round(bmp.width * escala);
  tela.height = Math.round(bmp.height * escala);
  const ctx = tela.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, tela.width, tela.height);
  ctx.drawImage(bmp, 0, 0, tela.width, tela.height);
  const blob = await new Promise((ok) => tela.toBlob(ok, 'image/jpeg', 0.85));
  if (!blob) throw new Error('Não foi possível reduzir a imagem.');
  return { nome: nome.replace(/\.[^.]+$/, '') + '.jpg', tipo: 'image/jpeg', dados: await lerComoBase64(blob) };
}

async function anexarArquivos(etapa, arquivos) {
  const id = AC.id;
  for (const arq of arquivos) {
    AC.enviando.add(etapa);
    $(`ac-prints-${etapa}`).innerHTML = miniaturasHtml(etapa);
    carregarMiniaturas();
    try {
      const img = await prepararImagem(arq);
      await window.PCP.programacao?.garantirUsuario?.();
      const novo = await api(`/api/problematicos/devolucoes/${id}/acoes/prints`, { method: 'POST', body: JSON.stringify({ etapa, nome: img.nome, tipo: img.tipo, dados: img.dados }) });
      if (AC.id === id) AC.dados = novo;
    } catch (e) {
      mostrarToast(e.message);
    }
    AC.enviando.delete(etapa);
    if (AC.id !== id) return;
    $(`ac-prints-${etapa}`).innerHTML = miniaturasHtml(etapa);
    carregarMiniaturas();
    atualizarEtapas();
  }
}

async function removerPrint(printId) {
  if (!confirm('Remover este print?')) return;
  const id = AC.id;
  try {
    const novo = await api(`/api/problematicos/prints/${printId}`, { method: 'DELETE' });
    if (AC.id !== id) return;
    AC.dados = novo;
    for (const e of ETAPAS_ACOES) { const alvo = $(`ac-prints-${e.k}`); if (alvo) alvo.innerHTML = miniaturasHtml(e.k); }
    carregarMiniaturas();
    atualizarEtapas();
  } catch (e) {
    mostrarToast(e.message);
  }
}

// Ctrl+V com uma imagem copiada cai na etapa onde o cursor está.
$('pb-acoes-modal').addEventListener('paste', (e) => {
  const etapa = e.target.closest?.('[data-etapa]')?.dataset.etapa;
  if (!['sac', 'vera', 'dirceu'].includes(etapa)) return;
  const imagens = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!imagens.length) return; // texto comum: segue o fluxo normal
  e.preventDefault();
  void anexarArquivos(etapa, imagens);
});

$('pb-acoes-modal').addEventListener('close', () => {
  void salvarAcoes(); // fechou com algo ainda sem enviar: envia agora
  for (const url of AC.urls.values()) URL.revokeObjectURL(url);
  AC.urls.clear();
  renderLista();
});
