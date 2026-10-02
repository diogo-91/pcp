// A tela só IMPRIME o que o servidor manda (alertas, contagens, opções) e salva o que o PCP edita.
// Nenhuma regra de prazo mora aqui: tudo vem calculado de GET /api/pedidos.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtData = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const fmtHora = (iso) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const NOMES_FILTRO = {
  todos: 'Todos os pedidos',
  normal: 'No prazo',
  atrasado: 'Pedidos atrasados',
  ate2: 'Vencem em até 2 dias',
  de3a5: 'Vencem em 3 a 5 dias',
  semdata: 'Sem prazo definido',
};
const CLASSE_TAG = { atrasado: 'late', ate2: 'soon', de3a5: 'near', normal: 'undated', semdata: 'undated' };
const COR_STATUS = { 'PEDIDO LIBERADO': 'green', 'AGUARDANDO MEDIDA': 'gray', 'EM PRODUÇÃO': 'amber', 'EXPEDIÇÃO': 'blue', 'ROTA DE ENTREGA': 'purple', 'ENCERRADO': 'red', 'CANCELADO': 'violet' };
const COR_ATENDIMENTO = { 'Atendimento aberto': 'gray', 'Aguardando compras': 'green', 'Aguardado programação': 'amber', 'Aguardando produção': 'blue', 'Em Analise': 'purple', 'Aguardando retorno': 'red', 'Resolvido': 'gray' };

const estado = {
  pedidos: [],
  resumo: { total: 0, atrasado: 0, ate2: 0, de3a5: 0, normal: 0, semdata: 0 },
  opcoes: { statusPcp: [], atendimento: [], acaoStatus: [], finais: [] },
  sync: { executando: false, ultima: null, ultimaComSucesso: null },
  hoje: '',
  filtro: 'todos',
  busca: '',
  status: 'todos',
  // Pedido não finalizado com mais de 90 dias de atraso some do painel por padrão (é lixo represado, não prioridade
  // do dia a dia); `antigos` alterna pra trazê-lo de volta. `ocultosMuitoAtrasados` é sempre o total, mesmo trazido.
  antigos: false,
  ocultosMuitoAtrasados: 0,
};

// ---------------------------------------------------------------- API
const CHAVE_TOKEN = 'pcp_token';
const lerToken = () => { try { return localStorage.getItem(CHAVE_TOKEN) || ''; } catch { return ''; } };
const gravarToken = (t) => { try { t ? localStorage.setItem(CHAVE_TOKEN, t) : localStorage.removeItem(CHAVE_TOKEN); } catch { /* sem storage: pede de novo */ } };

async function api(caminho, opcoes = {}) {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const headers = { ...(opcoes.body ? { 'Content-Type': 'application/json' } : {}), ...(lerToken() ? { 'x-pcp-token': lerToken() } : {}) };
    const res = await fetch(caminho, { ...opcoes, headers });

    if (res.status === 401) {
      gravarToken('');
      const digitado = prompt('Esta página é protegida. Informe o código de acesso:');
      if (!digitado) throw new Error('Acesso negado.');
      gravarToken(digitado.trim());
      continue;
    }

    if (!res.ok) {
      let msg = `Erro ${res.status}`;
      try { msg = (await res.json()).erro || msg; } catch { /* corpo não é JSON */ }
      throw new Error(msg);
    }
    return res.json();
  }
  gravarToken('');
  throw new Error('Acesso negado.');
}

// ---------------------------------------------------------------- avisos
function aviso(texto, tipo = 'erro') {
  const el = $('aviso');
  if (!texto) { el.hidden = true; return; }
  el.textContent = texto;
  el.className = 'aviso' + (tipo === 'info' ? ' info' : '');
  el.hidden = false;
}

function mensagemSalvo(texto, ok = true) {
  const el = $('salvo');
  el.textContent = texto;
  el.className = ok ? 'ok' : 'err';
}

// ---------------------------------------------------------------- render: topo
function renderTopo() {
  $('data-hoje').textContent = estado.hoje ? fmtData(estado.hoje) : '';
  const { executando, ultima, ultimaComSucesso } = estado.sync;
  const chip = $('chip-sync');
  const btn = $('btn-sync');
  btn.disabled = executando;
  btn.textContent = executando ? 'Sincronizando…' : 'Sincronizar';

  if (executando) {
    const lidos = ultima?.pedidosLidos || 0;
    chip.className = 'online warn';
    chip.textContent = lidos > 0 ? `Sincronizando com a Nomus… ${lidos.toLocaleString('pt-BR')} pedidos lidos` : 'Sincronizando com a Nomus…';
  } else if (ultima && ultima.status === 'erro') {
    chip.className = 'online bad';
    chip.textContent = ultimaComSucesso ? `Falha na sincronização · última ok ${fmtHora(ultimaComSucesso.finalizadoEm)}` : 'Falha na sincronização';
    chip.title = ultima.erro || '';
  } else if (ultimaComSucesso) {
    chip.className = 'online';
    chip.textContent = `Nomus · sincronizada ${fmtHora(ultimaComSucesso.finalizadoEm)}`;
    chip.title = `${ultimaComSucesso.pedidosLidos} pedidos liberados na última leitura`;
  } else {
    chip.className = 'online warn';
    chip.textContent = 'Ainda não sincronizado';
  }

  const avisoDeSync = $('aviso').textContent.startsWith('A última sincronização');
  if (!executando && ultima && ultima.status === 'erro') {
    aviso(`A última sincronização com a Nomus falhou: ${ultima.erro || 'erro desconhecido'}. A tela mostra os dados da última sincronização bem-sucedida.`);
  } else if (avisoDeSync) {
    aviso(''); // a falha já foi superada por uma rodada boa (ou uma nova está em andamento)
  }
}

// ---------------------------------------------------------------- render: dashboard
const tagHtml = (p) => `<span class="tag ${CLASSE_TAG[p.faixa]}">${esc(p.alerta)}</span>`;

function renderDashboard() {
  const r = estado.resumo;
  for (const k of ['total', 'normal', 'atrasado', 'ate2', 'de3a5', 'semdata']) $('n-' + k).textContent = r[k].toLocaleString('pt-BR');
  for (const k of ['atrasado', 'ate2', 'de3a5', 'semdata']) $('d-' + k).textContent = r[k].toLocaleString('pt-BR');
  $('d-ate5').textContent = (r.ate2 + r.de3a5).toLocaleString('pt-BR');
  $('progress-total').textContent = `${r.total.toLocaleString('pt-BR')} pedidos`;

  const base = r.total || 1;
  const larguras = { 'p-atrasado': r.atrasado, 'p-ate2': r.ate2, 'p-de3a5': r.de3a5, 'p-outros': Math.max(0, r.total - r.atrasado - r.ate2 - r.de3a5) };
  for (const [id, n] of Object.entries(larguras)) $(id).style.width = `${(n / base) * 100}%`;

  document.querySelectorAll('.stat').forEach((el) => el.classList.toggle('active', el.dataset.filtro === estado.filtro));

  const urgentes = estado.pedidos.filter((p) => ['atrasado', 'ate2', 'de3a5'].includes(p.faixa));
  $('prioridade').innerHTML =
    urgentes
      .slice(0, 12)
      .map(
        (p) => `<div class="mini" data-abrir="${p.nomusId}" role="button" tabindex="0" aria-label="Abrir o pedido ${esc(p.codigoPedido)} na tabela"><strong>Pedido ${esc(p.codigoPedido)} · ${esc(p.clienteNome || 'Cliente não informado')}</strong>
          <small>${tagHtml(p)} · ${esc(p.statusPcp)} · ${esc(p.responsavel || 'Sem responsável')}</small>
          <small>${esc(p.acao || 'Ação ainda não registrada')}</small></div>`
      )
      .join('') || '<p class="muted">Nenhum alerta de prazo.</p>';

  for (const faixa of ['ate2', 'de3a5', 'atrasado']) {
    const lista = estado.pedidos.filter((p) => p.faixa === faixa);
    $('c-' + faixa).textContent = lista.length.toLocaleString('pt-BR');
    $('l-' + faixa).innerHTML = lista.length
      ? lista
          .map(
            (p) => `<div class="deadline-item" data-abrir="${p.nomusId}" role="button" tabindex="0" aria-label="Abrir o pedido ${esc(p.codigoPedido)} na tabela"><div>
              <strong>Pedido ${esc(p.codigoPedido)}</strong><span>${esc(p.clienteNome || 'Cliente não informado')}</span>
              <small>${esc(p.statusPcp)} · ${esc(p.atendimento || 'Sem atendimento')}</small></div>
              <div class="deadline-meta"><b>${esc(p.alerta)}</b><span>${esc(fmtData(p.prazoEntrega))}</span><small>${esc(p.responsavel || 'Sem responsável')}</small></div></div>`
          )
          .join('')
      : '<p class="empty-deadline">Nenhum pedido nesta faixa de prazo.</p>';
  }
}

// ---------------------------------------------------------------- render: tabela
const somenteLeitura = (valor, vazio = '') =>
  valor ? `<span class="cellro" title="${esc(valor)}">${esc(valor)}</span>` : `<span class="cellro vazio">${esc(vazio)}</span>`;

function selectHtml(p, campo, opcoes, cores, rotulo) {
  const atual = String(p[campo] ?? '');
  const lista = atual && !opcoes.includes(atual) ? [...opcoes, atual] : opcoes; // valor antigo/livre continua visível
  const cor = cores[atual] || 'gray';
  return `<select class="sheetcell sheetselect shade-${cor}" data-campo="${campo}" aria-label="${rotulo} do pedido ${esc(p.codigoPedido)}">
    ${campo === 'atendimento' ? '<option value="">Selecione...</option>' : ''}
    ${lista.map((o) => `<option value="${esc(o)}" ${o === atual ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
}

const inputHtml = (p, campo, tipo, rotulo) =>
  `<input class="sheetcell" type="${tipo}" data-campo="${campo}" value="${esc(p[campo] ?? '')}" aria-label="${rotulo} do pedido ${esc(p.codigoPedido)}" spellcheck="false">`;

const dataHtml = (p, campo, rotulo) =>
  `<div class="datecell"><input class="sheetcell" type="date" data-campo="${campo}" value="${esc(p[campo] ?? '')}" aria-label="${rotulo} do pedido ${esc(p.codigoPedido)}">
    <button type="button" class="limpar" data-limpar="${campo}" title="Limpar data" aria-label="Limpar ${rotulo} do pedido ${esc(p.codigoPedido)}">×</button></div>`;

// Prazo de produção: data em que as ordens do pedido estão agendadas no Planejamento do apontamento (somente leitura).
// Com mais de uma ordem vale a mais tardia; o texto ao passar o mouse lista cada ordem com o seu dia.
function producaoHtml(p) {
  if (!p.prazoProducao) {
    return '<span class="cellro vazio" title="Nenhuma ordem deste pedido está agendada no Planejamento">Não programado</span>';
  }
  const depois = p.producaoAposEntrega;
  const itens = (p.producaoItens || []).map((i) => `${i.os}: ${fmtData(i.data)}`).join('\n');
  const titulo = (depois ? 'Produção programada DEPOIS do prazo de entrega\n' : '') + itens;
  return `<span class="cellro prod${depois ? ' depois' : ''}" title="${esc(titulo)}">${esc(fmtData(p.prazoProducao))}${depois ? ' ⚠' : ''}</span>`;
}

function linhaHtml(p) {
  return `<tr data-id="${p.nomusId}">
    <td><span class="cellro"><strong>${esc(p.codigoPedido)}</strong></span></td>
    <td>${somenteLeitura(p.clienteNome, 'Sem nome')}</td>
    <td>${somenteLeitura(p.telefone, 'Sem telefone')}</td>
    <td>${selectHtml(p, 'statusPcp', estado.opcoes.statusPcp, COR_STATUS, 'Status')}</td>
    <td data-celula="producao">${producaoHtml(p)}</td>
    <td>${dataHtml(p, 'prazoEntrega', 'Prazo de entrega')}</td>
    <td data-celula="alerta">${tagHtml(p)}</td>
    <td>${selectHtml(p, 'atendimento', estado.opcoes.atendimento, COR_ATENDIMENTO, 'Atendimento')}</td>
    <td>${inputHtml(p, 'responsavel', 'text', 'Responsável')}</td>
    <td>${inputHtml(p, 'acao', 'text', 'Plano de ação')}</td>
    <td>${dataHtml(p, 'prazoAcao', 'Prazo da ação')}</td>
    <td>${selectHtml(p, 'acaoStatus', estado.opcoes.acaoStatus, {}, 'Situação da ação')}</td>
  </tr>`;
}

function pedidosVisiveis() {
  const q = estado.busca.trim().toLowerCase();
  return estado.pedidos.filter(
    (p) =>
      (estado.filtro === 'todos' || p.faixa === estado.filtro) &&
      (estado.status === 'todos' || p.statusPcp === estado.status) &&
      (!q || [p.clienteNome, p.telefone, p.codigoPedido, String(p.numero), p.statusPcp, p.atendimento, p.responsavel, p.acao].some((v) => String(v ?? '').toLowerCase().includes(q)))
  );
}

function renderFiltroStatus() {
  const usados = [...new Set(estado.pedidos.map((p) => p.statusPcp))].sort();
  const seletor = $('filtro-status');
  seletor.innerHTML = '<option value="todos">Todos os status</option>' + usados.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  if (!usados.includes(estado.status)) estado.status = 'todos';
  seletor.value = estado.status;
}

function mensagemVazia() {
  if (estado.sync.executando) return '<b>Sincronizando com a Nomus…</b>A leitura pode levar alguns minutos (a Nomus limita as consultas). Os pedidos aparecem aqui conforme chegam.';
  if (!estado.sync.ultimaComSucesso) return '<b>Ainda não há pedidos.</b>Clique em “Sincronizar” para buscar os pedidos liberados na Nomus.';
  return '<b>Nenhum pedido encontrado.</b>Ajuste a busca ou os filtros.';
}

function renderTabela() {
  const wrap = document.querySelector('.tablewrap');
  const { scrollTop, scrollLeft } = wrap;
  const lista = pedidosVisiveis();

  $('linhas').innerHTML = lista.length ? lista.map(linhaHtml).join('') : `<tr><td colspan="12" class="vazio-tabela">${mensagemVazia()}</td></tr>`;
  $('contagem').textContent = `${lista.length.toLocaleString('pt-BR')} de ${estado.pedidos.length.toLocaleString('pt-BR')} pedidos`;
  $('chip-filtro').textContent = NOMES_FILTRO[estado.filtro] || NOMES_FILTRO.todos;
  const pl = estado.planejamento;
  const textoProducao = !pl
    ? ''
    : !pl.configurado
      ? 'Prazo de produção: Planejamento não conectado'
      : pl.erro
        ? `Prazo de produção: falha ao ler o Planejamento (${pl.erro}); mostrando a última leitura`
        : pl.ultimoSucesso
          ? `Prazo de produção lido do Planejamento em ${fmtHora(pl.ultimoSucesso)}`
          : 'Prazo de produção: ainda não lido';
  $('faixa-info').textContent = [estado.hoje ? `Prazos calculados em ${fmtData(estado.hoje)}` : '', textoProducao].filter(Boolean).join(' · ');

  wrap.scrollTop = scrollTop;
  wrap.scrollLeft = scrollLeft;
}

function renderTudo() {
  renderTopo();
  renderAntigos();
  renderDashboard();
  renderFiltroStatus();
  renderTabela();
}

// ---------------------------------------------------------------- render: pedidos muito atrasados ocultos
function renderAntigos() {
  const el = $('chip-antigos');
  if (estado.antigos) {
    el.hidden = false;
    el.className = 'chip-antigos ligado';
    el.textContent = 'Voltar a ocultar antigos';
  } else if (estado.ocultosMuitoAtrasados > 0) {
    el.hidden = false;
    el.className = 'chip-antigos';
    el.textContent = `${estado.ocultosMuitoAtrasados.toLocaleString('pt-BR')} pedido(s) c/ 90+ dias de atraso ocultos · Mostrar`;
  } else {
    el.hidden = true;
  }
}

$('chip-antigos').addEventListener('click', () => {
  estado.antigos = !estado.antigos;
  carregar({ silencioso: true });
});

// ---------------------------------------------------------------- carregar
async function carregar({ silencioso = false } = {}) {
  try {
    const dados = await api(`/api/pedidos${estado.antigos ? '?antigos=1' : ''}`);
    Object.assign(estado, dados);
    if ($('aviso').textContent.startsWith('Não foi possível carregar')) aviso('');
    renderTudo();
    if (estado.sync.executando) acompanharSync();
  } catch (erro) {
    if (!silencioso) aviso(`Não foi possível carregar os pedidos: ${erro.message}`);
  }
}

// ---------------------------------------------------------------- aviso com ação (ex.: Desfazer)
let temporizadorAviso;

function mostrarToast(texto, aoDesfazer) {
  const el = $('toast');
  el.replaceChildren();
  const span = document.createElement('span');
  span.textContent = texto;
  el.append(span);

  if (aoDesfazer) {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.textContent = 'Desfazer';
    botao.addEventListener('click', async () => {
      clearTimeout(temporizadorAviso);
      el.hidden = true;
      await aoDesfazer();
    });
    el.append(botao);
  }

  el.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { el.hidden = true; }, 12000);
}

// ---------------------------------------------------------------- salvar uma célula
let salvandoAgora = 0;

// Depois de mudar o prazo, o alerta da linha e os indicadores mudam. Atualiza só isso, sem reconstruir a
// tabela (reconstruir tiraria o cursor da célula e reordenaria a linha embaixo de quem está editando).
async function atualizarPrazoNaTela(tr, p) {
  const celula = tr.querySelector('[data-celula="alerta"]');
  if (celula) celula.innerHTML = tagHtml(p);
  // Mudar o prazo de entrega muda o aviso "produção depois da entrega" da célula vizinha.
  const celulaProducao = tr.querySelector('[data-celula="producao"]');
  if (celulaProducao) celulaProducao.innerHTML = producaoHtml(p);
  try {
    const dados = await api(`/api/pedidos${estado.antigos ? '?antigos=1' : ''}`);
    Object.assign(estado, { resumo: dados.resumo, sync: dados.sync, hoje: dados.hoje, ocultosMuitoAtrasados: dados.ocultosMuitoAtrasados });
    for (const novo of dados.pedidos) {
      const atual = estado.pedidos.find((x) => x.nomusId === novo.nomusId);
      if (atual) Object.assign(atual, novo);
    }
    if (celula) celula.innerHTML = tagHtml(p);
    renderTopo();
    renderDashboard();
    renderAntigos();
  } catch {
    /* os indicadores se acertam no próximo recarregamento */
  }
}

async function salvar(el, valor = el.value) {
  const tr = el.closest('tr');
  const p = estado.pedidos.find((x) => x.nomusId === Number(tr.dataset.id));
  if (!p) return;

  const campo = el.dataset.campo;
  const anterior = p[campo] ?? '';
  if (String(valor) === String(anterior)) return;

  el.classList.remove('erro');
  el.classList.add('salvando');
  salvandoAgora++;

  try {
    const atualizado = await api(`/api/pedidos/${p.nomusId}`, { method: 'PATCH', body: JSON.stringify({ [campo]: valor }) });
    Object.assign(p, atualizado);
    if (el.type === 'date') el.value = p[campo] ?? '';
    mensagemSalvo(`Salvo às ${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);

    if (campo === 'statusPcp' && estado.opcoes.finais.includes(p.statusPcp)) {
      // Encerrado/cancelado sai da tela (continua no banco); o servidor recalcula os indicadores.
      const { nomusId, codigoPedido, statusPcp: novoStatus } = p;
      estado.pedidos = estado.pedidos.filter((x) => x.nomusId !== nomusId);
      await carregar({ silencioso: true });

      // Rede de segurança: finalizar por engano faz o pedido sumir da tela, então dá para desfazer por alguns segundos.
      mostrarToast(`Pedido ${codigoPedido} ${novoStatus.toLowerCase()}: saiu da tabela e continua salvo no banco.`, async () => {
        try {
          await api(`/api/pedidos/${nomusId}`, { method: 'PATCH', body: JSON.stringify({ statusPcp: anterior }) });
          await carregar({ silencioso: true });
          abrirPedidoNaTabela(nomusId);
          mensagemSalvo(`Pedido ${codigoPedido} voltou para a tabela (${anterior}).`);
        } catch (erro) {
          aviso(`Não foi possível desfazer: ${erro.message}`);
        }
      });
    } else if (campo === 'prazoEntrega') {
      await atualizarPrazoNaTela(tr, p);
    } else if (el.classList.contains('sheetselect')) {
      const cores = campo === 'statusPcp' ? COR_STATUS : COR_ATENDIMENTO;
      el.className = `sheetcell sheetselect shade-${cores[p[campo]] || 'gray'}`;
    }
  } catch (erro) {
    // Não desfaz o que a pessoa está digitando agora: o valor só volta ao anterior quando ela sai do campo.
    if (document.activeElement !== el) el.value = anterior;
    el.classList.add('erro');
    mensagemSalvo(`Não foi possível salvar: ${erro.message}`, false);
  } finally {
    el.classList.remove('salvando');
    salvandoAgora--;
  }
}

// Campo de data dispara "change" a cada dígito do ano (0002, 0020, 0202, 2026...). Por isso a data só é
// gravada quando a pessoa para de digitar (ou sai do campo). Data incompleta (vazia) nunca grava: limpar
// é pelo botão "×", para uma pausa no meio da edição não apagar o prazo sem querer.
const ESPERA_DATA_MS = 900;

function confirmarData(el) {
  clearTimeout(el._timer);
  el._timer = null;
  if (el.value === '') {
    const p = estado.pedidos.find((x) => x.nomusId === Number(el.closest('tr').dataset.id));
    el.value = p?.[el.dataset.campo] ?? '';
    return;
  }
  salvar(el);
}

$('linhas').addEventListener('change', (e) => {
  const el = e.target.closest('[data-campo]');
  if (!el) return;
  if (el.type === 'date') {
    clearTimeout(el._timer);
    if (el.value !== '') el._timer = setTimeout(() => confirmarData(el), ESPERA_DATA_MS);
    return;
  }
  salvar(el);
});

$('linhas').addEventListener('focusout', (e) => {
  const el = e.target.closest?.('input[type="date"]');
  if (el) confirmarData(el);
});

$('linhas').addEventListener('click', (e) => {
  const botao = e.target.closest('[data-limpar]');
  if (!botao) return;
  const el = botao.parentElement.querySelector('input[type="date"]');
  clearTimeout(el._timer);
  salvar(el, '');
});

$('linhas').addEventListener('keydown', (e) => {
  const el = e.target.closest('input.sheetcell');
  if (!el) return;
  if (e.key === 'Enter') el.blur();
  if (e.key === 'Escape') {
    const p = estado.pedidos.find((x) => x.nomusId === Number(el.closest('tr').dataset.id));
    el.value = p?.[el.dataset.campo] ?? '';
    el.blur();
  }
});

// ---------------------------------------------------------------- sincronização
let acompanhando = false;

async function acompanharSync() {
  if (acompanhando) return;
  acompanhando = true;
  try {
    renderTopo();
    let jaMostrados = estado.pedidos.length;
    for (;;) {
      await dormir(4000);
      estado.sync = await api('/api/sync');
      renderTopo();
      if (!estado.sync.executando) break;

      // A tabela enche aos poucos durante a leitura: recarrega quando chegaram pedidos novos,
      // exceto se alguém estiver digitando (recarregar tiraria o cursor da célula).
      const lidos = estado.sync.ultima?.pedidosLidos || 0;
      const digitando = document.activeElement?.closest?.('#linhas');
      if (lidos > jaMostrados && !digitando && salvandoAgora === 0) {
        await carregar({ silencioso: true });
        jaMostrados = estado.pedidos.length;
      }
    }
    await carregar({ silencioso: true });
  } catch (erro) {
    aviso(`Não foi possível acompanhar a sincronização: ${erro.message}`);
  } finally {
    acompanhando = false;
  }
}

$('btn-sync').addEventListener('click', async () => {
  try {
    aviso('');
    await api('/api/sync', { method: 'POST' });
    estado.sync.executando = true;
    acompanharSync();
  } catch (erro) {
    aviso(`Não foi possível iniciar a sincronização: ${erro.message}`);
  }
});

// ---------------------------------------------------------------- navegação e filtros
function mostrarView(qual, { rolarTopo = true } = {}) {
  $('view-dashboard').hidden = qual !== 'dashboard';
  $('view-tabela').hidden = qual !== 'tabela';
  document.querySelectorAll('.navtab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === qual)));
  $('crumb').textContent = qual === 'dashboard' ? 'Dashboard' : 'Tabela de pedidos';
  if (rolarTopo) window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Clicar num pedido do dashboard abre ele na tabela: limpa filtros que poderiam escondê-lo, mostra a tabela,
// rola até a linha e a destaca por alguns segundos.
function abrirPedidoNaTabela(id) {
  if (!estado.pedidos.some((x) => x.nomusId === id)) return;

  estado.filtro = 'todos';
  estado.busca = '';
  estado.status = 'todos';
  $('busca').value = '';
  renderDashboard();
  renderFiltroStatus();
  renderTabela();
  mostrarView('tabela', { rolarTopo: false });

  const tr = document.querySelector(`#linhas tr[data-id="${id}"]`);
  if (!tr) return;
  tr.scrollIntoView({ block: 'center' });
  tr.classList.add('destaque');
  tr.querySelector('select, input')?.focus({ preventScroll: true });
  setTimeout(() => tr.classList.remove('destaque'), 3000);
}

document.addEventListener('click', (e) => {
  const item = e.target.closest('[data-abrir]');
  if (item) abrirPedidoNaTabela(Number(item.dataset.abrir));
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const item = e.target.closest?.('[data-abrir]');
  if (!item) return;
  e.preventDefault();
  abrirPedidoNaTabela(Number(item.dataset.abrir));
});

document.querySelector('.navtabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) mostrarView(b.dataset.view);
});

document.querySelectorAll('.stat').forEach((el) =>
  el.addEventListener('click', () => {
    estado.filtro = el.dataset.filtro;
    renderDashboard();
    renderTabela();
    mostrarView('tabela');
  })
);

$('busca').addEventListener('input', (e) => {
  estado.busca = e.target.value;
  renderTabela();
});

$('filtro-status').addEventListener('change', (e) => {
  estado.status = e.target.value;
  renderTabela();
});

// Traz o que o sincronizador agendado gravou, sem interromper quem está digitando.
setInterval(() => {
  const editando = document.activeElement?.closest?.('#linhas') || salvandoAgora > 0;
  if (!editando && !document.hidden) carregar({ silencioso: true });
}, 60_000);

carregar();
