import { brParaIso, somarDias } from "./prazo";
import type { PessoaCache, PcpRepository } from "./repository";
import type { PedidoNomus, SyncRun, SyncStatus } from "./types";

/** O que o sincronizador precisa do cliente da Nomus (facilita trocar por um falso nos testes). */
export interface NomusLeitor {
  get<T>(caminho: string): Promise<T>;
}

export interface NomusItemPedido {
  id?: number;
  item?: string;
  idProduto?: number;
  informacoesAdicionaisProduto?: string;
  quantidade?: string;
  valorUnitario?: string;
  status?: number;
  dataEntrega?: string;
}

export interface NomusPedidoLista {
  id?: number;
  codigoPedido?: string;
  idPessoaCliente?: number;
  dataEmissao?: string;
  valorTotal?: string;
  observacoes?: string;
  itensPedido?: NomusItemPedido[];
}

/** Pessoas (clientes) já consultadas, com cache: o gancho da Programação usa para não repetir chamadas. */
export type CarregarPessoas = (ids: number[]) => Promise<Map<number, PessoaCache>>;

export interface ProgramacaoGancho {
  iniciarRodada(): void;
  lerPagina(pedidos: NomusPedidoLista[], carregarPessoas: CarregarPessoas): Promise<void>;
  finalizarRodada(erro: string | null): void;
}

interface NomusPessoa {
  id?: number;
  nome?: string;
  telefone?: string;
  municipio?: string;
  uf?: string;
}

export interface Logger {
  info(mensagem: string): void;
  warn(mensagem: string): void;
}

export interface SyncOptions {
  /** Código de `itensPedido[].status` que significa "Liberado" na Nomus. */
  statusLiberado: number;
  /** Quanto tempo os dados de um cliente (nome/telefone) valem antes de consultar a Nomus de novo. */
  validadePessoaMs?: number;
  tamanhoLotePessoas?: number;
  /** Pausa entre páginas, para aliviar o rate limit da Nomus. */
  pausaEntrePaginasMs?: number;
  tamanhoPagina?: number;
  /**
   * Dias somados ao prazo de entrega da Nomus quando um pedido NOVO entra na tabela (margem de produção). Só vale na
   * entrada: pedido que já está no banco nunca é alterado. Pedido sem data na Nomus continua sem prazo. Padrão: 0.
   */
  diasExtraEntrega?: number;
  /**
   * Como o módulo Programação recebe os pedidos: cada página de liberados lida (todos, novos e já conhecidos) é repassada,
   * sem nenhuma chamada extra de pedido à Nomus. Erro no gancho é registrado e NUNCA interrompe a sincronização.
   */
  programacao?: ProgramacaoGancho;
  agora?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
}

const SETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

const semLog: Logger = { info() {}, warn() {} };

const limpar = (texto: string | undefined) => (texto ?? "").replace(/\s+/g, " ").trim();

const esperar = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function emLotes<T>(itens: T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}

export class SyncService {
  private emAndamento: Promise<SyncRun> | null = null;
  private readonly log: Logger;
  private readonly agora: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly nomus: NomusLeitor,
    private readonly repo: PcpRepository,
    private readonly opcoes: SyncOptions
  ) {
    this.log = opcoes.log ?? semLog;
    this.agora = opcoes.agora ?? (() => new Date());
    this.sleep = opcoes.sleep ?? esperar;
  }

  executando(): boolean {
    return this.emAndamento !== null;
  }

  status(): SyncStatus {
    return {
      executando: this.executando(),
      ultima: this.repo.ultimaSync(),
      ultimaComSucesso: this.repo.ultimaSync(true),
    };
  }

  /** Uma rodada por vez: se já há uma em andamento, quem chamar recebe a mesma. Nunca lança — o resultado vem em `status`. */
  executar(gatilho: string): Promise<SyncRun> {
    if (this.emAndamento) return this.emAndamento;

    this.emAndamento = this.rodar(gatilho).finally(() => {
      this.emAndamento = null;
    });
    return this.emAndamento;
  }

  private async rodar(gatilho: string): Promise<SyncRun> {
    const id = this.repo.iniciarSync(gatilho, this.agora().toISOString());
    this.log.info(`Sincronização (${gatilho}) iniciada.`);

    this.chamarGancho(() => this.opcoes.programacao?.iniciarRodada());
    try {
      const r = await this.sincronizar(id);
      this.chamarGancho(() => this.opcoes.programacao?.finalizarRodada(null));
      this.repo.finalizarSync(id, { status: "ok", ...r, erro: null }, this.agora().toISOString());
      this.log.info(`Sincronização concluída: ${r.pedidosLidos} liberados na Nomus, ${r.novos} incluídos.`);
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      this.chamarGancho(() => this.opcoes.programacao?.finalizarRodada(mensagem));
      const parcial = this.repo.buscarSync(id);
      // Mantém o que já foi lido/gravado antes da falha: os pedidos das páginas anteriores continuam salvos.
      this.repo.finalizarSync(
        id,
        {
          status: "erro",
          pedidosLidos: parcial?.pedidosLidos ?? 0,
          novos: parcial?.novos ?? 0,
          erro: mensagem.slice(0, 500),
        },
        this.agora().toISOString()
      );
      this.log.warn(`Sincronização falhou: ${mensagem}`);
    }

    return this.repo.buscarSync(id) as SyncRun;
  }

  private chamarGancho(fn: () => void): void {
    try {
      fn();
    } catch (erro) {
      this.log.warn(`Programação: ${String(erro)}`);
    }
  }

  /**
   * Lê os pedidos liberados página a página e INCLUI os que ainda não estão no banco, gravando cada
   * página assim que chega (a tabela enche aos poucos e uma falha no meio não perde o que já entrou).
   * Pedido que já existe é ignorado por inteiro: nada dele é atualizado nem removido, então prazos e
   * demais campos editados pelo PCP nunca são desfeitos.
   */
  private async sincronizar(rodadaId: number): Promise<{ pedidosLidos: number; novos: number }> {
    const { statusLiberado } = this.opcoes;
    const tamanhoPagina = this.opcoes.tamanhoPagina ?? 50;
    const pausa = this.opcoes.pausaEntrePaginasMs ?? 1500;
    const caminhoBase = `/pedidos?query=itensPedido.status=${statusLiberado}`;

    const vistos = new Set<number>(); // o filtro por item faz join: o mesmo pedido pode repetir entre páginas
    let novos = 0;

    for (let pagina = 1; ; pagina++) {
      if (pagina > 1) await this.sleep(pausa);

      const lote = await this.nomus.get<NomusPedidoLista[]>(`${caminhoBase}&pagina=${pagina}`);
      if (!Array.isArray(lote)) throw new Error(`Resposta inesperada da Nomus na página ${pagina}: não é uma lista.`);

      const daPagina: NomusPedidoLista[] = [];
      for (const p of lote) {
        // Não confia cegamente no filtro: se a Nomus o ignorasse, tudo viraria "liberado".
        const temItemLiberado = p.itensPedido?.some((item) => item.status === statusLiberado) ?? false;
        if (typeof p.id !== "number" || !temItemLiberado || vistos.has(p.id)) continue;
        vistos.add(p.id);
        daPagina.push(p);
      }

      // Só quem ainda não está no banco precisa de nome/telefone (ou seja, de consulta ao cadastro do cliente).
      const existentes = this.repo.idsExistentes(daPagina.map((p) => p.id as number));
      const aIncluir = daPagina.filter((p) => !existentes.has(p.id as number));
      if (aIncluir.length > 0) novos += await this.incluirPedidos(aIncluir);

      if (this.opcoes.programacao && daPagina.length > 0) {
        try {
          await this.opcoes.programacao.lerPagina(daPagina, (ids) => this.carregarPessoas(ids));
        } catch (erro) {
          this.log.warn(`Programação: falha ao processar a página ${pagina}: ${String(erro)}`);
        }
      }

      this.repo.atualizarProgressoSync(rodadaId, vistos.size, novos);
      this.log.info(`Página ${pagina}: ${vistos.size} liberados lidos, ${novos} incluídos.`);

      if (lote.length < tamanhoPagina) break;
    }

    return { pedidosLidos: vistos.size, novos };
  }

  /** Busca nome/telefone dos clientes e inclui os pedidos. Devolve quantos foram incluídos. */
  private async incluirPedidos(pedidosNomus: NomusPedidoLista[]): Promise<number> {
    const idsClientes = [
      ...new Set(pedidosNomus.map((p) => p.idPessoaCliente).filter((v): v is number => typeof v === "number")),
    ];
    const pessoas = await this.carregarPessoas(idsClientes);

    const pedidos: PedidoNomus[] = [];
    for (const p of pedidosNomus) {
      const numero = parseInt(String(p.codigoPedido ?? "").replace(/\D/g, ""), 10);
      if (!Number.isFinite(numero)) {
        this.log.warn(`Pedido ${p.id} ignorado: código "${p.codigoPedido}" não tem número.`);
        continue;
      }

      const clienteId = typeof p.idPessoaCliente === "number" ? p.idPessoaCliente : null;
      const pessoa = clienteId !== null ? pessoas.get(clienteId) : undefined;

      // Pedido incluído nunca mais é atualizado: se a consulta do cliente falhou, deixa o pedido de fora
      // agora (ele continua fora do banco, então a próxima rodada tenta de novo) em vez de gravar um
      // pedido sem nome/telefone para sempre. Cliente cadastrado sem telefone é outra coisa: entra em branco.
      if (clienteId !== null && !pessoa) {
        this.log.warn(`Pedido ${p.codigoPedido} adiado: não foi possível consultar o cliente ${clienteId}. Nova tentativa na próxima rodada.`);
        continue;
      }

      pedidos.push({
        nomusId: p.id as number,
        numero,
        codigoPedido: limpar(p.codigoPedido),
        clienteId,
        clienteNome: pessoa?.nome ?? "",
        telefone: pessoa?.telefone ?? "",
        prazoEntrega: this.prazoDoPedido(p),
      });
    }

    return this.repo.inserirNovos(pedidos, this.agora().toISOString());
  }

  /** Prazo do pedido = a data de entrega mais próxima entre os itens liberados (na prática, todos têm a mesma). */
  private prazoDoPedido(p: NomusPedidoLista): string | null {
    const itens = p.itensPedido ?? [];
    const liberados = itens.filter((i) => i.status === this.opcoes.statusLiberado);
    const datas = (liberados.length > 0 ? liberados : itens)
      .map((i) => brParaIso(i.dataEntrega))
      .filter((d): d is string => d !== null)
      .sort();

    const base = datas[0] ?? null;
    const extra = this.opcoes.diasExtraEntrega ?? 0;
    return base !== null && extra !== 0 ? somarDias(base, extra) : base;
  }

  private async carregarPessoas(ids: number[]): Promise<Map<number, PessoaCache>> {
    const validade = this.opcoes.validadePessoaMs ?? SETE_DIAS_MS;
    const limite = this.agora().getTime() - validade;

    const cache = this.repo.buscarPessoas(ids);
    const faltam = ids.filter((id) => {
      const c = cache.get(id);
      // município nulo = cache de antes do módulo Programação: busca de novo uma vez para guardar cidade/UF.
      return !c || c.municipio == null || Date.parse(c.buscadoEm) < limite;
    });

    for (const lote of emLotes(faltam, this.opcoes.tamanhoLotePessoas ?? 40)) {
      const encontradas = new Map<number, NomusPessoa>();

      // Tenta o lote inteiro numa chamada só; se a Nomus não aceitar, cai para uma chamada por cliente.
      // O RSQL da Nomus não tem `=in=`: o lote é montado com OR (`id=1,id=2,...`).
      try {
        const registros = await this.nomus.get<NomusPessoa[]>(`/pessoas?query=${lote.map((id) => `id=${id}`).join(",")}`);
        for (const r of Array.isArray(registros) ? registros : []) {
          if (typeof r.id === "number" && lote.includes(r.id)) encontradas.set(r.id, r);
        }
      } catch (erro) {
        this.log.warn(`Consulta de clientes em lote falhou (${String(erro)}); consultando um a um.`);
      }

      for (const id of lote) {
        if (encontradas.has(id)) continue;
        try {
          encontradas.set(id, await this.nomus.get<NomusPessoa>(`/pessoas/${id}`));
        } catch (erro) {
          // Não derruba a sincronização: o pedido entra sem nome/telefone e o próximo ciclo tenta de novo.
          this.log.warn(`Cliente ${id} não pôde ser consultado: ${String(erro)}`);
        }
      }

      const buscadoEm = this.agora().toISOString();
      const paraSalvar: PessoaCache[] = [...encontradas.entries()].map(([id, r]) => ({
        nomusId: id,
        nome: limpar(r.nome),
        telefone: limpar(r.telefone),
        buscadoEm,
        municipio: limpar(r.municipio),
        uf: limpar(r.uf).toUpperCase(),
      }));

      this.repo.salvarPessoas(paraSalvar);
      for (const p of paraSalvar) cache.set(p.nomusId, p);
    }

    return cache;
  }
}
