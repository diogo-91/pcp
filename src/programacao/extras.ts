import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "../db";
import { isDataPlausivel, somarDias } from "../prazo";
import {
  COMPRA_STATUS,
  COMPRA_STATUS_FIRMES,
  COMPRA_STATUS_ROTULO,
  COMPRA_TIPOS,
  COMPRA_TIPO_ROTULO,
  FORNECEDORES_INICIAIS,
  SITUACAO_ROTULO,
  SITUACOES,
  SITUACOES_ENCERRADAS,
  SITUACOES_EXCLUIDAS_DOS_TOTAIS,
  SITUACOES_PRODUZIDAS,
  type CompraStatus,
  type CompraTipo,
  type Situacao,
} from "./enums";
import { mascararTelefone, mesDe, metrosDeTelha, prazoVigente, rotuloMes, situacaoDoPedido, type Medida } from "./regras";
import type { ProgramacaoRepository } from "./repo";
import { ErroDeValidacao, medidasEmTexto, type ItemView, type Perfil, type ProgramacaoService } from "./service";

type Linha = Record<string, unknown>;
const arred = (n: number, casas = 2) => Math.round(n * 10 ** casas) / 10 ** casas;

// ============================================================ funções puras (testadas)

/** Dias de trabalho de `de` a `ate`: segunda a sexta, menos os feriados. */
export function diasUteis(de: string, ate: string, feriados: Set<string>): string[] {
  const dias: string[] = [];
  for (let d: string | null = de; d !== null && d <= ate; d = somarDias(d, 1)) {
    const [a, m, dd] = d.split("-").map(Number);
    const dow = new Date(Date.UTC(a, m - 1, dd)).getUTCDay();
    if (dow !== 0 && dow !== 6 && !feriados.has(d)) dias.push(d);
    if (dias.length > 4000) break; // proteção contra intervalos absurdos
  }
  return dias;
}

export type NivelOcupacao = "verde" | "amarelo" | "vermelho";
/** Verde até 80% da capacidade, amarelo até 100%, vermelho acima. */
export const nivelDeOcupacao = (pct: number): NivelOcupacao => (pct <= 80 ? "verde" : pct <= 100 ? "amarelo" : "vermelho");

/** Parafusos: comprar = demanda + 2 × consumo médio mensal − estoque (nunca negativo). */
export const quantidadeAComprar = (demanda: number, consumoMedioMes: number, estoque: number): number =>
  Math.max(0, arred(demanda + 2 * consumoMedioMes - estoque));

/** Forro PVC: peças = metros ÷ (comprimento da peça × 0,20 m), arredondado para cima. */
export function pecasDeForroPvc(totalMetros: number, comprimentoPecaM: number | null): number | null {
  if (!comprimentoPecaM || comprimentoPecaM <= 0) return null;
  return Math.ceil(arred(totalMetros / (comprimentoPecaM * 0.2), 6));
}

/** Calculadora de bobina: peso (kg) ↔ comprimento (m). Informe um dos dois. */
export function calcularBobina(e: { espessuraMm: number; larguraM: number; densidade?: number; pesoKg?: number; comprimentoM?: number }) {
  const densidade = e.densidade ?? 7850;
  for (const [nome, v] of [["espessura", e.espessuraMm], ["largura", e.larguraM], ["densidade", densidade]] as const) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new ErroDeValidacao(`Informe ${nome} maior que zero.`);
  }
  const kgPorMetro = e.larguraM * (e.espessuraMm / 1000) * densidade;
  if (e.pesoKg !== undefined && e.pesoKg !== null) {
    if (!(e.pesoKg >= 0)) throw new ErroDeValidacao("Peso inválido.");
    return { kgPorMetro: arred(kgPorMetro, 4), pesoKg: arred(e.pesoKg), comprimentoM: arred(e.pesoKg / kgPorMetro) };
  }
  if (e.comprimentoM !== undefined && e.comprimentoM !== null) {
    if (!(e.comprimentoM >= 0)) throw new ErroDeValidacao("Comprimento inválido.");
    return { kgPorMetro: arred(kgPorMetro, 4), comprimentoM: arred(e.comprimentoM), pesoKg: arred(e.comprimentoM * kgPorMetro) };
  }
  throw new ErroDeValidacao("Informe o peso (kg) ou o comprimento (m).");
}

/** Os `n` últimos meses FECHADOS (AAAA-MM) antes do mês de `hoje`, do mais antigo ao mais recente. */
export function ultimosMesesFechados(hoje: string, n: number): string[] {
  let [a, m] = hoje.split("-").map(Number);
  const meses: string[] = [];
  for (let i = 0; i < n; i++) {
    m -= 1;
    if (m === 0) { m = 12; a -= 1; }
    meses.unshift(`${a}-${String(m).padStart(2, "0")}`);
  }
  return meses;
}

const ultimoDiaDoMes = (mes: string) => {
  const [a, m] = mes.split("-").map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
};

// ============================================================ serviço

const centavos = (reais: number | null) => (reais === null ? null : Math.round(reais * 100));
const reais = (c: number | null) => (c === null ? null : c / 100);

export interface EdicaoCompra {
  tipo?: string;
  numeroPedido?: number | null;
  pedidoId?: number | null;
  fornecedorId?: number | null;
  medidas?: Medida[];
  totalMetros?: number;
  comprimentoPecaM?: number | null;
  material?: string;
  tr?: string | null;
  cotacao?: string;
  /** Em reais; null volta ao valor calculado. */
  valor?: number | null;
  status?: string;
  compradoPor?: string;
  compradoEm?: string | null;
  observacao?: string;
}

export class ExtrasService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly servico: ProgramacaoService,
    private readonly repo: ProgramacaoRepository,
    private readonly agora: () => Date = () => new Date()
  ) {
    inTransaction(db, () => {
      const f = db.prepare("INSERT OR IGNORE INTO pcp_fornecedor (nome) VALUES (?)");
      for (const nome of FORNECEDORES_INICIAIS) f.run(nome);
    });
  }

  private hoje() {
    return this.servico.hoje();
  }

  // ---------------------------------------------------------- feriados

  feriados(): Array<{ data: string; nome: string }> {
    return (this.db.prepare("SELECT data, nome FROM pcp_feriado ORDER BY data").all() as Linha[]).map((l) => ({ data: l.data as string, nome: l.nome as string }));
  }

  adicionarFeriado(data: string, nome: string): void {
    if (typeof data !== "string" || !isDataPlausivel(data)) throw new ErroDeValidacao("Data inválida (AAAA-MM-DD).");
    const n = String(nome ?? "").trim().slice(0, 80);
    if (!n) throw new ErroDeValidacao("Informe o nome do feriado.");
    this.db.prepare("INSERT INTO pcp_feriado (data, nome) VALUES (?, ?) ON CONFLICT(data) DO UPDATE SET nome = excluded.nome").run(data, n);
  }

  removerFeriado(data: string): void {
    this.db.prepare("DELETE FROM pcp_feriado WHERE data = ?").run(data);
  }

  private setFeriados() {
    return new Set(this.feriados().map((f) => f.data));
  }

  // ---------------------------------------------------------- agenda (4.3)

  private linhaAgenda(l: ItemView) {
    const eps = l.consumos.filter((c) => c.material === "eps").reduce((s, c) => s + c.quantidade, 0);
    return {
      id: l.id,
      pedidoId: l.pedidoId,
      numeroPedido: l.numeroPedido,
      cliente: l.cliente,
      cidade: l.cidade,
      rota: l.rota?.nome ?? null,
      situacao: l.situacao,
      situacaoRotulo: l.situacaoRotulo,
      categoriaRotulo: l.categoriaRotulo,
      statusPrazo: l.statusPrazo.codigo,
      metros: l.metrosTelha,
      metrosPintados: l.tipoPintura === "PINTURA" ? arred(l.metrosTelha * l.facesPintura) : 0,
      eps: arred(eps),
      valorPedido: l.valorPedido,
      dataProgramacao: l.dataProgramacao,
      prazoVigente: l.prazoVigente,
    };
  }

  agenda(de: string | undefined, ate: string | undefined, perfil: Perfil) {
    const hoje = this.hoje();
    const inicio = de && isDataPlausivel(de) ? de : (somarDias(hoje, -((new Date(`${hoje}T00:00:00Z`).getUTCDay() + 6) % 7)) as string);
    const fim = ate && isDataPlausivel(ate) ? ate : (somarDias(inicio, 27) as string);
    if (fim < inicio) throw new ErroDeValidacao("O fim do período é anterior ao início.");
    if ((Date.parse(fim) - Date.parse(inicio)) / 86_400_000 > 120) throw new ErroDeValidacao("Período grande demais (máximo 120 dias).");

    const capacidade = this.repo.parametro("capacidade_m_dia");
    const feriados = this.feriados();
    const nomesFeriado = new Map(feriados.map((f) => [f.data, f.nome]));
    const util = new Set(diasUteis(inicio, fim, new Set(feriados.map((f) => f.data))));

    const todas = this.servico.todasAsLinhas(perfil).filter((l) => !SITUACOES_EXCLUIDAS_DOS_TOTAIS.includes(l.situacao));
    const programadas = todas.filter((l) => l.dataProgramacao && l.dataProgramacao >= inicio && l.dataProgramacao <= fim);

    // Dia sem expediente só aparece se tiver item programado (para ninguém "perder" um item num sábado).
    const datas = new Set([...util, ...programadas.map((l) => l.dataProgramacao as string)]);
    const dias = [...datas].sort().map((data) => {
      const itens = programadas.filter((l) => l.dataProgramacao === data).map((l) => this.linhaAgenda(l));
      const metros = arred(itens.reduce((s, i) => s + i.metros, 0));
      const pedidos = new Map<number, number>();
      for (const i of itens) if (i.valorPedido !== null) pedidos.set(i.pedidoId, i.valorPedido);
      const ocupacaoPct = capacidade > 0 ? Math.round((metros / capacidade) * 100) : 0;
      const [a, m, d] = data.split("-").map(Number);
      return {
        data,
        diaSemana: new Date(Date.UTC(a, m - 1, d)).getUTCDay(),
        util: util.has(data),
        feriado: nomesFeriado.get(data) ?? null,
        itens,
        metros,
        metrosPintados: arred(itens.reduce((s, i) => s + i.metrosPintados, 0)),
        eps: arred(itens.reduce((s, i) => s + i.eps, 0)),
        valor: Math.round([...pedidos.values()].reduce((s, v) => s + Math.round(v * 100), 0)) / 100,
        capacidade,
        ocupacaoPct,
        nivel: nivelDeOcupacao(ocupacaoPct),
        livre: arred(capacidade - metros),
      };
    });

    return {
      hoje,
      de: inicio,
      ate: fim,
      capacidade,
      dias,
      aProgramar: todas.filter((l) => l.situacao === "PROGRAMAR" && !l.dataProgramacao).map((l) => this.linhaAgenda(l)),
      vencidas: todas.filter((l) => l.alertas.some((a) => a.codigo === "programacao_vencida")).map((l) => this.linhaAgenda(l)),
      feriados,
    };
  }

  // ---------------------------------------------------------- painel (4.4)

  painel(de: string | undefined, ate: string | undefined, perfil: Perfil) {
    const hoje = this.hoje();
    const todas = this.servico.todasAsLinhas(perfil).filter((l) => !SITUACOES_EXCLUIDAS_DOS_TOTAIS.includes(l.situacao));
    const emAberto = todas.filter((l) => {
      if (SITUACOES_ENCERRADAS.includes(l.situacao)) return false;
      if (de && (!l.prazoVigente || l.prazoVigente < de)) return false;
      if (ate && (!l.prazoVigente || l.prazoVigente > ate)) return false;
      return true;
    });

    const soma = (ls: ItemView[]) => {
      const pedidos = new Map<number, number>();
      for (const l of ls) if (l.valorPedido !== null) pedidos.set(l.pedidoId, l.valorPedido);
      const consumo = (m: string) => ls.reduce((s, l) => s + l.consumos.filter((c) => c.material === m).reduce((x, c) => x + c.quantidade, 0), 0);
      return {
        itens: ls.length,
        metros: arred(ls.reduce((s, l) => s + l.metrosTelha, 0)),
        metrosPintados: arred(ls.reduce((s, l) => s + (l.tipoPintura === "PINTURA" ? l.metrosTelha * l.facesPintura : 0), 0)),
        eps: arred(consumo("eps")),
        bobinaKg: arred(consumo("bobina")),
        valor: Math.round([...pedidos.values()].reduce((s, v) => s + Math.round(v * 100), 0)) / 100,
      };
    };

    const porSituacao = SITUACOES.map((s) => ({ situacao: s, rotulo: SITUACAO_ROTULO[s], ...soma(emAberto.filter((l) => l.situacao === s)) })).filter((x) => x.itens > 0);

    const porRotaMapa = new Map<string, ItemView[]>();
    for (const l of emAberto) {
      const k = l.rota ? `${String(l.rota.id).padStart(2, "0")}|${l.rota.nome}` : "99|Sem rota";
      porRotaMapa.set(k, [...(porRotaMapa.get(k) ?? []), l]);
    }
    const porRota = [...porRotaMapa.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, ls]) => {
        const pedidos = new Map<number, ItemView[]>();
        for (const l of ls) pedidos.set(l.pedidoId, [...(pedidos.get(l.pedidoId) ?? []), l]);
        return {
          rota: k.split("|")[1],
          ...soma(ls),
          pedidos: [...pedidos.values()]
            .map((itens) => ({
              pedidoId: itens[0].pedidoId,
              numeroPedido: itens[0].numeroPedido,
              cliente: itens[0].cliente,
              cidade: itens[0].cidade,
              prazoVigente: itens[0].prazoVigente,
              situacao: situacaoDoPedido(itens.map((i) => i.situacao)),
              situacaoRotulo: SITUACAO_ROTULO[situacaoDoPedido(itens.map((i) => i.situacao)) as Situacao],
              statusPrazo: itens[0].statusPrazo.codigo,
              itens: itens.length,
              metros: arred(itens.reduce((s, i) => s + i.metrosTelha, 0)),
              valor: itens[0].valorPedido,
            }))
            .sort((a, b) => (a.prazoVigente ?? "9999").localeCompare(b.prazoVigente ?? "9999")),
        };
      });

    // Produção x vendas por mês
    const feriados = this.setFeriados();
    const mesDeInicio = de ? (mesDe(de) as string) : (ultimosMesesFechados(hoje, 5).concat(hoje.slice(0, 7))[0]);
    const mesDeFim = ate ? (mesDe(ate) as string) : hoje.slice(0, 7);
    const meses: string[] = [];
    for (let m = mesDeInicio; m <= mesDeFim && meses.length < 36; ) {
      meses.push(m);
      const [a, mm] = m.split("-").map(Number);
      m = mm === 12 ? `${a + 1}-01` : `${a}-${String(mm + 1).padStart(2, "0")}`;
    }
    const mensal = meses.map((mes) => {
      const fimMes = ultimoDiaDoMes(mes);
      const ateQuando = fimMes > hoje ? hoje : fimMes;
      const nUteis = Math.max(1, diasUteis(`${mes}-01`, ateQuando, feriados).length);
      const produzido = todas.filter((l) => l.mesProducao === mes);
      const vendido = todas.filter((l) => l.mesVenda === mes);
      const entregues = todas.filter((l) => l.situacao === "ENTREGUE" && mesDe(l.dataEntregaRealizada) === mes);
      const noPrazo = entregues.filter((l) => l.statusPrazo.codigo === "entregue_no_prazo").length;
      const resumo = (ls: ItemView[]) => {
        const metros = arred(ls.reduce((s, l) => s + l.metrosTelha, 0));
        const pint = arred(ls.reduce((s, l) => s + (l.tipoPintura === "PINTURA" ? l.metrosTelha * l.facesPintura : 0), 0));
        return { itens: ls.length, metros, metrosPintados: pint, mediaDiaMetros: arred(metros / nUteis), mediaDiaPintados: arred(pint / nUteis) };
      };
      return {
        mes,
        rotulo: rotuloMes(mes),
        diasUteis: nUteis,
        produzido: resumo(produzido),
        vendido: resumo(vendido),
        entregues: entregues.length,
        entreguesNoPrazo: noPrazo,
        pontualidadePct: entregues.length ? Math.round((noPrazo / entregues.length) * 100) : null,
      };
    });

    return { hoje, de: de ?? null, ate: ate ?? null, porSituacao, totalEmAberto: soma(emAberto), porRota, mensal };
  }

  // ---------------------------------------------------------- parafusos (4.6)

  parafusos(perfil: Perfil) {
    const hoje = this.hoje();
    const meses = ultimosMesesFechados(hoje, 6);
    const itens = this.servico.todasAsLinhas(perfil).filter((l) => !SITUACOES_EXCLUIDAS_DOS_TOTAIS.includes(l.situacao));
    const estoque = new Map((this.db.prepare("SELECT * FROM pcp_estoque").all() as Linha[]).map((l) => [l.material as string, l]));

    const lista = this.repo.materiais().filter((m) => m.grupo === "parafusos").map((m) => {
      const qtd = (l: ItemView) => l.consumos.filter((c) => c.material === m.codigo).reduce((s, c) => s + c.quantidade, 0);
      const consumido = itens.filter((l) => l.mesProducao && meses.includes(l.mesProducao)).reduce((s, l) => s + qtd(l), 0);
      const demanda = itens.filter((l) => !SITUACOES_PRODUZIDAS.includes(l.situacao) && !SITUACOES_ENCERRADAS.includes(l.situacao)).reduce((s, l) => s + qtd(l), 0);
      const consumoMedioMes = arred(consumido / meses.length);
      const e = estoque.get(m.codigo);
      const est = (e?.quantidade as number | undefined) ?? 0;
      return {
        codigo: m.codigo,
        nome: m.nome.replace(/^Parafuso /, ""),
        consumoMedioMes,
        demanda: arred(demanda),
        estoque: est,
        contadoEm: (e?.contado_em as string | undefined) ?? null,
        comprar: quantidadeAComprar(demanda, consumoMedioMes, est),
      };
    });
    return { hoje, mesesBase: meses, itens: lista };
  }

  definirEstoque(material: string, quantidade: number, contadoEm?: string): void {
    const mat = this.repo.materiais().find((m) => m.codigo === material && m.grupo === "parafusos");
    if (!mat) throw new ErroDeValidacao("Parafuso desconhecido.", 404);
    if (typeof quantidade !== "number" || !(quantidade >= 0) || quantidade > 100_000_000) throw new ErroDeValidacao("Quantidade inválida.");
    const data = contadoEm ?? this.hoje();
    if (!isDataPlausivel(data)) throw new ErroDeValidacao("Data da contagem inválida.");
    this.db
      .prepare("INSERT INTO pcp_estoque (material, quantidade, contado_em) VALUES (?, ?, ?) ON CONFLICT(material) DO UPDATE SET quantidade = excluded.quantidade, contado_em = excluded.contado_em")
      .run(material, quantidade, data);
  }

  // ---------------------------------------------------------- fornecedores e pagamentos (4.5)

  fornecedores() {
    const compras = (this.db.prepare("SELECT * FROM pcp_compra WHERE fornecedor_id IS NOT NULL").all() as Linha[]).map((l) => this.paraCompraBruta(l));
    const pagamentos = this.db.prepare("SELECT fornecedor_id, SUM(valor_centavos) AS s FROM pcp_pagamento GROUP BY fornecedor_id").all() as Linha[];
    const pagoPor = new Map(pagamentos.map((l) => [l.fornecedor_id as number, l.s as number]));
    const preco = this.repo.parametro("preco_forro_anfer_m");

    return (this.db.prepare("SELECT * FROM pcp_fornecedor ORDER BY nome").all() as Linha[]).map((l) => {
      const id = l.id as number;
      const comprado = compras
        .filter((c) => c.fornecedorId === id && (COMPRA_STATUS_FIRMES as readonly string[]).includes(c.status))
        .reduce((s, c) => s + (this.valorDaCompra(c, preco).valorCentavos ?? 0), 0);
      const pago = pagoPor.get(id) ?? 0;
      return {
        id,
        nome: l.nome as string,
        fornece: l.fornece as string,
        contato: l.contato as string,
        ativo: l.ativo === 1,
        totalComprado: comprado / 100,
        totalPago: pago / 100,
        saldoAPagar: (comprado - pago) / 100,
      };
    });
  }

  salvarFornecedor(c: { id?: number; nome?: string; fornece?: string; contato?: string; ativo?: boolean }) {
    const nome = String(c.nome ?? "").trim().slice(0, 80);
    if (c.id === undefined) {
      if (!nome) throw new ErroDeValidacao("Informe o nome do fornecedor.");
      try {
        this.db.prepare("INSERT INTO pcp_fornecedor (nome, fornece, contato) VALUES (?, ?, ?)").run(nome, String(c.fornece ?? "").slice(0, 200), String(c.contato ?? "").slice(0, 200));
      } catch {
        throw new ErroDeValidacao("Já existe um fornecedor com esse nome.");
      }
      return;
    }
    const atual = this.db.prepare("SELECT * FROM pcp_fornecedor WHERE id = ?").get(c.id) as Linha | undefined;
    if (!atual) throw new ErroDeValidacao("Fornecedor não encontrado.", 404);
    this.db
      .prepare("UPDATE pcp_fornecedor SET nome = ?, fornece = ?, contato = ?, ativo = ? WHERE id = ?")
      .run(nome || (atual.nome as string), c.fornece !== undefined ? String(c.fornece).slice(0, 200) : (atual.fornece as string), c.contato !== undefined ? String(c.contato).slice(0, 200) : (atual.contato as string), c.ativo === undefined ? (atual.ativo as number) : c.ativo ? 1 : 0, c.id);
  }

  pagamentos(fornecedorId: number) {
    return (this.db.prepare("SELECT * FROM pcp_pagamento WHERE fornecedor_id = ? ORDER BY data DESC, id DESC").all(fornecedorId) as Linha[]).map((l) => ({
      id: l.id as number, data: l.data as string, valor: (l.valor_centavos as number) / 100, observacao: l.observacao as string, criadoPor: l.created_by as string,
    }));
  }

  registrarPagamento(c: { fornecedorId: number; data?: string; valor: number; observacao?: string }, usuario: string): void {
    if (!this.db.prepare("SELECT 1 FROM pcp_fornecedor WHERE id = ?").get(c.fornecedorId)) throw new ErroDeValidacao("Fornecedor não encontrado.", 404);
    if (typeof c.valor !== "number" || !(c.valor > 0) || c.valor > 100_000_000) throw new ErroDeValidacao("Valor do pagamento inválido.");
    const data = c.data ?? this.hoje();
    if (!isDataPlausivel(data)) throw new ErroDeValidacao("Data do pagamento inválida.");
    this.db
      .prepare("INSERT INTO pcp_pagamento (fornecedor_id, data, valor_centavos, observacao, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(c.fornecedorId, data, Math.round(c.valor * 100), String(c.observacao ?? "").slice(0, 500), this.agora().toISOString(), usuario);
  }

  removerPagamento(id: number): void {
    this.db.prepare("DELETE FROM pcp_pagamento WHERE id = ?").run(id);
  }

  // ---------------------------------------------------------- compras (4.5)

  private paraCompraBruta(l: Linha) {
    let medidas: Medida[] = [];
    try { medidas = JSON.parse(l.medidas as string) as Medida[]; } catch { /* sem medidas */ }
    return {
      id: l.id as number,
      tipo: l.tipo as CompraTipo,
      pedidoId: (l.pedido_id as number | null) ?? null,
      fornecedorId: (l.fornecedor_id as number | null) ?? null,
      medidas,
      totalMetrosGravado: l.total_metros as number,
      comprimentoPecaM: (l.comprimento_peca_m as number | null) ?? null,
      material: l.material as string,
      tr: (l.tr as string | null) ?? null,
      cotacao: l.cotacao as string,
      valorManualCentavos: (l.valor_centavos as number | null) ?? null,
      status: l.status as CompraStatus,
      compradoPor: l.comprado_por as string,
      compradoEm: (l.comprado_em as string | null) ?? null,
      observacao: l.observacao as string,
      atualizadoEm: l.updated_at as string,
      atualizadoPor: l.updated_by as string,
    };
  }

  private valorDaCompra(c: ReturnType<ExtrasService["paraCompraBruta"]>, preco: number) {
    const totalMetros = c.medidas.length > 0 ? metrosDeTelha(c.medidas) : c.totalMetrosGravado;
    const calculado = c.tipo === "FORRO_ANFER" ? Math.round(totalMetros * preco * 100) : null;
    return { totalMetros, calculadoCentavos: calculado, valorCentavos: c.valorManualCentavos ?? calculado };
  }

  compras(filtros: { tipo?: string; status?: string; fornecedor?: string; q?: string }, perfil: Perfil) {
    const preco = this.repo.parametro("preco_forro_anfer_m");
    const fornecedores = new Map((this.db.prepare("SELECT id, nome FROM pcp_fornecedor").all() as Linha[]).map((l) => [l.id as number, l.nome as string]));
    const pedidos = new Map(this.repo.listarPedidos().map((p) => [p.id, p]));
    const itensPorPedido = new Map<number, Situacao[]>();
    for (const i of this.repo.listarItens()) itensPorPedido.set(i.pedidoId, [...(itensPorPedido.get(i.pedidoId) ?? []), i.situacao]);

    const q = filtros.q?.trim().toLowerCase();
    const lista = (this.db.prepare("SELECT * FROM pcp_compra ORDER BY id DESC").all() as Linha[])
      .map((l) => {
        const c = this.paraCompraBruta(l);
        const v = this.valorDaCompra(c, preco);
        const p = c.pedidoId !== null ? pedidos.get(c.pedidoId) : undefined;
        const sit = p ? situacaoDoPedido(itensPorPedido.get(p.id) ?? []) : null;
        return {
          id: c.id,
          tipo: c.tipo,
          tipoRotulo: COMPRA_TIPO_ROTULO[c.tipo] ?? c.tipo,
          pedido: p
            ? {
                id: p.id,
                numero: p.numeroPedido,
                cliente: p.clienteNome,
                cidade: p.cidade,
                telefone: perfil === "completo" && p.clienteTelefone ? mascararTelefone(p.clienteTelefone) : null,
                prazoVigente: prazoVigente(p.dataEntregaNegociada, p.dataEntregaOriginal),
                situacao: sit,
                situacaoRotulo: sit ? SITUACAO_ROTULO[sit] : null,
              }
            : null,
          fornecedor: c.fornecedorId !== null ? { id: c.fornecedorId, nome: fornecedores.get(c.fornecedorId) ?? "?" } : null,
          medidas: c.medidas,
          medidasTexto: medidasEmTexto(c.medidas),
          totalMetros: v.totalMetros,
          comprimentoPecaM: c.comprimentoPecaM,
          pecas: c.tipo === "FORRO_PVC" ? pecasDeForroPvc(v.totalMetros, c.comprimentoPecaM) : null,
          material: c.material,
          tr: c.tr,
          cotacao: c.cotacao,
          valorCalculado: reais(v.calculadoCentavos),
          valor: reais(v.valorCentavos),
          valorManual: c.valorManualCentavos !== null,
          status: c.status,
          statusRotulo: COMPRA_STATUS_ROTULO[c.status] ?? c.status,
          compradoPor: c.compradoPor,
          compradoEm: c.compradoEm,
          observacao: c.observacao,
          atualizadoEm: c.atualizadoEm,
          atualizadoPor: c.atualizadoPor,
        };
      })
      .filter((c) => {
        if (filtros.tipo && c.tipo !== filtros.tipo) return false;
        if (filtros.status && c.status !== filtros.status) return false;
        if (filtros.fornecedor && String(c.fornecedor?.id ?? "") !== filtros.fornecedor) return false;
        if (q && ![c.pedido?.numero, c.pedido?.cliente, c.material, c.cotacao, c.observacao, c.fornecedor?.nome].join(" ").toLowerCase().includes(q)) return false;
        return true;
      });

    const ativas = lista.filter((c) => c.status !== "CANCELADO");
    return {
      compras: lista,
      totais: { compras: ativas.length, metros: arred(ativas.reduce((s, c) => s + c.totalMetros, 0)), valor: arred(ativas.reduce((s, c) => s + (c.valor ?? 0), 0)) },
      fornecedores: this.fornecedores(),
      opcoes: {
        tipos: COMPRA_TIPOS.map((t) => ({ valor: t, rotulo: COMPRA_TIPO_ROTULO[t] })),
        status: COMPRA_STATUS.map((s) => ({ valor: s, rotulo: COMPRA_STATUS_ROTULO[s] })),
        precoForroAnfer: preco,
      },
    };
  }

  private resolverPedido(e: EdicaoCompra): number | null | undefined {
    if (e.pedidoId !== undefined && e.pedidoId !== null) {
      if (!this.repo.buscarPedido(e.pedidoId)) throw new ErroDeValidacao("Pedido não encontrado.", 404);
      return e.pedidoId;
    }
    if (e.numeroPedido !== undefined && e.numeroPedido !== null) {
      const achados = this.repo.pedidosPorNumero(Number(e.numeroPedido));
      if (achados.length === 0) throw new ErroDeValidacao(`O pedido ${e.numeroPedido} não está na Programação.`);
      if (achados.length > 1) throw new ErroDeValidacao(`Há mais de um pedido ${e.numeroPedido}: informe pelo detalhe do pedido.`);
      return achados[0].id;
    }
    return e.pedidoId === null || e.numeroPedido === null ? null : undefined;
  }

  private gravarCompra(id: number | null, e: EdicaoCompra, usuario: string): number {
    const agora = this.agora().toISOString();
    const atual = id !== null ? (this.db.prepare("SELECT * FROM pcp_compra WHERE id = ?").get(id) as Linha | undefined) : undefined;
    if (id !== null && !atual) throw new ErroDeValidacao("Compra não encontrada.", 404);

    const tipo = e.tipo ?? (atual?.tipo as string | undefined);
    if (!tipo || !(COMPRA_TIPOS as readonly string[]).includes(tipo)) throw new ErroDeValidacao("Tipo de compra inválido.");
    const status = e.status ?? (atual?.status as string | undefined) ?? "A_COTAR";
    if (!(COMPRA_STATUS as readonly string[]).includes(status)) throw new ErroDeValidacao("Status da compra inválido.");

    const pedidoNovo = this.resolverPedido(e);
    const pedidoId = pedidoNovo !== undefined ? pedidoNovo : ((atual?.pedido_id as number | null | undefined) ?? null);

    let fornecedorId = (atual?.fornecedor_id as number | null | undefined) ?? null;
    if (e.fornecedorId !== undefined) {
      if (e.fornecedorId !== null && !this.db.prepare("SELECT 1 FROM pcp_fornecedor WHERE id = ?").get(e.fornecedorId)) throw new ErroDeValidacao("Fornecedor não encontrado.", 404);
      fornecedorId = e.fornecedorId;
    }

    let medidas: Medida[] = [];
    try { medidas = JSON.parse((atual?.medidas as string | undefined) ?? "[]") as Medida[]; } catch { /* vazio */ }
    if (e.medidas !== undefined) {
      if (!Array.isArray(e.medidas) || e.medidas.some((m) => !(m?.qtd > 0) || !(m?.comprimento_m > 0) || m.comprimento_m > 30)) {
        throw new ErroDeValidacao("Medidas inválidas: informe quantidade e comprimento em metros (até 30).");
      }
      medidas = e.medidas.map((m) => ({ qtd: m.qtd, comprimento_m: arred(m.comprimento_m, 3) }));
    }
    let totalMetros = (atual?.total_metros as number | undefined) ?? 0;
    if (e.totalMetros !== undefined) {
      if (typeof e.totalMetros !== "number" || !(e.totalMetros >= 0) || e.totalMetros > 1_000_000) throw new ErroDeValidacao("Total de metros inválido.");
      totalMetros = e.totalMetros;
    }
    if (medidas.length > 0) totalMetros = metrosDeTelha(medidas);

    let comp = (atual?.comprimento_peca_m as number | null | undefined) ?? null;
    if (e.comprimentoPecaM !== undefined) {
      if (e.comprimentoPecaM !== null && (!(e.comprimentoPecaM > 0) || e.comprimentoPecaM > 30)) throw new ErroDeValidacao("Comprimento da peça inválido.");
      comp = e.comprimentoPecaM;
    }
    if (e.tr !== undefined && e.tr !== null && !["TR25", "TR40"].includes(e.tr)) throw new ErroDeValidacao("TR deve ser TR25 ou TR40.");
    let valorC = (atual?.valor_centavos as number | null | undefined) ?? null;
    if (e.valor !== undefined) {
      if (e.valor !== null && (typeof e.valor !== "number" || !(e.valor >= 0) || e.valor > 100_000_000)) throw new ErroDeValidacao("Valor inválido.");
      valorC = centavos(e.valor);
    }
    let compradoEm = (atual?.comprado_em as string | null | undefined) ?? null;
    if (e.compradoEm !== undefined) {
      if (e.compradoEm !== null && !isDataPlausivel(e.compradoEm)) throw new ErroDeValidacao("Data da compra inválida.");
      compradoEm = e.compradoEm;
    }
    let compradoPor = e.compradoPor !== undefined ? String(e.compradoPor).trim().slice(0, 60) : ((atual?.comprado_por as string | undefined) ?? "");
    // Ao marcar como comprado, registra quem e quando (se ainda não houver).
    if (status === "COMPRADO" && atual?.status !== "COMPRADO") {
      compradoEm = compradoEm ?? this.hoje();
      compradoPor = compradoPor || usuario;
    }

    const campos = [
      tipo, pedidoId, fornecedorId, JSON.stringify(medidas), totalMetros, comp,
      e.material !== undefined ? String(e.material).trim().slice(0, 120) : ((atual?.material as string | undefined) ?? ""),
      e.tr !== undefined ? e.tr : ((atual?.tr as string | null | undefined) ?? null),
      e.cotacao !== undefined ? String(e.cotacao).trim().slice(0, 80) : ((atual?.cotacao as string | undefined) ?? ""),
      valorC, status, compradoPor, compradoEm,
      e.observacao !== undefined ? String(e.observacao).trim().slice(0, 2000) : ((atual?.observacao as string | undefined) ?? ""),
    ];

    if (id === null) {
      const r = this.db
        .prepare(
          `INSERT INTO pcp_compra (tipo, pedido_id, fornecedor_id, medidas, total_metros, comprimento_peca_m, material, tr, cotacao, valor_centavos,
             status, comprado_por, comprado_em, observacao, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...(campos as never[]), agora, agora, usuario);
      return Number(r.lastInsertRowid);
    }
    this.db
      .prepare(
        `UPDATE pcp_compra SET tipo = ?, pedido_id = ?, fornecedor_id = ?, medidas = ?, total_metros = ?, comprimento_peca_m = ?, material = ?, tr = ?,
           cotacao = ?, valor_centavos = ?, status = ?, comprado_por = ?, comprado_em = ?, observacao = ?, updated_at = ?, updated_by = ? WHERE id = ?`
      )
      .run(...(campos as never[]), agora, usuario, id);
    return id;
  }

  criarCompra(e: EdicaoCompra, usuario: string): number {
    return inTransaction(this.db, () => this.gravarCompra(null, e, usuario));
  }

  editarCompra(id: number, e: EdicaoCompra, usuario: string): void {
    inTransaction(this.db, () => void this.gravarCompra(id, e, usuario));
  }
}
