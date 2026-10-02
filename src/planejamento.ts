import { isDataPlausivel } from "./prazo";
import type { PcpRepository } from "./repository";
import type { Logger } from "./sync";
import type { ItemProducao } from "./types";

/**
 * Programação da produção: lê o calendário do Planejamento do sistema de apontamento (GET /api/planejamento) e grava,
 * em cada pedido, a data em que as ordens dele estão agendadas ("Prazo de produção"). O calendário é só leitura
 * para nós: nada é escrito de volta lá.
 */

/** Uma ordem agendada, já validada. */
export interface ItemPlanejado {
  /** Id interno do pedido na Nomus (é o mesmo `nomusId` da tabela do PCP). */
  idPedido: number | null;
  /** Número do pedido tirado do código ("PD 01279" → 1279), usado quando o id não casa. */
  numeroPedido: number | null;
  os: string;
  /** AAAA-MM-DD */
  data: string;
}

export interface ProgramacaoDoPedido {
  prazoProducao: string;
  itens: ItemProducao[];
}

/**
 * Valida a resposta do Planejamento. Item sem data válida ou sem nome de ordem é descartado (não derruba os outros);
 * resposta que nem lista é, isso sim, um erro.
 */
export function lerPlanejamento(corpo: unknown): { itens: ItemPlanejado[]; descartados: number } {
  if (!Array.isArray(corpo)) throw new Error("O Planejamento devolveu algo que não é uma lista.");

  const itens: ItemPlanejado[] = [];
  let descartados = 0;

  for (const bruto of corpo) {
    const x = (typeof bruto === "object" && bruto !== null ? bruto : {}) as Record<string, unknown>;
    const os = typeof x.nomeOrdem === "string" ? x.nomeOrdem.trim() : "";
    const data = typeof x.data === "string" ? x.data : "";

    if (!os || !isDataPlausivel(data)) {
      descartados++;
      continue;
    }

    const idPedido = typeof x.idPedido === "number" && Number.isInteger(x.idPedido) ? x.idPedido : null;
    const digitos = typeof x.pedido === "string" ? x.pedido.replace(/\D/g, "") : "";
    const numeroPedido = digitos !== "" && digitos.length <= 9 ? Number(digitos) : null;

    itens.push({ idPedido, numeroPedido, os, data });
  }

  return { itens, descartados };
}

/**
 * Agrupa as ordens por pedido da tabela. O casamento é pelo id da Nomus; se o id não existir na tabela, tenta pelo
 * número do pedido. O prazo de produção do pedido é a data MAIS TARDIA entre as ordens dele (é quando a produção
 * termina de ser programada, e a que importa comparar com o prazo de entrega).
 */
export function casarComPedidos(
  itens: ItemPlanejado[],
  pedidos: Array<{ nomusId: number; numero: number }>
): { programacao: Map<number, ProgramacaoDoPedido>; semPedido: number } {
  const ids = new Set(pedidos.map((p) => p.nomusId));
  const porNumero = new Map<number, number>();
  for (const p of pedidos) {
    // Mais de um pedido com o mesmo número é raro; vale o mais recente (maior id), como na consulta pública.
    if ((porNumero.get(p.numero) ?? -1) < p.nomusId) porNumero.set(p.numero, p.nomusId);
  }

  const porPedido = new Map<number, ItemProducao[]>();
  let semPedido = 0;

  for (const item of itens) {
    const alvo =
      item.idPedido !== null && ids.has(item.idPedido)
        ? item.idPedido
        : item.numeroPedido !== null
          ? porNumero.get(item.numeroPedido)
          : undefined;

    if (alvo === undefined) {
      semPedido++;
      continue;
    }

    const lista = porPedido.get(alvo) ?? [];
    if (!lista.some((i) => i.os === item.os && i.data === item.data)) lista.push({ os: item.os, data: item.data });
    porPedido.set(alvo, lista);
  }

  const programacao = new Map<number, ProgramacaoDoPedido>();
  for (const [nomusId, lista] of porPedido) {
    lista.sort((a, b) => a.data.localeCompare(b.data) || a.os.localeCompare(b.os));
    programacao.set(nomusId, { prazoProducao: lista[lista.length - 1].data, itens: lista });
  }

  return { programacao, semPedido };
}

export interface PlanejamentoStatus {
  /** False quando PLANEJAMENTO_URL não foi definida: a coluna fica sempre "não programado". */
  configurado: boolean;
  ultimaTentativa: string | null;
  ultimoSucesso: string | null;
  /** Mensagem da última tentativa, se falhou (some quando uma tentativa seguinte dá certo). */
  erro: string | null;
  pedidosProgramados: number;
}

export interface PlanejamentoOptions {
  /** Endereço do sistema de apontamento (ex.: https://apontamento.exemplo.com). Vazio = recurso desligado. */
  url: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  agora?: () => Date;
  log?: Logger;
}

const semLog: Logger = { info() {}, warn() {} };

export class PlanejamentoService {
  private readonly endpoint: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly agora: () => Date;
  private readonly log: Logger;
  private emAndamento: Promise<void> | null = null;
  private ultimaTentativa: string | null = null;
  private ultimoSucesso: string | null = null;
  private erro: string | null = null;

  constructor(private readonly repo: PcpRepository, opcoes: PlanejamentoOptions) {
    this.endpoint = montarEndpoint(opcoes.url);
    this.timeoutMs = opcoes.timeoutMs ?? 20_000;
    this.fetchImpl = opcoes.fetchImpl ?? fetch;
    this.agora = opcoes.agora ?? (() => new Date());
    this.log = opcoes.log ?? semLog;
  }

  configurado(): boolean {
    return this.endpoint !== null;
  }

  status(): PlanejamentoStatus {
    return {
      configurado: this.configurado(),
      ultimaTentativa: this.ultimaTentativa,
      ultimoSucesso: this.ultimoSucesso,
      erro: this.erro,
      pedidosProgramados: this.repo.contarProgramados(),
    };
  }

  /** Uma leitura por vez. Nunca lança: o resultado fica em `status()`, e os dados anteriores só mudam se der certo. */
  executar(): Promise<void> {
    if (!this.endpoint) return Promise.resolve();
    if (this.emAndamento) return this.emAndamento;

    this.emAndamento = this.ler().finally(() => {
      this.emAndamento = null;
    });
    return this.emAndamento;
  }

  private async ler(): Promise<void> {
    this.ultimaTentativa = this.agora().toISOString();

    try {
      const corpo = await this.buscar();
      const { itens, descartados } = lerPlanejamento(corpo);

      // O sistema de apontamento sobe com a lista VAZIA se o arquivo do planejamento estiver ilegível. Apagar a
      // programação inteira por causa disso seria pior que mostrá-la um pouco desatualizada.
      const jaProgramados = this.repo.contarProgramados();
      if (itens.length === 0 && jaProgramados > 0) {
        throw new Error(`O Planejamento devolveu 0 itens, mas há ${jaProgramados} pedidos programados aqui. Nada foi alterado.`);
      }

      const { programacao, semPedido } = casarComPedidos(itens, this.repo.idsENumeros());
      const mudaram = this.repo.aplicarProducao(programacao);

      this.ultimoSucesso = this.agora().toISOString();
      this.erro = null;
      this.log.info(
        `Planejamento: ${itens.length} ordens (${descartados} descartadas), ${programacao.size} pedidos programados, ` +
          `${mudaram} mudaram, ${semPedido} ordens de pedidos que não estão na tabela.`
      );
    } catch (erro) {
      this.erro = (erro instanceof Error ? erro.message : String(erro)).slice(0, 300);
      this.log.warn(`Planejamento: falhou (${this.erro}); mantendo a programação anterior.`);
    }
  }

  private async buscar(): Promise<unknown> {
    const controle = new AbortController();
    const timer = setTimeout(() => controle.abort(), this.timeoutMs);

    try {
      const resposta = await this.fetchImpl(this.endpoint as string, { headers: { Accept: "application/json" }, signal: controle.signal });
      if (!resposta.ok) throw new Error(`O Planejamento respondeu HTTP ${resposta.status}.`);

      const texto = await resposta.text();
      try {
        return JSON.parse(texto) as unknown;
      } catch {
        throw new Error("O Planejamento devolveu uma resposta que não é JSON.");
      }
    } catch (erro) {
      if (controle.signal.aborted) throw new Error(`O Planejamento não respondeu em ${Math.round(this.timeoutMs / 1000)} s.`);
      if (erro instanceof Error && !erro.message.startsWith("O Planejamento")) {
        // O fetch do Node só diz "fetch failed"; o motivo de verdade (ECONNREFUSED, ENOTFOUND...) vem na causa.
        const motivo = (erro as { cause?: { code?: string } }).cause?.code ?? erro.message;
        throw new Error(`Não foi possível conectar ao Planejamento (${motivo}).`);
      }
      throw erro;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Aceita o endereço do sistema ("https://x.com", com ou sem barra final) ou já o caminho completo. Inválido = desligado. */
export function montarEndpoint(url: string): string | null {
  const limpo = url.trim().replace(/\/+$/, "");
  if (!limpo) return null;

  let analisada: URL;
  try {
    analisada = new URL(limpo);
  } catch {
    return null;
  }
  if (analisada.protocol !== "http:" && analisada.protocol !== "https:") return null;

  return limpo.endsWith("/api/planejamento") ? limpo : `${limpo}/api/planejamento`;
}
