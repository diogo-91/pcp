import { hojeEmSaoPaulo, somarDias } from "../prazo";
import { derivarItem, recalcularConsumosDoItem } from "./derivar";
import {
  CATEGORIAS,
  CATEGORIA_ROTULO,
  CATEGORIAS_DE_TELHA,
  SITUACAO_GRUPO,
  SITUACAO_ROTULO,
  SITUACOES,
  SITUACOES_ENCERRADAS,
  SITUACOES_EXCLUIDAS_DOS_TOTAIS,
  TIPOS_PINTURA,
  TRAPEZIOS,
  type Categoria,
  type Situacao,
} from "./enums";
import type { ItemProg, OpItem, PedidoProg, ProgramacaoRepository } from "./repo";
import {
  chaveCidade,
  dataValida,
  exigenciasDaSituacao,
  liberadoAposPrazo,
  mascararTelefone,
  mesDe,
  metrosDeTelha,
  normalizarSituacao,
  programadoAntesDoPrazo,
  prazoVigente,
  prontaEntrega,
  rotuloMes,
  situacaoDoPedido,
  statusDePrazo,
  validarCronologia,
  type Medida,
  type StatusPrazo,
} from "./regras";

export type Perfil = "completo" | "consulta";

export class ErroDeValidacao extends Error {
  constructor(
    mensagem: string,
    public readonly codigo = 400
  ) {
    super(mensagem);
  }
}

export interface Alerta {
  codigo: string;
  texto: string;
}

export interface ItemView {
  id: number;
  pedidoId: number;
  nomusPedidoId: number;
  numeroPedido: number;
  itemSeq: string;
  cliente: string;
  telefone: string | null;
  cidade: string;
  uf: string;
  rota: { id: number; nome: string } | null;
  prazoVigente: string | null;
  prazoOriginal: string | null;
  prazoNegociado: string | null;
  statusPrazo: StatusPrazo;
  situacao: Situacao;
  situacaoRotulo: string;
  grupo: string;
  categoria: Categoria;
  categoriaRotulo: string;
  produtoDescricao: string;
  infoAdicional: string;
  tipoPintura: string | null;
  cor: { id: number; nome: string } | null;
  trapezio: string | null;
  facesPintura: number;
  medidas: Medida[];
  medidasTexto: string;
  medidasOrigem: string;
  quantidade: number | null;
  metrosTelha: number;
  metrosChapa: number;
  ops: Array<{ numero: string; status: string; inicioPlanejado: string | null }>;
  dataProgramacao: string | null;
  dataLiberacaoProducao: string | null;
  dataProduzida: string | null;
  dataEntregaRealizada: string | null;
  fornecedorTerceiro: string;
  dataEntregaTerceiro: string | null;
  /** Valor do PEDIDO (não do item): some uma vez por pedido. */
  valorPedido: number | null;
  observacao: string;
  prontaEntrega: boolean;
  programadoAntesDoPrazo: boolean;
  liberadoAposPrazo: boolean;
  mesVenda: string | null;
  mesEntrega: string | null;
  mesProducao: string | null;
  mesVendaRotulo: string;
  mesEntregaRotulo: string;
  mesProducaoRotulo: string;
  consumos: Array<{ material: string; nome: string; quantidade: number; unidade: string; origem: string; cor: string | null }>;
  camposManuais: string[];
  alertas: Alerta[];
  alteradoNoErp: boolean;
  removidoNoErp: boolean;
}

export interface FiltrosProgramacao {
  visao?: string;
  situacao?: string[];
  statusPrazo?: string[];
  rota?: string[];
  produto?: string[];
  tipo?: string[];
  cor?: string[];
  campoData?: string;
  de?: string;
  ate?: string;
  soAlertas?: boolean;
  q?: string;
}

export const VISOES = [
  { id: "em_aberto", rotulo: "Em aberto" },
  { id: "atrasados", rotulo: "Atrasados" },
  { id: "programacao_semana", rotulo: "Programação da semana" },
  { id: "produzidos_aguardando_entrega", rotulo: "Produzidos aguardando entrega" },
  { id: "liberados_apos_prazo", rotulo: "Liberados após o prazo" },
  { id: "todos", rotulo: "Todos" },
] as const;

const ORDEM_STATUS_PRAZO: Record<string, number> = {
  atrasado: 0,
  vence_em_breve: 1,
  a_vencer: 2,
  sem_data: 3,
  entregue_com_atraso: 4,
  entregue_no_prazo: 5,
  entregue: 5,
  na: 6,
};

const mediana = (nums: number[]): number | null => {
  if (nums.length === 0) return null;
  const o = [...nums].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
};

const reais = (centavos: number | null) => (centavos === null ? null : centavos / 100);
const somaReais = (centavos: number) => Math.round(centavos) / 100;

export const medidasEmTexto = (m: Medida[]) => m.map((x) => `${x.qtd}×${String(x.comprimento_m).replace(".", ",")}`).join(" + ");

/** Segunda a domingo da semana de `hoje` (AAAA-MM-DD). */
function semanaDe(hoje: string): { de: string; ate: string } {
  const [a, m, d] = hoje.split("-").map(Number);
  const dow = new Date(Date.UTC(a, m - 1, d)).getUTCDay(); // 0 = domingo
  const desdeSegunda = (dow + 6) % 7;
  return { de: somarDias(hoje, -desdeSegunda) as string, ate: somarDias(hoje, 6 - desdeSegunda) as string };
}

const listaOuNada = (v: string | undefined): string[] | undefined => {
  const l = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return l.length ? l : undefined;
};

/** Converte a query string da API nos filtros. */
export function filtrosDaQuery(query: Record<string, string | undefined>): FiltrosProgramacao {
  return {
    visao: query.visao,
    situacao: listaOuNada(query.situacao),
    statusPrazo: listaOuNada(query.statusPrazo),
    rota: listaOuNada(query.rota),
    produto: listaOuNada(query.produto),
    tipo: listaOuNada(query.tipo),
    cor: listaOuNada(query.cor),
    campoData: query.campoData,
    de: query.de,
    ate: query.ate,
    soAlertas: query.soAlertas === "1",
    q: query.q,
  };
}

export interface EdicaoItem {
  situacao?: string;
  dataProgramacao?: string | null;
  dataLiberacaoProducao?: string | null;
  dataProduzida?: string | null;
  dataEntregaRealizada?: string | null;
  fornecedorTerceiro?: string;
  dataEntregaTerceiro?: string | null;
  categoria?: string;
  tipoPintura?: string | null;
  corId?: number | null;
  facesPintura?: number;
  trapezio?: string | null;
  medidas?: Array<{ qtd: number; comprimento_m: number }>;
  metrosChapa?: number;
  /** Volta estes campos derivados para o cálculo automático (desfaz a correção manual). */
  resetar?: string[];
  reconhecerAlteracaoErp?: boolean;
}

export interface EdicaoPedido {
  dataEntregaNegociada?: string | null;
  observacao?: string;
  rotaId?: number | null;
  /** Grava cidade → rota para os próximos pedidos dessa cidade. */
  lembrarCidade?: boolean;
}

const CAMPOS_DERIVADOS_EDITAVEIS = ["categoria", "tipoPintura", "corId", "facesPintura", "trapezio", "medidas", "metrosChapa"] as const;

export class ProgramacaoService {
  constructor(
    private readonly repo: ProgramacaoRepository,
    private readonly agora: () => Date = () => new Date()
  ) {}

  hoje(): string {
    return hojeEmSaoPaulo(this.agora());
  }

  // ---------------------------------------------------------------- montagem das linhas

  private contexto() {
    const rotas = new Map(this.repo.rotas().map((r) => [r.id, r]));
    const cores = new Map(this.repo.cores().map((c) => [c.id, c]));
    const materiais = new Map(this.repo.materiais().map((m) => [m.codigo, m]));
    const ops = new Map<number, OpItem[]>();
    for (const o of this.repo.todasAsOps()) ops.set(o.itemId, [...(ops.get(o.itemId) ?? []), o]);
    const consumos = new Map<number, ReturnType<ProgramacaoRepository["todosOsConsumos"]>>();
    for (const c of this.repo.todosOsConsumos()) consumos.set(c.itemId, [...(consumos.get(c.itemId) ?? []), c]);
    return { rotas, cores, materiais, ops, consumos, diasBreve: this.repo.parametro("dias_vence_em_breve") };
  }

  private montarItem(item: ItemProg, pedido: PedidoProg, ctx: ReturnType<ProgramacaoService["contexto"]>, hoje: string, perfil: Perfil): ItemView {
    const prazo = prazoVigente(pedido.dataEntregaNegociada, pedido.dataEntregaOriginal);
    const statusPrazo = statusDePrazo({
      situacao: item.situacao,
      prazoVigente: prazo,
      dataEntregaRealizada: item.dataEntregaRealizada,
      hoje,
      diasVenceEmBreve: ctx.diasBreve,
    });
    const rota = pedido.rotaId !== null ? (ctx.rotas.get(pedido.rotaId) ?? null) : null;
    const cor = item.corId !== null ? (ctx.cores.get(item.corId) ?? null) : null;
    const encerrado = SITUACOES_ENCERRADAS.includes(item.situacao);
    const ehTelha = CATEGORIAS_DE_TELHA.includes(item.categoria);

    const alertas: Alerta[] = [];
    if (!encerrado) {
      if (!rota) alertas.push({ codigo: "sem_rota", texto: pedido.cidade ? `Sem rota para ${pedido.cidade}` : "Pedido sem cidade/rota" });
      if (item.dataProgramacao && item.dataProgramacao < hoje && (item.situacao === "PROGRAMAR" || item.situacao === "PROGRAMADO")) {
        alertas.push({ codigo: "programacao_vencida", texto: "Data de programação já passou e o item ainda não entrou em produção" });
      }
      if (ehTelha && (item.medidasOrigem === "nenhuma" || item.medidasOrigem === "quantidade")) {
        alertas.push({
          codigo: "medidas_pendentes",
          texto: item.medidasOrigem === "nenhuma" ? "Sem medidas: informe o comprimento das peças" : "Metragem tirada só da quantidade: confira as medidas",
        });
      }
      if (ehTelha && item.medidasOrigem === "nomus" && item.quantidade && Math.abs(item.metrosTelha - item.quantidade) > Math.max(0.5, item.quantidade * 0.05)) {
        alertas.push({ codigo: "medidas_divergem", texto: `Medidas somam ${item.metrosTelha} m e a quantidade do pedido é ${item.quantidade}` });
      }
    }
    if (item.alteradoNoErp) alertas.push({ codigo: "alterado_erp", texto: "Pedido alterado no ERP após programação" });
    if (item.removidoNoErp) alertas.push({ codigo: "removido_erp", texto: "Item não existe mais no pedido da Nomus" });
    if (item.situacao === "CANCELADO" && item.dataProduzida) alertas.push({ codigo: "cancelado_com_producao", texto: "Cancelado depois de produzido (produção perdida)" });

    const mesVenda = mesDe(pedido.dataPedido);
    const mesEntrega = mesDe(prazo);
    const mesProducao = mesDe(item.dataProduzida);

    return {
      id: item.id,
      pedidoId: pedido.id,
      nomusPedidoId: pedido.nomusPedidoId,
      numeroPedido: pedido.numeroPedido,
      itemSeq: item.itemSeq,
      cliente: pedido.clienteNome,
      telefone: perfil === "completo" && pedido.clienteTelefone ? mascararTelefone(pedido.clienteTelefone) : null,
      cidade: pedido.cidade,
      uf: pedido.uf,
      rota: rota ? { id: rota.id, nome: rota.nome } : null,
      prazoVigente: prazo,
      prazoOriginal: pedido.dataEntregaOriginal,
      prazoNegociado: pedido.dataEntregaNegociada,
      statusPrazo,
      situacao: item.situacao,
      situacaoRotulo: SITUACAO_ROTULO[item.situacao] ?? item.situacao,
      grupo: SITUACAO_GRUPO[item.situacao] ?? "aberto",
      categoria: item.categoria,
      categoriaRotulo: CATEGORIA_ROTULO[item.categoria] ?? item.categoria,
      produtoDescricao: item.descricaoProduto,
      infoAdicional: item.infoAdicional,
      tipoPintura: item.tipoPintura,
      cor: cor ? { id: cor.id, nome: cor.nome } : null,
      trapezio: item.trapezio,
      facesPintura: item.facesPintura,
      medidas: item.medidas,
      medidasTexto: medidasEmTexto(item.medidas),
      medidasOrigem: item.medidasOrigem,
      quantidade: item.quantidade,
      metrosTelha: item.metrosTelha,
      metrosChapa: item.metrosChapa,
      ops: (ctx.ops.get(item.id) ?? []).map((o) => ({ numero: o.numeroOp, status: o.statusOp, inicioPlanejado: o.inicioPlanejado })),
      dataProgramacao: item.dataProgramacao,
      dataLiberacaoProducao: item.dataLiberacaoProducao,
      dataProduzida: item.dataProduzida,
      dataEntregaRealizada: item.dataEntregaRealizada,
      fornecedorTerceiro: item.fornecedorTerceiro,
      dataEntregaTerceiro: item.dataEntregaTerceiro,
      valorPedido: reais(pedido.valorCentavos),
      observacao: pedido.observacao,
      prontaEntrega: prontaEntrega(item.dataProduzida, prazo),
      programadoAntesDoPrazo: programadoAntesDoPrazo(item.dataProgramacao, prazo),
      liberadoAposPrazo: liberadoAposPrazo(item.dataLiberacaoProducao, prazo),
      mesVenda,
      mesEntrega,
      mesProducao,
      mesVendaRotulo: rotuloMes(mesVenda),
      mesEntregaRotulo: rotuloMes(mesEntrega),
      mesProducaoRotulo: rotuloMes(mesProducao),
      consumos: (ctx.consumos.get(item.id) ?? []).map((c) => ({
        material: c.material,
        nome: ctx.materiais.get(c.material)?.nome ?? c.material,
        quantidade: c.quantidade,
        unidade: c.unidade,
        origem: c.origem,
        cor: c.corId !== null ? (ctx.cores.get(c.corId)?.nome ?? null) : null,
      })),
      camposManuais: item.camposManuais,
      alertas,
      alteradoNoErp: item.alteradoNoErp,
      removidoNoErp: item.removidoNoErp,
    };
  }

  /** Todas as linhas (sem filtro). */
  todasAsLinhas(perfil: Perfil): ItemView[] {
    const hoje = this.hoje();
    const ctx = this.contexto();
    const pedidos = new Map(this.repo.listarPedidos().map((p) => [p.id, p]));
    const linhas: ItemView[] = [];
    for (const item of this.repo.listarItens()) {
      const pedido = pedidos.get(item.pedidoId);
      if (pedido) linhas.push(this.montarItem(item, pedido, ctx, hoje, perfil));
    }
    return linhas;
  }

  // ---------------------------------------------------------------- filtros

  filtrar(linhas: ItemView[], f: FiltrosProgramacao, hoje: string): ItemView[] {
    const visao = f.visao ?? (f.situacao ? "todos" : "em_aberto");
    const semana = semanaDe(hoje);
    const q = f.q?.trim().toLowerCase();

    const campoData = (l: ItemView): string | null => {
      switch (f.campoData) {
        case "programacao": return l.dataProgramacao;
        case "producao": return l.dataProduzida;
        case "entrega": return l.dataEntregaRealizada;
        default: return l.prazoVigente;
      }
    };

    return linhas
      .filter((l) => {
        switch (visao) {
          case "em_aberto": if (SITUACOES_ENCERRADAS.includes(l.situacao)) return false; break;
          case "atrasados": if (l.statusPrazo.codigo !== "atrasado") return false; break;
          case "programacao_semana":
            if (SITUACOES_ENCERRADAS.includes(l.situacao) || !l.dataProgramacao || l.dataProgramacao < semana.de || l.dataProgramacao > semana.ate) return false;
            break;
          case "produzidos_aguardando_entrega": if (!["PRODUZIDO", "EXPEDICAO", "EM_TRANSITO"].includes(l.situacao)) return false; break;
          case "liberados_apos_prazo": if (!l.liberadoAposPrazo || SITUACOES_EXCLUIDAS_DOS_TOTAIS.includes(l.situacao)) return false; break;
        }
        if (f.situacao && !f.situacao.includes(l.situacao)) return false;
        if (f.statusPrazo && !f.statusPrazo.includes(l.statusPrazo.codigo)) return false;
        if (f.rota && !f.rota.includes(l.rota ? String(l.rota.id) : "sem")) return false;
        if (f.produto && !f.produto.includes(l.categoria)) return false;
        if (f.tipo && !f.tipo.includes(l.tipoPintura ?? "")) return false;
        if (f.cor && !f.cor.includes(l.cor ? String(l.cor.id) : "")) return false;
        if (f.de || f.ate) {
          const d = campoData(l);
          if (!d || (f.de && d < f.de) || (f.ate && d > f.ate)) return false;
        }
        if (f.soAlertas && l.alertas.length === 0) return false;
        if (q) {
          const alvo = [String(l.numeroPedido), l.cliente, l.cidade, l.produtoDescricao, l.infoAdicional, ...l.ops.map((o) => o.numero)].join(" ").toLowerCase();
          if (!alvo.includes(q)) return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          (ORDEM_STATUS_PRAZO[a.statusPrazo.codigo] ?? 9) - (ORDEM_STATUS_PRAZO[b.statusPrazo.codigo] ?? 9) ||
          (a.prazoVigente ?? "9999").localeCompare(b.prazoVigente ?? "9999") ||
          a.numeroPedido - b.numeroPedido ||
          a.itemSeq.localeCompare(b.itemSeq)
      );
  }

  /** Totais do rodapé: respeitam os filtros, excluem cancelado/devolução e somam o valor UMA vez por pedido. */
  totais(linhas: ItemView[]) {
    const validas = linhas.filter((l) => !SITUACOES_EXCLUIDAS_DOS_TOTAIS.includes(l.situacao));
    const valorPorPedido = new Map<number, number>();
    for (const l of validas) if (l.valorPedido !== null) valorPorPedido.set(l.pedidoId, l.valorPedido);
    return {
      itens: validas.length,
      pedidos: new Set(validas.map((l) => l.pedidoId)).size,
      metrosChapa: Math.round(validas.reduce((s, l) => s + l.metrosChapa, 0) * 100) / 100,
      metrosTelha: Math.round(validas.reduce((s, l) => s + l.metrosTelha, 0) * 100) / 100,
      valor: somaReais([...valorPorPedido.values()].reduce((s, v) => s + Math.round(v * 100), 0)),
    };
  }

  /** Indicadores do topo: sobre todos os itens, sempre sem cancelados/devolvidos. */
  indicadores(todas: ItemView[], hoje: string) {
    const vivas = todas.filter((l) => !SITUACOES_EXCLUIDAS_DOS_TOTAIS.includes(l.situacao));
    const emAberto = vivas.filter((l) => !SITUACOES_ENCERRADAS.includes(l.situacao));
    const atrasados = emAberto.filter((l) => l.statusPrazo.codigo === "atrasado");

    const valorDistinto = (ls: ItemView[]) => {
      const m = new Map<number, number>();
      for (const l of ls) if (l.valorPedido !== null) m.set(l.pedidoId, l.valorPedido);
      return somaReais([...m.values()].reduce((s, v) => s + Math.round(v * 100), 0));
    };

    const mesAtual = hoje.slice(0, 7);
    const entreguesNoMes = vivas.filter((l) => l.situacao === "ENTREGUE" && mesDe(l.dataEntregaRealizada) === mesAtual);
    const noPrazo = entreguesNoMes.filter((l) => l.statusPrazo.codigo === "entregue_no_prazo").length;

    const comLiberacao = vivas.filter((l) => l.dataLiberacaoProducao && l.prazoVigente);
    const aposPrazo = comLiberacao.filter((l) => l.liberadoAposPrazo).length;

    return {
      itensEmAberto: emAberto.length,
      metrosEmAberto: Math.round(emAberto.reduce((s, l) => s + l.metrosChapa, 0) * 100) / 100,
      valorEmAberto: valorDistinto(emAberto),
      atrasados: {
        itens: atrasados.length,
        valor: valorDistinto(atrasados),
        diasMediano: mediana(atrasados.map((l) => l.statusPrazo.dias ?? 0)),
      },
      pontualidadeMes: { entregues: entreguesNoMes.length, noPrazo, percentual: entreguesNoMes.length ? Math.round((noPrazo / entreguesNoMes.length) * 100) : null },
      liberadosAposPrazo: { itens: aposPrazo, base: comLiberacao.length, percentual: comLiberacao.length ? Math.round((aposPrazo / comLiberacao.length) * 100) : null },
    };
  }

  listar(filtros: FiltrosProgramacao, perfil: Perfil) {
    const hoje = this.hoje();
    const todas = this.todasAsLinhas(perfil);
    const itens = this.filtrar(todas, filtros, hoje);
    return {
      hoje,
      perfil,
      itens,
      totais: this.totais(itens),
      indicadores: this.indicadores(todas, hoje),
      totalGeral: todas.length,
      opcoes: this.opcoes(),
      sync: this.repo.ultimaSyncProgramacao(),
    };
  }

  opcoes() {
    return {
      visoes: VISOES,
      situacoes: SITUACOES.map((s) => ({ valor: s, rotulo: SITUACAO_ROTULO[s], grupo: SITUACAO_GRUPO[s] })),
      categorias: CATEGORIAS.map((c) => ({ valor: c, rotulo: CATEGORIA_ROTULO[c] })),
      tiposPintura: TIPOS_PINTURA,
      trapezios: TRAPEZIOS,
      rotas: this.repo.rotas(),
      cores: this.repo.cores().map((c) => ({ id: c.id, nome: c.nome })),
      materiais: this.repo.materiais(),
      statusPrazo: [
        { valor: "atrasado", rotulo: "Atrasado" },
        { valor: "vence_em_breve", rotulo: "Vence em breve" },
        { valor: "a_vencer", rotulo: "A vencer" },
        { valor: "sem_data", rotulo: "Sem data" },
        { valor: "entregue_no_prazo", rotulo: "Entregue no prazo" },
        { valor: "entregue_com_atraso", rotulo: "Entregue com atraso" },
      ],
    };
  }

  // ---------------------------------------------------------------- detalhe

  detalhe(pedidoId: number, perfil: Perfil) {
    const pedido = this.repo.buscarPedido(pedidoId);
    if (!pedido) return null;
    const hoje = this.hoje();
    const ctx = this.contexto();
    const itens = this.repo.itensDoPedido(pedidoId).map((i) => this.montarItem(i, pedido, ctx, hoje, perfil));
    const nomeRota = pedido.rotaId !== null ? (ctx.rotas.get(pedido.rotaId)?.nome ?? null) : null;
    return {
      hoje,
      perfil,
      pedido: {
        id: pedido.id,
        nomusPedidoId: pedido.nomusPedidoId,
        numeroPedido: pedido.numeroPedido,
        dataPedido: pedido.dataPedido,
        cliente: pedido.clienteNome,
        telefone: perfil === "completo" && pedido.clienteTelefone ? mascararTelefone(pedido.clienteTelefone) : null,
        cidade: pedido.cidade,
        uf: pedido.uf,
        rotaId: pedido.rotaId,
        rotaNome: nomeRota,
        rotaManual: pedido.rotaManual,
        prazoOriginal: pedido.dataEntregaOriginal,
        prazoNegociado: pedido.dataEntregaNegociada,
        prazoVigente: prazoVigente(pedido.dataEntregaNegociada, pedido.dataEntregaOriginal),
        valor: reais(pedido.valorCentavos),
        observacao: pedido.observacao,
        situacao: situacaoDoPedido(itens.map((i) => i.situacao)),
        atualizadoEm: pedido.updatedAt,
        atualizadoPor: pedido.updatedBy,
      },
      itens,
      eventos: this.repo.eventosDoPedido(pedidoId),
      opcoes: this.opcoes(),
    };
  }

  // ---------------------------------------------------------------- edição

  private nomeUsuario(usuario: string | undefined): string {
    return (usuario ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, 60) || "PCP";
  }

  /**
   * Valida a edição de um item e devolve o que será gravado (sem gravar). Lança ErroDeValidacao com mensagem clara.
   * Separado de `aplicarEdicaoItem` para a edição em massa validar tudo antes de gravar qualquer coisa.
   */
  private prepararEdicaoItem(itemId: number, e: EdicaoItem) {
    const item = this.repo.buscarItem(itemId);
    if (!item) throw new ErroDeValidacao("Item não encontrado.", 404);
    const hoje = this.hoje();

    const datasEditadas = ["dataProgramacao", "dataLiberacaoProducao", "dataProduzida", "dataEntregaRealizada", "dataEntregaTerceiro"] as const;
    const proxima: Record<string, string | null> = {
      dataProgramacao: item.dataProgramacao,
      dataLiberacaoProducao: item.dataLiberacaoProducao,
      dataProduzida: item.dataProduzida,
      dataEntregaRealizada: item.dataEntregaRealizada,
      dataEntregaTerceiro: item.dataEntregaTerceiro,
    };
    for (const campo of datasEditadas) {
      if (!(campo in e)) continue;
      const v = e[campo];
      if (v !== null && v !== undefined && (typeof v !== "string" || !dataValida(v))) {
        throw new ErroDeValidacao(`Data inválida em ${campo}: use AAAA-MM-DD (ano entre 2000 e 2100).`);
      }
      proxima[campo] = v ?? null;
    }

    let situacao = item.situacao;
    if (e.situacao !== undefined) {
      const s = normalizarSituacao(e.situacao);
      if (!s) throw new ErroDeValidacao(`Situação inválida: "${e.situacao}".`);
      situacao = s;
    }
    // Entregue sem data: assume hoje (editável depois). Produzido exige a data informada.
    if (situacao === "ENTREGUE" && !proxima.dataEntregaRealizada) proxima.dataEntregaRealizada = hoje;
    const exigencia = exigenciasDaSituacao(situacao, { dataProduzida: proxima.dataProduzida, dataEntregaRealizada: proxima.dataEntregaRealizada });
    if (exigencia) throw new ErroDeValidacao(exigencia);
    const cron = validarCronologia({
      dataLiberacaoProducao: proxima.dataLiberacaoProducao,
      dataProduzida: proxima.dataProduzida,
      dataEntregaRealizada: proxima.dataEntregaRealizada,
    });
    if (cron) throw new ErroDeValidacao(cron);

    const terceiro = e.fornecedorTerceiro !== undefined ? String(e.fornecedorTerceiro).trim().slice(0, 100) : item.fornecedorTerceiro;

    // Campos derivados corrigidos à mão.
    const manuais = new Set(item.camposManuais);
    for (const r of e.resetar ?? []) manuais.delete(r === "medidas" ? "medidas" : r);
    const atualDerivado: Partial<ItemProg> = { ...item };
    let mudouDerivado = (e.resetar?.length ?? 0) > 0;

    for (const campo of CAMPOS_DERIVADOS_EDITAVEIS) {
      if (!(campo in e)) continue;
      mudouDerivado = true;
      manuais.add(campo);
      const v = (e as Record<string, unknown>)[campo];
      switch (campo) {
        case "categoria":
          if (!CATEGORIAS.includes(v as Categoria)) throw new ErroDeValidacao("Categoria inválida.");
          atualDerivado.categoria = v as Categoria;
          break;
        case "tipoPintura":
          if (v !== null && !(TIPOS_PINTURA as readonly string[]).includes(v as string)) throw new ErroDeValidacao("Tipo de pintura inválido.");
          atualDerivado.tipoPintura = v as ItemProg["tipoPintura"];
          break;
        case "corId":
          if (v !== null && (!Number.isInteger(v) || !this.repo.cores().some((c) => c.id === v))) throw new ErroDeValidacao("Cor inválida.");
          atualDerivado.corId = v as number | null;
          break;
        case "facesPintura":
          if (![0, 1, 2].includes(v as number)) throw new ErroDeValidacao("Faces de pintura deve ser 0, 1 ou 2.");
          atualDerivado.facesPintura = v as number;
          break;
        case "trapezio":
          if (v !== null && !(TRAPEZIOS as readonly string[]).includes(v as string)) throw new ErroDeValidacao("Trapézio inválido (TR25 ou TR40).");
          atualDerivado.trapezio = v as ItemProg["trapezio"];
          break;
        case "medidas": {
          const lista = v as Array<{ qtd: number; comprimento_m: number }>;
          if (!Array.isArray(lista) || lista.some((m) => !Number.isInteger(m?.qtd) || m.qtd <= 0 || !(m?.comprimento_m > 0) || m.comprimento_m > 30)) {
            throw new ErroDeValidacao("Medidas inválidas: informe quantidade inteira e comprimento em metros (até 30).");
          }
          atualDerivado.medidas = lista.map((m) => ({ qtd: m.qtd, comprimento_m: Math.round(m.comprimento_m * 1000) / 1000 }));
          break;
        }
        case "metrosChapa":
          if (typeof v !== "number" || !(v >= 0) || v > 100000) throw new ErroDeValidacao("Metros de chapa inválidos.");
          atualDerivado.metrosChapa = v;
          break;
      }
    }

    return { item, situacao, proxima, terceiro, manuais: [...manuais], atualDerivado, mudouDerivado };
  }

  private gravarEdicaoItem(itemId: number, e: EdicaoItem, prep: ReturnType<ProgramacaoService["prepararEdicaoItem"]>, usuario: string) {
    const { item, situacao, proxima, terceiro } = prep;
    const agora = this.agora().toISOString();
    const campos: Record<string, unknown> = { ...proxima, situacao, fornecedorTerceiro: terceiro };

    let derivadoFinal: ReturnType<typeof derivarItem> | null = null;
    if (prep.mudouDerivado) {
      const produto = item.produtoNomusId !== null ? this.repo.buscarProduto(item.produtoNomusId) : null;
      const entrada = {
        categoria: produto?.categoria ?? item.categoria,
        descricaoProduto: item.descricaoProduto,
        infoAdicional: item.infoAdicional,
        quantidade: item.quantidade,
      };
      const atual = { ...(prep.atualDerivado as ItemProg), camposManuais: prep.manuais };
      derivadoFinal = derivarItem(entrada, this.repo.cores(), this.repo.parametro("fator_chapa_sanduiche"), atual);
      Object.assign(campos, {
        categoria: derivadoFinal.categoria, tipoPintura: derivadoFinal.tipoPintura, corId: derivadoFinal.corId,
        facesPintura: derivadoFinal.facesPintura, trapezio: derivadoFinal.trapezio, metrosTelha: derivadoFinal.metrosTelha,
        metrosChapa: derivadoFinal.metrosChapa, medidas: derivadoFinal.medidas, medidasOrigem: derivadoFinal.medidasOrigem,
      });
    }

    this.repo.atualizarItemPcp(itemId, campos, prep.mudouDerivado ? prep.manuais : null, usuario, agora);
    if (e.reconhecerAlteracaoErp) this.repo.limparAlteradoNoErp(itemId);

    // Evento para cada campo que de fato mudou.
    const rotulos: Record<string, unknown> = {
      situacao: [item.situacao, situacao],
      data_programacao: [item.dataProgramacao, proxima.dataProgramacao],
      data_liberacao_producao: [item.dataLiberacaoProducao, proxima.dataLiberacaoProducao],
      data_produzida: [item.dataProduzida, proxima.dataProduzida],
      data_entrega_realizada: [item.dataEntregaRealizada, proxima.dataEntregaRealizada],
      fornecedor_terceiro: [item.fornecedorTerceiro, terceiro],
      data_entrega_terceiro: [item.dataEntregaTerceiro, proxima.dataEntregaTerceiro],
    };
    if (derivadoFinal) {
      Object.assign(rotulos, {
        categoria: [item.categoria, derivadoFinal.categoria],
        tipo_pintura: [item.tipoPintura, derivadoFinal.tipoPintura],
        cor_id: [item.corId, derivadoFinal.corId],
        faces_pintura: [item.facesPintura, derivadoFinal.facesPintura],
        trapezio: [item.trapezio, derivadoFinal.trapezio],
        metros_chapa: [item.metrosChapa, derivadoFinal.metrosChapa],
        metros_telha: [item.metrosTelha, derivadoFinal.metrosTelha],
      });
    }
    for (const [campo, [antes, depois]] of Object.entries(rotulos) as Array<[string, [unknown, unknown]]>) {
      if ((antes ?? null) === (depois ?? null)) continue;
      this.repo.registrarEvento({ entidade: "item", entidadeId: itemId, pedidoId: item.pedidoId, campo, valorAntigo: antes, valorNovo: depois, usuario, em: agora });
    }

    const atualizado = this.repo.buscarItem(itemId);
    if (atualizado) recalcularConsumosDoItem(this.repo, atualizado, agora);
  }

  editarItem(itemId: number, e: EdicaoItem, usuario?: string): void {
    const nome = this.nomeUsuario(usuario);
    this.repo.transacao(() => {
      const prep = this.prepararEdicaoItem(itemId, e);
      this.gravarEdicaoItem(itemId, e, prep, nome);
    });
  }

  /** Edição em massa: valida todos os itens antes; se algum falhar, nada é gravado. */
  editarEmLote(ids: number[], e: EdicaoItem & { rotaId?: number | null }, usuario?: string): { atualizados: number } {
    if (!Array.isArray(ids) || ids.length === 0) throw new ErroDeValidacao("Selecione ao menos um item.");
    if (ids.length > 500) throw new ErroDeValidacao("Máximo de 500 itens por vez.");
    const nome = this.nomeUsuario(usuario);
    const { rotaId, ...edicaoItem } = e;
    const temEdicaoItem = Object.keys(edicaoItem).length > 0;

    return this.repo.transacao(() => {
      const preparos = temEdicaoItem ? ids.map((id) => ({ id, prep: this.prepararEdicaoItem(id, edicaoItem) })) : [];
      if (!temEdicaoItem && rotaId === undefined) throw new ErroDeValidacao("Informe o que alterar.");
      for (const p of preparos) this.gravarEdicaoItem(p.id, edicaoItem, p.prep, nome);

      if (rotaId !== undefined) {
        const pedidos = new Set<number>();
        for (const id of ids) {
          const it = this.repo.buscarItem(id);
          if (!it) throw new ErroDeValidacao("Item não encontrado.", 404);
          pedidos.add(it.pedidoId);
        }
        for (const pid of pedidos) this.aplicarEdicaoPedido(pid, { rotaId }, nome);
      }
      return { atualizados: ids.length };
    });
  }

  private aplicarEdicaoPedido(pedidoId: number, e: EdicaoPedido, nome: string): void {
    const pedido = this.repo.buscarPedido(pedidoId);
    if (!pedido) throw new ErroDeValidacao("Pedido não encontrado.", 404);
    const agora = this.agora().toISOString();
    const campos: Parameters<ProgramacaoRepository["atualizarPedidoPcp"]>[1] = {};
    const eventos: Array<[string, unknown, unknown]> = [];

    if ("dataEntregaNegociada" in e) {
      const v = e.dataEntregaNegociada ?? null;
      if (v !== null && (typeof v !== "string" || !dataValida(v))) throw new ErroDeValidacao("Data de negociação inválida: use AAAA-MM-DD.");
      if (v !== pedido.dataEntregaNegociada) {
        campos.dataEntregaNegociada = v;
        eventos.push(["data_entrega_cliente_negociada", pedido.dataEntregaNegociada, v]);
      }
    }
    if ("observacao" in e) {
      const v = String(e.observacao ?? "").trim();
      if (v.length > 4000) throw new ErroDeValidacao("Observação muito longa (máximo 4000 caracteres).");
      if (v !== pedido.observacao) {
        campos.observacao = v;
        eventos.push(["observacao", pedido.observacao.slice(0, 2000), v.slice(0, 2000)]);
      }
    }
    if ("rotaId" in e) {
      const v = e.rotaId ?? null;
      if (v !== null && !this.repo.rotas().some((r) => r.id === v)) throw new ErroDeValidacao("Rota inválida.");
      if (v !== pedido.rotaId || !pedido.rotaManual) {
        campos.rotaId = v;
        campos.rotaManual = v !== null; // escolher "sem rota" devolve o pedido ao automático
        if (v !== pedido.rotaId) eventos.push(["rota_id", pedido.rotaId, v]);
      }
      if (e.lembrarCidade && v !== null && pedido.cidade) this.repo.salvarCidadeRota(chaveCidade(pedido.cidade), pedido.cidade, v);
    }

    this.repo.atualizarPedidoPcp(pedidoId, campos, nome, agora);
    for (const [campo, antes, depois] of eventos) {
      this.repo.registrarEvento({ entidade: "pedido", entidadeId: pedidoId, pedidoId, campo, valorAntigo: antes, valorNovo: depois, usuario: nome, em: agora });
    }
  }

  editarPedido(pedidoId: number, e: EdicaoPedido, usuario?: string): void {
    const nome = this.nomeUsuario(usuario);
    this.repo.transacao(() => this.aplicarEdicaoPedido(pedidoId, e, nome));
  }

  /** Uma linha já montada (devolvida depois de editar, para a tela atualizar só ela). */
  linha(itemId: number, perfil: Perfil): ItemView | null {
    const item = this.repo.buscarItem(itemId);
    const pedido = item ? this.repo.buscarPedido(item.pedidoId) : null;
    return item && pedido ? this.montarItem(item, pedido, this.contexto(), this.hoje(), perfil) : null;
  }

  parametros() {
    return this.repo.parametros();
  }

  pedido(id: number) {
    return this.repo.buscarPedido(id);
  }

  produtos() {
    return this.repo.listarProdutos().map((p) => ({ ...p, categoriaRotulo: CATEGORIA_ROTULO[p.categoria] ?? p.categoria }));
  }

  // ---------------------------------------------------------------- consumos manuais

  definirConsumoManual(itemId: number, material: string, quantidade: number, corId: number | null, usuario?: string): void {
    const item = this.repo.buscarItem(itemId);
    if (!item) throw new ErroDeValidacao("Item não encontrado.", 404);
    const mat = this.repo.materiais().find((m) => m.codigo === material);
    if (!mat) throw new ErroDeValidacao("Material inválido.");
    if (typeof quantidade !== "number" || !(quantidade >= 0) || quantidade > 1_000_000) throw new ErroDeValidacao("Quantidade inválida.");
    const agora = this.agora().toISOString();
    const nome = this.nomeUsuario(usuario);
    this.repo.transacao(() => {
      this.repo.definirConsumoManual(itemId, material, corId, quantidade, mat.unidade, agora);
      this.repo.registrarEvento({ entidade: "item", entidadeId: itemId, pedidoId: item.pedidoId, campo: `consumo:${material}`, valorAntigo: null, valorNovo: quantidade, usuario: nome, em: agora });
    });
  }

  // ---------------------------------------------------------------- parâmetros e catálogo

  /** Muda um parâmetro e recalcula os itens ainda não produzidos (os produzidos ficam congelados). */
  alterarParametro(chave: string, valor: number, usuario?: string): { recalculados: number } {
    if (typeof valor !== "number" || !Number.isFinite(valor) || valor < 0 || valor > 1_000_000) throw new ErroDeValidacao("Valor inválido.");
    const antigo = this.repo.parametros().find((p) => p.chave === chave);
    if (!antigo) throw new ErroDeValidacao("Parâmetro desconhecido.", 404);
    const nome = this.nomeUsuario(usuario);
    const agora = this.agora().toISOString();

    return this.repo.transacao(() => {
      this.repo.definirParametro(chave, valor);
      this.repo.registrarEvento({ entidade: "parametro", entidadeId: 0, pedidoId: null, campo: chave, valorAntigo: antigo.valor, valorNovo: valor, usuario: nome, em: agora });
      let recalculados = 0;

      if (chave === "fator_chapa_sanduiche") {
        for (const it of this.repo.listarItens()) {
          if (it.categoria !== "SANDUICHE" || it.camposManuais.includes("metrosChapa") || SITUACOES_ENCERRADAS.includes(it.situacao)) continue;
          const chapa = Math.round(it.metrosTelha * valor * 100) / 100;
          if (chapa !== it.metrosChapa) this.repo.atualizarItemPcp(it.id, { metrosChapa: chapa }, null, nome, agora);
        }
      }
      for (const it of this.repo.listarItens()) {
        const atual = this.repo.buscarItem(it.id);
        if (atual && recalcularConsumosDoItem(this.repo, atual, agora)) recalculados++;
      }
      return { recalculados };
    });
  }

  /** Corrige a categoria de um produto da Nomus (de-para) e refaz os itens que o usam. */
  definirCategoriaDoProduto(produtoNomusId: number, categoria: string, usuario?: string): { itensAfetados: number } {
    if (!CATEGORIAS.includes(categoria as Categoria)) throw new ErroDeValidacao("Categoria inválida.");
    if (!this.repo.buscarProduto(produtoNomusId)) throw new ErroDeValidacao("Produto não encontrado.", 404);
    const nome = this.nomeUsuario(usuario);
    const agora = this.agora().toISOString();
    return this.repo.transacao(() => {
      this.repo.definirCategoriaProduto(produtoNomusId, categoria as Categoria);
      let afetados = 0;
      const cores = this.repo.cores();
      const fator = this.repo.parametro("fator_chapa_sanduiche");
      for (const it of this.repo.listarItens().filter((i) => i.produtoNomusId === produtoNomusId)) {
        const derivado = derivarItem(
          { categoria: categoria as Categoria, descricaoProduto: it.descricaoProduto, infoAdicional: it.infoAdicional, quantidade: it.quantidade },
          cores, fator, it
        );
        this.repo.atualizarItemDerivado(it.id, derivado, agora, nome);
        if (derivado.categoria !== it.categoria) {
          this.repo.registrarEvento({ entidade: "item", entidadeId: it.id, pedidoId: it.pedidoId, campo: "categoria", valorAntigo: it.categoria, valorNovo: derivado.categoria, usuario: nome, em: agora });
        }
        const novo = this.repo.buscarItem(it.id);
        if (novo) recalcularConsumosDoItem(this.repo, novo, agora);
        afetados++;
      }
      return { itensAfetados: afetados };
    });
  }

  /** Cidade → rota: grava e aplica aos pedidos da cidade que ainda não tiveram rota escolhida à mão. */
  definirRotaDaCidade(cidade: string, rotaId: number): { pedidosAfetados: number } {
    const nome = String(cidade ?? "").trim();
    if (!nome) throw new ErroDeValidacao("Informe a cidade.");
    if (!this.repo.rotas().some((r) => r.id === rotaId)) throw new ErroDeValidacao("Rota inválida.");
    const chave = chaveCidade(nome);
    return this.repo.transacao(() => {
      this.repo.salvarCidadeRota(chave, nome, rotaId);
      return { pedidosAfetados: this.repo.aplicarRotaNaCidade(chaveCidade, chave, rotaId) };
    });
  }

  // ---------------------------------------------------------------- exportação

  exportarCsv(filtros: FiltrosProgramacao, perfil: Perfil): string {
    const hoje = this.hoje();
    const itens = this.filtrar(this.todasAsLinhas(perfil), filtros, hoje);
    const cab = [
      "Pedido", "Item", "Cliente", "Telefone", "Cidade", "Rota", "Prazo vigente", "Status de prazo", "Situação", "Produto", "Tipo", "Cor",
      "TR", "Faces", "Medidas", "Metros telha", "Metros chapa", "OPs", "Data programação", "Data liberação", "Data produzida", "Data entrega",
      "Valor do pedido", "Observação", "Alertas",
    ];
    const br = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : "");
    const num = (n: number | null) => (n === null ? "" : String(n).replace(".", ","));
    const esc = (v: unknown) => {
      let s = String(v ?? "");
      // Evita que o Excel execute o texto como fórmula (=, +, -, @ no começo).
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const linhas = itens.map((l) =>
      [
        l.numeroPedido, l.itemSeq, l.cliente, l.telefone ?? "", l.cidade, l.rota?.nome ?? "", br(l.prazoVigente), l.statusPrazo.texto, l.situacaoRotulo,
        l.categoriaRotulo, l.tipoPintura ?? "", l.cor?.nome ?? "", l.trapezio ?? "", l.facesPintura, l.medidasTexto, num(l.metrosTelha), num(l.metrosChapa),
        l.ops.map((o) => o.numero).join(", "), br(l.dataProgramacao), br(l.dataLiberacaoProducao), br(l.dataProduzida), br(l.dataEntregaRealizada),
        num(l.valorPedido), l.observacao, l.alertas.map((a) => a.texto).join(" | "),
      ].map(esc).join(";")
    );
    return "﻿" + [cab.join(";"), ...linhas].join("\r\n") + "\r\n";
  }
}

export { metrosDeTelha };
