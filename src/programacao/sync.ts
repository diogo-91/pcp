import { createHash } from "node:crypto";
import { brParaIso } from "../prazo";
import type { CarregarPessoas, Logger, NomusLeitor, NomusPedidoLista, ProgramacaoGancho } from "../sync";
import { derivarItem, recalcularConsumosDoItem } from "./derivar";
import { SITUACAO_INICIAL, SITUACOES_PROGRAMADAS_OU_ALEM } from "./enums";
import type { ItemNomusCampos, PedidoNomusCampos, ProgramacaoRepository } from "./repo";
import { categoriaPorDescricao, chaveCidade, normalizarTelefone, numeroBR, reaisParaCentavos } from "./regras";

interface NomusProduto {
  id?: number;
  codigo?: string;
  descricao?: string;
  nomeTipoProduto?: string;
  siglaUnidadeMedida?: string;
}

interface NomusPessoaDetalhe {
  nome?: string;
  telefone?: string;
  municipio?: string;
  uf?: string;
}

interface NomusOrdem {
  id?: number;
  nome?: string;
  status?: string;
  dataHoraInicialPlanejada?: string;
  itensPedido?: Array<{ id?: number; idPedido?: number }>;
}

export interface ProgramacaoSyncOptions {
  statusLiberado: number;
  /** Códigos de `itensPedido[].status` que a Nomus usa para cancelado. Vazio = a Nomus ainda não informou (pergunta 11.6). */
  statusCancelado?: number[];
  /** Quanto tempo a descrição de um produto vale antes de consultar a Nomus de novo. */
  validadeProdutoMs?: number;
  tamanhoLote?: number;
  pausaMs?: number;
  agora?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
}

const TRINTA_DIAS_MS = 30 * 24 * 60 * 60 * 1000;
const semLog: Logger = { info() {}, warn() {} };
const limpar = (t: string | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
const hash = (valor: unknown) => createHash("sha1").update(JSON.stringify(valor)).digest("hex");

export interface ResultadoPagina {
  lidos: number;
  criados: number;
  atualizados: number;
  erros: number;
}

/**
 * Recebe cada página de pedidos liberados que o sincronizador do PCP já leu e grava o módulo Programação:
 * upsert idempotente por id do pedido/item da Nomus, escrevendo SÓ campos cujo dono é a Nomus.
 * Rodar duas vezes seguidas com os mesmos dados não grava nada (nem muda updated_at).
 */
export class ProgramacaoSync implements ProgramacaoGancho {
  private readonly log: Logger;
  private readonly agora: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private rodadaId: number | null = null;
  private total: ResultadoPagina = { lidos: 0, criados: 0, atualizados: 0, erros: 0 };
  private detalheErros: string[] = [];

  constructor(
    private readonly nomus: NomusLeitor,
    private readonly repo: ProgramacaoRepository,
    private readonly opcoes: ProgramacaoSyncOptions
  ) {
    this.log = opcoes.log ?? semLog;
    this.agora = opcoes.agora ?? (() => new Date());
    this.sleep = opcoes.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ---- gancho do SyncService

  iniciarRodada(): void {
    this.total = { lidos: 0, criados: 0, atualizados: 0, erros: 0 };
    this.detalheErros = [];
    this.rodadaId = this.repo.iniciarSyncProgramacao(this.agora().toISOString());
  }

  finalizarRodada(erro: string | null): void {
    if (this.rodadaId === null) return;
    if (erro) this.detalheErros.push(`Rodada interrompida: ${erro}`);
    this.gravarProgresso();
    this.repo.finalizarSyncProgramacao(this.rodadaId, this.agora().toISOString());
    this.rodadaId = null;
  }

  async lerPagina(pedidos: NomusPedidoLista[], carregarPessoas: CarregarPessoas): Promise<void> {
    if (this.rodadaId === null) this.iniciarRodada(); // chamada avulsa (testes/scripts)
    const r = await this.processarPagina(pedidos, carregarPessoas);
    this.total.lidos += r.lidos;
    this.total.criados += r.criados;
    this.total.atualizados += r.atualizados;
    this.total.erros += r.erros;
    this.gravarProgresso();
  }

  private gravarProgresso(): void {
    if (this.rodadaId !== null) this.repo.atualizarSyncProgramacao(this.rodadaId, { ...this.total, detalheErros: this.detalheErros });
  }

  /**
   * "Sincronizar agora" de um pedido só: busca o pedido (e o cliente) na Nomus e aplica as mesmas regras da rodada completa.
   * Só atualiza pedido que já está na Programação (não cria pedido que a Nomus não lista como liberado).
   */
  async sincronizarPedido(nomusPedidoId: number): Promise<ResultadoPagina> {
    if (!this.repo.buscarPedidoPorNomus(nomusPedidoId)) throw new Error("Pedido não encontrado na Programação.");
    const p = await this.nomus.get<NomusPedidoLista>(`/pedidos/${nomusPedidoId}`);
    if (!p || Array.isArray(p) || p.id !== nomusPedidoId) throw new Error("A Nomus não devolveu esse pedido.");

    const carregar: CarregarPessoas = async (ids) => {
      const mapa = new Map();
      for (const id of ids) {
        const r = await this.nomus.get<NomusPessoaDetalhe>(`/pessoas/${id}`);
        mapa.set(id, {
          nomusId: id,
          nome: limpar(r.nome),
          telefone: limpar(r.telefone),
          buscadoEm: this.agora().toISOString(),
          municipio: limpar(r.municipio),
          uf: limpar(r.uf).toUpperCase(),
        });
      }
      return mapa;
    };
    const r = await this.processarPagina([p], carregar);
    if (r.erros > 0) throw new Error(this.detalheErros[this.detalheErros.length - 1] ?? "Falha ao processar o pedido.");
    return r;
  }

  // ---- processamento

  async processarPagina(pedidos: NomusPedidoLista[], carregarPessoas: CarregarPessoas): Promise<ResultadoPagina> {
    const resultado: ResultadoPagina = { lidos: pedidos.length, criados: 0, atualizados: 0, erros: 0 };
    const { statusLiberado } = this.opcoes;

    const idsClientes = [...new Set(pedidos.map((p) => p.idPessoaCliente).filter((v): v is number => typeof v === "number"))];
    const pessoas = await carregarPessoas(idsClientes);

    const itensLiberados = pedidos.flatMap((p) => (p.itensPedido ?? []).filter((i) => i.status === statusLiberado && typeof i.id === "number"));
    await this.garantirProdutos([...new Set(itensLiberados.map((i) => i.idProduto).filter((v): v is number => typeof v === "number"))]);
    const ordens = await this.buscarOrdens(itensLiberados.map((i) => i.id as number));

    for (const p of pedidos) {
      try {
        const r = this.repo.transacao(() => this.processarPedido(p, pessoas, ordens));
        resultado.criados += r.criado ? 1 : 0;
        resultado.atualizados += r.atualizado ? 1 : 0;
      } catch (erro) {
        resultado.erros++;
        const msg = `Pedido ${p.codigoPedido ?? p.id}: ${erro instanceof Error ? erro.message : String(erro)}`;
        this.detalheErros.push(msg);
        this.log.warn(`Programação: ${msg}`);
      }
    }
    return resultado;
  }

  private processarPedido(
    p: NomusPedidoLista,
    pessoas: Map<number, { nome: string; telefone: string; municipio?: string | null; uf?: string | null }>,
    ordens: Map<number, Array<{ nomusOpId: number; numeroOp: string; statusOp: string; inicioPlanejado: string | null }>> | null
  ): { criado: boolean; atualizado: boolean } {
    const agora = this.agora().toISOString();
    const { statusLiberado } = this.opcoes;
    const nomusPedidoId = p.id as number;

    const numero = parseInt(String(p.codigoPedido ?? "").replace(/\D/g, ""), 10);
    if (!Number.isFinite(numero)) throw new Error(`código "${p.codigoPedido}" não tem número`);

    const clienteId = typeof p.idPessoaCliente === "number" ? p.idPessoaCliente : null;
    const pessoa = clienteId !== null ? pessoas.get(clienteId) : undefined;
    if (clienteId !== null && !pessoa) throw new Error(`cliente ${clienteId} não pôde ser consultado (nova tentativa na próxima rodada)`);

    const todosItens = p.itensPedido ?? [];
    const liberados = todosItens.filter((i) => i.status === statusLiberado && typeof i.id === "number");
    const entregas = liberados.map((i) => brParaIso(i.dataEntrega)).filter((d): d is string => d !== null).sort();

    const municipio = limpar(pessoa?.municipio ?? "");
    const uf = limpar(pessoa?.uf ?? "").toUpperCase();
    const cidade = municipio && uf ? `${municipio}-${uf}` : municipio;

    const campos: PedidoNomusCampos = {
      numeroPedido: numero,
      dataPedido: brParaIso(p.dataEmissao),
      clienteNome: pessoa?.nome ?? "",
      clienteTelefone: normalizarTelefone(pessoa?.telefone),
      cidade,
      uf,
      valorCentavos: reaisParaCentavos(p.valorTotal),
      statusNomus: "liberado",
      dataEntregaOriginal: entregas[0] ?? null,
      nomusHash: "",
    };
    campos.nomusHash = hash([campos.numeroPedido, campos.dataPedido, campos.clienteNome, campos.clienteTelefone, campos.cidade, campos.uf, campos.valorCentavos, campos.statusNomus]);

    const rotaId = cidade ? this.repo.rotaDaCidade(chaveCidade(cidade)) : null;

    let pedido = this.repo.buscarPedidoPorNomus(nomusPedidoId);
    let criado = false;
    let atualizado = false;

    if (!pedido) {
      const id = this.repo.inserirPedido(nomusPedidoId, campos, rotaId, agora);
      pedido = this.repo.buscarPedido(id);
      criado = true;
    } else {
      if (pedido.nomusHash !== campos.nomusHash) {
        const { dataEntregaOriginal: _ignorado, ...semEntrega } = campos;
        this.repo.atualizarPedidoNomus(pedido.id, semEntrega, rotaId, agora);
        atualizado = true;
      }
      // O prazo original é imutável: só é gravado se ainda estava vazio.
      if (pedido.dataEntregaOriginal === null && campos.dataEntregaOriginal !== null) this.repo.preencherPrazoOriginal(pedido.id, campos.dataEntregaOriginal);
    }
    if (!pedido) throw new Error("pedido não pôde ser gravado");
    const pedidoId = pedido.id;

    // Itens: os liberados entram/atualizam; item que sumiu do pedido na Nomus é marcado (não apagado).
    const cores = this.repo.cores();
    const fator = this.repo.parametro("fator_chapa_sanduiche");
    const idsNaNomus = new Set(todosItens.map((i) => i.id as number));
    const cancelados = new Set(this.opcoes.statusCancelado ?? []);

    for (const it of liberados) {
      const nomusItemId = it.id as number;
      const produto = typeof it.idProduto === "number" ? this.repo.buscarProduto(it.idProduto) : null;
      if (typeof it.idProduto === "number" && !produto) {
        this.log.warn(`Programação: item ${nomusItemId} do pedido ${numero} adiado: produto ${it.idProduto} indisponível.`);
        continue;
      }

      const nomusCampos: ItemNomusCampos = {
        itemSeq: limpar(it.item),
        produtoNomusId: typeof it.idProduto === "number" ? it.idProduto : null,
        produtoCodigo: produto?.codigo ?? "",
        descricaoProduto: produto?.descricao ?? "",
        infoAdicional: String(it.informacoesAdicionaisProduto ?? "").replace(/\r/g, "").trim(),
        quantidade: numeroBR(it.quantidade),
        nomusHash: "",
      };
      nomusCampos.nomusHash = hash([nomusCampos.itemSeq, nomusCampos.produtoNomusId, nomusCampos.descricaoProduto, nomusCampos.infoAdicional, nomusCampos.quantidade]);

      const entrada = {
        categoria: produto?.categoria ?? categoriaPorDescricao(nomusCampos.descricaoProduto),
        descricaoProduto: nomusCampos.descricaoProduto,
        infoAdicional: nomusCampos.infoAdicional,
        quantidade: nomusCampos.quantidade,
      };

      const existente = this.repo.buscarItemPorNomus(nomusItemId);
      let itemId: number;

      if (!existente) {
        const derivado = derivarItem(entrada, cores, fator);
        itemId = this.repo.inserirItem(pedidoId, { ...nomusCampos, nomusItemId }, derivado, SITUACAO_INICIAL, agora);
        const novo = this.repo.buscarItem(itemId);
        if (novo) recalcularConsumosDoItem(this.repo, novo, agora);
        atualizado = true;
      } else {
        itemId = existente.id;
        if (existente.nomusHash !== nomusCampos.nomusHash) {
          const derivado = derivarItem(entrada, cores, fator, existente);
          const alteradoDepoisDeProgramar = SITUACOES_PROGRAMADAS_OU_ALEM.includes(existente.situacao);
          this.repo.atualizarItemNomus(itemId, nomusCampos, derivado, alteradoDepoisDeProgramar, agora);
          if (alteradoDepoisDeProgramar) {
            this.repo.registrarEvento({
              entidade: "item", entidadeId: itemId, pedidoId, campo: "alterado_no_erp",
              valorAntigo: existente.nomusHash.slice(0, 8), valorNovo: nomusCampos.nomusHash.slice(0, 8),
              usuario: "sync", origem: "sync", em: agora,
            });
          }
          const atualizadoRow = this.repo.buscarItem(itemId);
          if (atualizadoRow) recalcularConsumosDoItem(this.repo, atualizadoRow, agora);
          atualizado = true;
        } else if (existente.removidoNoErp) {
          this.repo.marcarRemovidoNoErp(itemId, false, agora);
          atualizado = true;
        }
      }

      if (ordens) {
        const ops = ordens.get(nomusItemId) ?? [];
        if (this.repo.substituirOps(itemId, ops)) atualizado = true;
      }
    }

    // Item cancelado na Nomus deixa de estar "liberado": por isso é olhado à parte, entre todos os itens do pedido.
    if (cancelados.size > 0) {
      for (const it of todosItens) {
        if (typeof it.id !== "number" || it.status === undefined || !cancelados.has(it.status)) continue;
        const existente = this.repo.buscarItemPorNomus(it.id);
        if (existente && this.cancelarPorSync(existente.id, pedidoId, agora)) atualizado = true;
      }
    }

    for (const dono of this.repo.itensDoPedido(pedidoId)) {
      if (!idsNaNomus.has(dono.nomusItemId) && !dono.removidoNoErp) {
        this.repo.marcarRemovidoNoErp(dono.id, true, agora);
        this.repo.registrarEvento({
          entidade: "item", entidadeId: dono.id, pedidoId, campo: "removido_no_erp", valorAntigo: "0", valorNovo: "1",
          usuario: "sync", origem: "sync", em: agora,
        });
        atualizado = true;
      }
    }

    return { criado, atualizado: atualizado && !criado };
  }

  /** Pedido cancelado na Nomus: o item vira CANCELADO, com evento de origem "sync". */
  private cancelarPorSync(itemId: number, pedidoId: number, agora: string): boolean {
    const item = this.repo.buscarItem(itemId);
    if (!item || item.situacao === "CANCELADO") return false;
    this.repo.atualizarItemPcp(itemId, { situacao: "CANCELADO" }, null, "sync", agora);
    this.repo.registrarEvento({
      entidade: "item", entidadeId: itemId, pedidoId, campo: "situacao", valorAntigo: item.situacao, valorNovo: "CANCELADO",
      usuario: "sync", origem: "sync", em: agora,
    });
    return true;
  }

  // ---- consultas à Nomus

  /** Busca (e guarda em cache) os produtos que ainda não temos. Falha parcial não derruba a página: o item fica para a próxima rodada. */
  private async garantirProdutos(ids: number[]): Promise<void> {
    const validade = this.opcoes.validadeProdutoMs ?? TRINTA_DIAS_MS;
    const limite = this.agora().getTime() - validade;
    const faltam = ids.filter((id) => {
      const c = this.repo.buscarProduto(id);
      return !c || Date.parse(c.buscadoEm) < limite;
    });
    if (faltam.length === 0) return;

    const tamanho = this.opcoes.tamanhoLote ?? 20;
    for (let i = 0; i < faltam.length; i += tamanho) {
      const lote = faltam.slice(i, i + tamanho);
      const encontrados = new Map<number, NomusProduto>();

      try {
        const lista = await this.nomus.get<NomusProduto[]>(`/produtos?query=${lote.map((id) => `id=${id}`).join(",")}`);
        for (const r of Array.isArray(lista) ? lista : []) if (typeof r.id === "number" && lote.includes(r.id)) encontrados.set(r.id, r);
      } catch (erro) {
        this.log.warn(`Programação: consulta de produtos em lote falhou (${String(erro)}); consultando um a um.`);
      }

      for (const id of lote) {
        if (encontrados.has(id)) continue;
        try {
          encontrados.set(id, await this.nomus.get<NomusProduto>(`/produtos/${id}`));
        } catch (erro) {
          this.log.warn(`Programação: produto ${id} não pôde ser consultado: ${String(erro)}`);
        }
      }

      const buscadoEm = this.agora().toISOString();
      for (const [id, r] of encontrados) {
        const descricao = limpar(r.descricao);
        this.repo.salvarProduto({
          nomusId: id,
          codigo: limpar(r.codigo),
          descricao,
          tipoProduto: limpar(r.nomeTipoProduto),
          unidade: limpar(r.siglaUnidadeMedida),
          categoria: categoriaPorDescricao(descricao),
          buscadoEm,
        });
      }
    }
  }

  /** OPs dos itens, em lotes (`itensPedido.id=A,itensPedido.id=B`). Devolve null se a consulta falhar: aí as OPs não são mexidas. */
  private async buscarOrdens(
    itemIds: number[]
  ): Promise<Map<number, Array<{ nomusOpId: number; numeroOp: string; statusOp: string; inicioPlanejado: string | null }>> | null> {
    const mapa = new Map<number, Array<{ nomusOpId: number; numeroOp: string; statusOp: string; inicioPlanejado: string | null }>>();
    for (const id of itemIds) mapa.set(id, []);
    const tamanho = this.opcoes.tamanhoLote ?? 40;
    const pausa = this.opcoes.pausaMs ?? 1000;

    try {
      for (let i = 0; i < itemIds.length; i += tamanho) {
        const lote = itemIds.slice(i, i + tamanho);
        const base = `/ordens?query=${lote.map((id) => `itensPedido.id=${id}`).join(",")}`;

        for (let pagina = 1; ; pagina++) {
          if (i > 0 || pagina > 1) await this.sleep(pausa);
          const ordens = await this.nomus.get<NomusOrdem[]>(`${base}&pagina=${pagina}`);
          if (!Array.isArray(ordens)) throw new Error("resposta de /ordens não é uma lista");

          for (const o of ordens) {
            if (typeof o.id !== "number") continue;
            for (const it of o.itensPedido ?? []) {
              if (typeof it.id !== "number" || !mapa.has(it.id)) continue;
              const lista = mapa.get(it.id) as Array<{ nomusOpId: number; numeroOp: string; statusOp: string; inicioPlanejado: string | null }>;
              if (lista.some((x) => x.nomusOpId === o.id)) continue;
              lista.push({
                nomusOpId: o.id,
                numeroOp: limpar(o.nome),
                statusOp: limpar(o.status),
                inicioPlanejado: brParaIso(o.dataHoraInicialPlanejada),
              });
            }
          }
          if (ordens.length < 50) break;
        }
      }
    } catch (erro) {
      this.log.warn(`Programação: OPs não puderam ser lidas nesta página (${String(erro)}); ficam como estavam.`);
      return null;
    }
    return mapa;
  }
}
