import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./db";
import { isDataPlausivel } from "./prazo";
import { reaisParaCentavos } from "./programacao/regras";
import type { NomusLeitor } from "./sync";

type Linha = Record<string, unknown>;

export class ErroProblematicos extends Error {
  constructor(
    mensagem: string,
    public readonly codigo = 400
  ) {
    super(mensagem);
  }
}

export const TIPOS_PROBLEMATICOS = ["urgentes", "devolucoes", "defeitos"] as const;
export type TipoProblematico = (typeof TIPOS_PROBLEMATICOS)[number];

interface CampoDef {
  chave: string;
  coluna: string;
  tipo: "data" | "texto" | "dinheiro" | "status";
  max?: number;
  obrigatorio?: boolean;
}

/** As três tabelas do botão "Pedidos Problemáticos": o número do pedido é comum; o resto muda. */
const TABELAS: Record<TipoProblematico, { tabela: string; campos: CampoDef[] }> = {
  urgentes: {
    tabela: "pcp_urgente",
    campos: [
      { chave: "dataEntregaCombinada", coluna: "data_entrega_combinada", tipo: "data", obrigatorio: true },
      { chave: "status", coluna: "status", tipo: "status" },
    ],
  },
  devolucoes: {
    tabela: "pcp_devolucao",
    campos: [
      { chave: "formaPagamento", coluna: "forma_pagamento", tipo: "texto", max: 300 },
      { chave: "valor", coluna: "valor_centavos", tipo: "dinheiro" },
      { chave: "status", coluna: "status", tipo: "status" },
    ],
  },
  defeitos: {
    tabela: "pcp_defeito",
    campos: [
      { chave: "causa", coluna: "causa", tipo: "texto", max: 500, obrigatorio: true },
      { chave: "motorista", coluna: "motorista", tipo: "texto", max: 100 },
      { chave: "status", coluna: "status", tipo: "status" },
    ],
  },
};

export const STATUS_PROBLEMATICO = ["NAO_REALIZADA", "REALIZADA"] as const;

export interface PedidoEncontrado {
  numero: number;
  nomusId: number | null;
  cliente: string;
  /** Onde achou: o próprio PCP ou a Nomus (pedido antigo que já saiu da tabela). */
  origem: "pcp" | "nomus";
}

export interface DetalheDoPedido extends PedidoEncontrado {
  /** Total do pedido de venda, em reais (só referência: o campo `valor` é o que foi pago agora). */
  valorTotal?: number | null;
  /** Preenchido quando a Nomus não respondeu a tempo: explica o que está faltando ou desatualizado. */
  aviso?: string;
  /** Valor pago de uma vez: o da ENTRADA quando o pagamento é dividido, ou o total quando é pagamento único. Em reais. */
  valor: number | null;
  /** Forma(s) de pagamento do pedido de venda, ex.: "Pix" ou "Pix + Cartão de Crédito". */
  formaPagamento: string;
  prazoEntrega: string | null;
}

interface NomusPedido {
  id?: number;
  codigoPedido?: string;
  idPessoaCliente?: number;
  idFormaPagamento?: number;
  valorTotal?: string;
  dataEntregaPadrao?: string;
  itensPedido?: Array<{ dataEntrega?: string }>;
  parcelas?: Array<{ idFormaPagamento?: number; observacao?: string; valorParcela?: string }>;
}

const brl = (centavos: number) => (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/\u00a0/g, " ");

/**
 * Forma(s) de pagamento do pedido de venda. Com mais de uma parcela mostra cada uma, com o rótulo que a Nomus guarda
 * (entrada, entrega…) e o valor: "Entrada: Pix R$ 726,00 + Entrega: Cartão de Crédito R$ 4.861,20".
 * Com uma parcela só (ou sem parcelas) mostra apenas o nome da forma, ex.: "Pix".
 */
export function descreverPagamento(p: NomusPedido, nomes: Map<number, string>): string {
  const parcelas = p.parcelas ?? [];
  const nome = (id: number | undefined) => (typeof id === "number" ? (nomes.get(id) ?? "") : "");

  if (parcelas.length <= 1) return nome(parcelas[0]?.idFormaPagamento ?? p.idFormaPagamento);

  const partes = parcelas.map((x, i) => {
    const forma = nome(x.idFormaPagamento ?? p.idFormaPagamento) || "forma não informada";
    const rotulo = limpar(x.observacao).toLowerCase();
    const titulo = rotulo.startsWith("entrada") ? "Entrada" : rotulo.startsWith("entrega") ? "Entrega" : rotulo ? rotulo.charAt(0).toUpperCase() + rotulo.slice(1, 24) : `Parcela ${i + 1}`;
    const centavos = reaisParaCentavos(x.valorParcela);
    return `${titulo}: ${forma}${centavos === null ? "" : ` ${brl(centavos)}`}`;
  });
  return partes.join(" + ");
}

/** Valor "pago agora": entrada (parcela rotulada "entrada", ou a primeira) quando há mais de uma parcela; senão o total. */
export function valorPagoAgora(p: NomusPedido, totalCentavos: number | null): number | null {
  const parcelas = p.parcelas ?? [];
  if (parcelas.length <= 1) return totalCentavos;
  const entrada = parcelas.find((x) => limpar(x.observacao).toLowerCase().startsWith("entrada")) ?? parcelas[0];
  return reaisParaCentavos(entrada.valorParcela) ?? totalCentavos;
}

const codigoDoPedido = (numero: number) => `PD ${String(numero).padStart(5, "0")}`;
const limpar = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim();

function dataBr(texto: string | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(texto ?? "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export class ProblematicosService {
  private formasCache: { em: number; nomes: Map<number, string> } | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly nomus: NomusLeitor | null,
    private readonly agora: () => Date = () => new Date(),
    /** Quanto esperar a Nomus ao preencher o formulário (ela limita as consultas e pode demorar). */
    private readonly tempoLimiteMs = 25_000
  ) {}

  // ------------------------------------------------------------ busca e preenchimento automático

  /** Busca por número (começa com) ou por nome do cliente; se for um número exato que o PCP não tem, tenta a Nomus. */
  async buscarPedidos(q: string): Promise<PedidoEncontrado[]> {
    const t = limpar(q);
    if (t.length < 1) return [];
    const achados: PedidoEncontrado[] = [];

    if (/^\d+$/.test(t)) {
      const linhas = this.db.prepare("SELECT nomus_id, numero, cliente_nome FROM pedidos WHERE CAST(numero AS TEXT) LIKE ? ORDER BY numero DESC LIMIT 8").all(`${t}%`) as Linha[];
      for (const l of linhas) achados.push({ numero: l.numero as number, nomusId: l.nomus_id as number, cliente: l.cliente_nome as string, origem: "pcp" });
      const exato = Number(t);
      if (!achados.some((a) => a.numero === exato) && exato > 0 && this.nomus) {
        const n = await this.buscarNaNomus(exato).catch(() => null);
        if (n) achados.unshift({ numero: exato, nomusId: n.nomusId, cliente: n.cliente, origem: "nomus" });
      }
    } else if (t.length >= 2) {
      const curinga = `%${t.replace(/[%_]/g, "")}%`;
      const linhas = this.db.prepare("SELECT nomus_id, numero, cliente_nome FROM pedidos WHERE cliente_nome LIKE ? ORDER BY numero DESC LIMIT 8").all(curinga) as Linha[];
      for (const l of linhas) achados.push({ numero: l.numero as number, nomusId: l.nomus_id as number, cliente: l.cliente_nome as string, origem: "pcp" });
    }
    return achados;
  }

  private async nomesDasFormas(): Promise<Map<number, string>> {
    const agora = this.agora().getTime();
    if (this.formasCache && agora - this.formasCache.em < 24 * 3600_000) return this.formasCache.nomes;
    const lista = this.nomus ? await this.nomus.get<Array<{ id?: number; nome?: string; descricao?: string }>>("/formasPagamento") : [];
    const nomes = new Map<number, string>();
    for (const f of Array.isArray(lista) ? lista : []) if (typeof f.id === "number") nomes.set(f.id, limpar(f.nome ?? f.descricao));
    this.formasCache = { em: agora, nomes };
    return nomes;
  }

  private async buscarNaNomus(numero: number): Promise<DetalheDoPedido | null> {
    if (!this.nomus) return null;
    const lista = await this.nomus.get<NomusPedido[]>(`/pedidos?query=${encodeURIComponent(`codigoPedido=="${codigoDoPedido(numero)}"`)}`);
    const p = Array.isArray(lista) ? lista.find((x) => limpar(x.codigoPedido) === codigoDoPedido(numero)) : undefined;
    if (!p || typeof p.id !== "number") return null;

    let cliente = "";
    if (typeof p.idPessoaCliente === "number") {
      const pessoa = await this.nomus.get<{ nome?: string }>(`/pessoas/${p.idPessoaCliente}`).catch(() => null);
      cliente = limpar(pessoa?.nome);
    }
    const nomes = await this.nomesDasFormas().catch(() => new Map<number, string>());
    const formaPagamento = descreverPagamento(p, nomes);
    const datas = (p.itensPedido ?? []).map((i) => dataBr(i.dataEntrega)).filter((d): d is string => d !== null).sort();
    const centavos = reaisParaCentavos(p.valorTotal);

    return {
      numero,
      nomusId: p.id,
      cliente,
      origem: "nomus",
      valor: ((): number | null => { const v = valorPagoAgora(p, centavos); return v === null ? null : v / 100; })(),
      valorTotal: centavos === null ? null : centavos / 100,
      formaPagamento,
      prazoEntrega: datas[0] ?? dataBr(p.dataEntregaPadrao),
    };
  }

  /** Dados do pedido para preencher o formulário: valor e forma de pagamento vêm do pedido de venda da Nomus. */
  async detalhe(numero: number): Promise<DetalheDoPedido> {
    if (!Number.isInteger(numero) || numero <= 0) throw new ErroProblematicos("Número de pedido inválido.");
    const local = this.db.prepare("SELECT nomus_id, cliente_nome FROM pedidos WHERE numero = ? ORDER BY nomus_id DESC LIMIT 1").get(numero) as Linha | undefined;

    // A consulta continua em segundo plano mesmo se estourar o tempo: o resultado vai para a cópia local e a próxima vez é instantânea.
    const consulta = this.buscarNaNomus(numero);
    consulta.then((d) => d && this.guardarCopia(d)).catch(() => undefined);

    let nomus: DetalheDoPedido | null = null;
    let erro: string | null = null;
    try {
      nomus = await this.comTempo(consulta);
    } catch (e) {
      erro = e instanceof Error ? e.message : String(e);
    }
    if (nomus) return { ...nomus, cliente: nomus.cliente || (local?.cliente_nome as string) || "", origem: local ? "pcp" : "nomus" };
    if (!erro && !local) throw new ErroProblematicos(`Pedido ${numero} não encontrado.`, 404);

    // A Nomus não respondeu a tempo (ou não achou): usa a última cópia, ou o que o PCP já tem do pedido.
    const copia = this.db.prepare("SELECT * FROM pcp_pedido_financeiro WHERE numero = ?").get(numero) as Linha | undefined;
    const prog = this.db.prepare("SELECT valor_centavos FROM pcp_pedido WHERE numero_pedido = ? ORDER BY id DESC LIMIT 1").get(numero) as Linha | undefined;
    const valorCentavos = (copia?.valor_centavos as number | null | undefined) ?? (prog?.valor_centavos as number | null | undefined) ?? null;
    const forma = (copia?.forma_pagamento as string | undefined) ?? "";
    const cliente = (local?.cliente_nome as string) || (copia?.cliente_nome as string) || "";
    if (!local && !copia) throw new ErroProblematicos(`Não foi possível consultar a Nomus: ${erro}`, 502);

    return {
      numero,
      nomusId: (local?.nomus_id as number | undefined) ?? null,
      cliente,
      origem: "pcp",
      valor: valorCentavos === null ? null : valorCentavos / 100,
      valorTotal: prog?.valor_centavos == null ? null : (prog.valor_centavos as number) / 100,
      formaPagamento: forma,
      prazoEntrega: (copia?.prazo_entrega as string | null | undefined) ?? null,
      aviso: copia
        ? `A Nomus não respondeu agora (${erro}); mostrando a última consulta, de ${String(copia.atualizado_em).slice(0, 10)}.`
        : `A Nomus não respondeu agora (${erro}). ${valorCentavos !== null ? "O valor vem do cadastro do PCP; a" : "A"} forma de pagamento precisa ser preenchida à mão, ou tente de novo em instantes.`,
    };
  }

  private comTempo<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`demorou mais de ${Math.round(this.tempoLimiteMs / 1000)} s`)), this.tempoLimiteMs);
      p.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  private guardarCopia(d: DetalheDoPedido): void {
    this.db
      .prepare(
        `INSERT INTO pcp_pedido_financeiro (numero, cliente_nome, valor_centavos, forma_pagamento, prazo_entrega, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(numero) DO UPDATE SET cliente_nome = excluded.cliente_nome, valor_centavos = excluded.valor_centavos,
           forma_pagamento = excluded.forma_pagamento, prazo_entrega = excluded.prazo_entrega, atualizado_em = excluded.atualizado_em`
      )
      .run(d.numero, d.cliente, d.valor === null ? null : Math.round(d.valor * 100), d.formaPagamento, d.prazoEntrega, this.agora().toISOString());
  }

  // ------------------------------------------------------------ CRUD das três tabelas

  private paraSaida(tipo: TipoProblematico, l: Linha) {
    const saida: Record<string, unknown> = {
      id: l.id as number,
      numeroPedido: l.numero_pedido as number,
      cliente: l.cliente_nome as string,
      criadoEm: l.created_at as string,
      atualizadoEm: l.updated_at as string,
      atualizadoPor: l.updated_by as string,
    };
    for (const c of TABELAS[tipo].campos) {
      const v = l[c.coluna];
      saida[c.chave] = c.tipo === "dinheiro" ? (v === null || v === undefined ? null : (v as number) / 100) : (v ?? (c.tipo === "data" ? null : ""));
    }
    return saida;
  }

  listar() {
    const lista = (tipo: TipoProblematico) =>
      (this.db.prepare(`SELECT * FROM ${TABELAS[tipo].tabela} ORDER BY id DESC`).all() as Linha[]).map((l) => this.paraSaida(tipo, l));
    return { urgentes: lista("urgentes"), devolucoes: lista("devolucoes"), defeitos: lista("defeitos") };
  }

  private validarCampos(tipo: TipoProblematico, corpo: Record<string, unknown>, parcial: boolean): Record<string, unknown> {
    const valores: Record<string, unknown> = {};
    for (const c of TABELAS[tipo].campos) {
      if (!(c.chave in corpo)) {
        if (!parcial && c.obrigatorio) throw new ErroProblematicos(`Informe ${rotulo(c.chave)}.`);
        continue;
      }
      const v = corpo[c.chave];
      if (c.tipo === "data") {
        if (v === null || v === "") {
          if (c.obrigatorio) throw new ErroProblematicos(`Informe ${rotulo(c.chave)}.`);
          valores[c.coluna] = null;
        } else if (typeof v === "string" && isDataPlausivel(v)) valores[c.coluna] = v;
        else throw new ErroProblematicos(`${rotulo(c.chave)} deve ser uma data válida (AAAA-MM-DD).`);
      } else if (c.tipo === "status") {
        if (typeof v !== "string" || !(STATUS_PROBLEMATICO as readonly string[]).includes(v)) throw new ErroProblematicos("Status inválido: use REALIZADA ou NAO_REALIZADA.");
        valores[c.coluna] = v;
      } else if (c.tipo === "dinheiro") {
        if (v === null || v === "") valores[c.coluna] = null;
        else if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100_000_000) valores[c.coluna] = Math.round(v * 100);
        else throw new ErroProblematicos("Valor inválido.");
      } else {
        const t = limpar(v);
        if (c.obrigatorio && t === "") throw new ErroProblematicos(`Informe ${rotulo(c.chave)}.`);
        if (t.length > (c.max ?? 200)) throw new ErroProblematicos(`${rotulo(c.chave)} passa de ${c.max} caracteres.`);
        valores[c.coluna] = t;
      }
    }
    return valores;
  }

  /** Cria o registro. Em devoluções, forma de pagamento e valor não informados são preenchidos pelo pedido de venda. */
  async criar(tipo: TipoProblematico, corpo: Record<string, unknown>, usuario: string): Promise<number> {
    const numero = corpo.numeroPedido;
    if (typeof numero !== "number" || !Number.isInteger(numero) || numero <= 0) throw new ErroProblematicos("Informe o número do pedido.");

    const entrada = { ...corpo };
    let cliente = limpar(corpo.cliente).slice(0, 120);
    if (tipo === "devolucoes" && (!("formaPagamento" in entrada) || !("valor" in entrada) || !cliente)) {
      const d = await this.detalhe(numero).catch(() => null);
      if (d) {
        if (!("formaPagamento" in entrada)) entrada.formaPagamento = d.formaPagamento;
        if (!("valor" in entrada)) entrada.valor = d.valor;
        cliente = cliente || d.cliente;
      }
    }
    if (!cliente) {
      const local = this.db.prepare("SELECT cliente_nome FROM pedidos WHERE numero = ? ORDER BY nomus_id DESC LIMIT 1").get(numero) as Linha | undefined;
      cliente = (local?.cliente_nome as string) ?? "";
    }

    const valores = this.validarCampos(tipo, entrada, false);
    const agora = this.agora().toISOString();
    const t = TABELAS[tipo];
    const colunas = ["numero_pedido", "cliente_nome", ...Object.keys(valores), "created_at", "updated_at", "updated_by"];
    const r = this.db
      .prepare(`INSERT INTO ${t.tabela} (${colunas.join(", ")}) VALUES (${colunas.map(() => "?").join(", ")})`)
      .run(...([numero, cliente, ...Object.values(valores), agora, agora, usuario] as never[]));
    return Number(r.lastInsertRowid);
  }

  editar(tipo: TipoProblematico, id: number, corpo: Record<string, unknown>, usuario: string): void {
    const t = TABELAS[tipo];
    if (!this.db.prepare(`SELECT 1 FROM ${t.tabela} WHERE id = ?`).get(id)) throw new ErroProblematicos("Registro não encontrado.", 404);
    const valores = this.validarCampos(tipo, corpo, true);
    if ("numeroPedido" in corpo) {
      const n = corpo.numeroPedido;
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) throw new ErroProblematicos("Número de pedido inválido.");
      valores.numero_pedido = n;
    }
    if (Object.keys(valores).length === 0) throw new ErroProblematicos("Informe ao menos um campo para atualizar.");
    const sets = Object.keys(valores).map((c) => `${c} = ?`);
    inTransaction(this.db, () =>
      this.db.prepare(`UPDATE ${t.tabela} SET ${sets.join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`).run(...([...Object.values(valores), this.agora().toISOString(), usuario, id] as never[]))
    );
  }

  remover(tipo: TipoProblematico, id: number): void {
    const r = this.db.prepare(`DELETE FROM ${TABELAS[tipo].tabela} WHERE id = ?`).run(id);
    if (Number(r.changes) === 0) throw new ErroProblematicos("Registro não encontrado.", 404);
  }
}

const rotulo = (chave: string) =>
  ({ status: "o status", dataEntregaCombinada: "a data de entrega combinada", formaPagamento: "a forma de pagamento", valor: "o valor", causa: "a causa", motorista: "o motorista" })[chave] ?? chave;
