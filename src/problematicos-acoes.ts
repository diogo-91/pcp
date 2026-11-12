import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./db";
import { isDataPlausivel } from "./prazo";
import { ErroProblematicos } from "./problematicos";

/**
 * "Ações" de um pedido de devolução: o caminho do atendimento em 5 etapas.
 *  1 SAC (quem falou com o cliente, o que foi conversado, prints) · 2 Vera · 3 Dirceu (o que foi conversado, prints)
 *  4 Decisão (mantém o pedido ou o cliente quer cancelar) · 5 Financeiro (devolução realizada? e a data).
 * Os prints ficam no próprio banco (um só arquivo, já entra no backup).
 */

export const ETAPAS_COM_PRINT = ["sac", "vera", "dirceu"] as const;
export type EtapaComPrint = (typeof ETAPAS_COM_PRINT)[number];

export const DECISOES = ["MANTEM", "CANCELAR"] as const;
export const MAX_PRINT_BYTES = 4 * 1024 * 1024;
export const MAX_PRINTS_POR_ETAPA = 10;

/** Só imagens comuns (nunca SVG, que poderia carregar script). Confere os primeiros bytes, não só o tipo informado. */
const ASSINATURAS: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  "image/gif": (b) => b.length > 6 && ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")),
};

type Linha = Record<string, unknown>;

export interface PrintInfo {
  id: number;
  nome: string;
  criadoEm: string;
}

export interface AcoesDevolucao {
  sac: { quem: string; conversa: string; prints: PrintInfo[] };
  vera: { conversa: string; prints: PrintInfo[] };
  dirceu: { conversa: string; prints: PrintInfo[] };
  decisao: "" | (typeof DECISOES)[number];
  financeiro: { realizada: "" | "SIM" | "NAO"; data: string | null };
  /** Quantas das 5 etapas já têm alguma coisa preenchida. */
  feitas: number;
  /** Quando cada etapa foi preenchida/alterada por último (linha do tempo). */
  datas: Record<"sac" | "vera" | "dirceu" | "decisao" | "financeiro", string | null>;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
}

const limpar = (t: unknown) => String(t ?? "").replace(/\r\n/g, "\n").trim();

const TEXTOS: Record<string, { coluna: string; max: number; nome: string }> = {
  sacQuem: { coluna: "sac_quem", max: 120, nome: "Quem falou com o cliente" },
  sacConversa: { coluna: "sac_conversa", max: 3000, nome: "A conversa do SAC" },
  veraConversa: { coluna: "vera_conversa", max: 3000, nome: "A conversa da Vera" },
  dirceuConversa: { coluna: "dirceu_conversa", max: 3000, nome: "A conversa do Dirceu" },
};

export class AcoesDevolucaoService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly agora: () => Date = () => new Date()
  ) {}

  private garantirDevolucao(id: number): void {
    if (!this.db.prepare("SELECT 1 FROM pcp_devolucao WHERE id = ?").get(id)) throw new ErroProblematicos("Devolução não encontrada.", 404);
  }

  private prints(id: number, etapa: EtapaComPrint): PrintInfo[] {
    return (this.db.prepare("SELECT id, nome, created_at FROM pcp_devolucao_print WHERE devolucao_id = ? AND etapa = ? ORDER BY id").all(id, etapa) as Linha[]).map((p) => ({
      id: p.id as number,
      nome: p.nome as string,
      criadoEm: p.created_at as string,
    }));
  }

  /** Ações em branco (devolução que ainda não tem nada registrado). */
  vazio(): AcoesDevolucao {
    return { sac: { quem: "", conversa: "", prints: [] }, vera: { conversa: "", prints: [] }, dirceu: { conversa: "", prints: [] }, decisao: "", financeiro: { realizada: "", data: null }, feitas: 0, datas: { sac: null, vera: null, dirceu: null, decisao: null, financeiro: null }, atualizadoEm: null, atualizadoPor: null };
  }

  obter(id: number): AcoesDevolucao {
    this.garantirDevolucao(id);
    const a = this.db.prepare("SELECT * FROM pcp_devolucao_acao WHERE devolucao_id = ?").get(id) as Linha | undefined;
    const texto = (c: string) => String(a?.[c] ?? "");
    const resultado: AcoesDevolucao = {
      sac: { quem: texto("sac_quem"), conversa: texto("sac_conversa"), prints: this.prints(id, "sac") },
      vera: { conversa: texto("vera_conversa"), prints: this.prints(id, "vera") },
      dirceu: { conversa: texto("dirceu_conversa"), prints: this.prints(id, "dirceu") },
      decisao: (texto("decisao") as AcoesDevolucao["decisao"]) || "",
      financeiro: { realizada: (texto("fin_realizada") as "" | "SIM" | "NAO") || "", data: (a?.fin_data as string | null | undefined) ?? null },
      feitas: 0,
      datas: { sac: (a?.sac_em as string | null | undefined) ?? null, vera: (a?.vera_em as string | null | undefined) ?? null, dirceu: (a?.dirceu_em as string | null | undefined) ?? null, decisao: (a?.decisao_em as string | null | undefined) ?? null, financeiro: (a?.fin_em as string | null | undefined) ?? null },
      atualizadoEm: (a?.updated_at as string | undefined) ?? null,
      atualizadoPor: (a?.updated_by as string | undefined) ?? null,
    };
    resultado.feitas = contarEtapas(resultado);
    return resultado;
  }

  /** Situação das 5 etapas de cada devolução que já tem algo (para a coluna "Etapas" da lista). */
  etapasPorDevolucao(): Map<number, EtapaResumo[]> {
    const ids = new Set<number>();
    for (const r of this.db.prepare("SELECT devolucao_id FROM pcp_devolucao_acao UNION SELECT devolucao_id FROM pcp_devolucao_print").all() as Linha[]) ids.add(r.devolucao_id as number);
    const mapa = new Map<number, EtapaResumo[]>();
    for (const id of ids) {
      if (!this.db.prepare("SELECT 1 FROM pcp_devolucao WHERE id = ?").get(id)) continue;
      mapa.set(id, resumirEtapas(this.obter(id)));
    }
    return mapa;
  }

  /** Grava os campos enviados (os demais ficam como estão). */
  salvar(id: number, corpo: Record<string, unknown>, usuario: string): AcoesDevolucao {
    this.garantirDevolucao(id);
    const valores: Record<string, unknown> = {};

    for (const [chave, def] of Object.entries(TEXTOS)) {
      if (!(chave in corpo)) continue;
      const t = limpar(corpo[chave]);
      if (t.length > def.max) throw new ErroProblematicos(`${def.nome} passa de ${def.max} caracteres.`);
      valores[def.coluna] = t;
    }
    if ("decisao" in corpo) {
      const v = corpo.decisao;
      if (v !== "" && v !== null && !(DECISOES as readonly unknown[]).includes(v)) throw new ErroProblematicos("Decisão inválida: use MANTEM ou CANCELAR.");
      valores.decisao = v ?? "";
    }
    if ("finRealizada" in corpo) {
      const v = corpo.finRealizada;
      if (v !== "" && v !== null && v !== "SIM" && v !== "NAO") throw new ErroProblematicos("Devolução realizada: use SIM ou NAO.");
      valores.fin_realizada = v ?? "";
      if (v !== "SIM") valores.fin_data = null; // a data só vale quando a devolução foi realizada
    }
    if ("finData" in corpo) {
      const v = corpo.finData;
      if (v === null || v === "") valores.fin_data = null;
      else if (typeof v === "string" && isDataPlausivel(v)) {
        const atual = (this.db.prepare("SELECT fin_realizada FROM pcp_devolucao_acao WHERE devolucao_id = ?").get(id) as Linha | undefined)?.fin_realizada;
        const situacao = "finRealizada" in corpo ? corpo.finRealizada : atual;
        if (situacao !== "SIM") throw new ErroProblematicos("A data só pode ser informada quando a devolução foi realizada.");
        valores.fin_data = v;
      } else throw new ErroProblematicos("A data da devolução deve ser uma data válida (AAAA-MM-DD).");
    }
    if (Object.keys(valores).length === 0) throw new ErroProblematicos("Informe ao menos um campo para atualizar.");

    const agora = this.agora().toISOString();
    // Carimba a etapa mexida (a linha do tempo mostra quando cada uma foi preenchida).
    if ("sac_quem" in valores || "sac_conversa" in valores) valores.sac_em = agora;
    if ("vera_conversa" in valores) valores.vera_em = agora;
    if ("dirceu_conversa" in valores) valores.dirceu_em = agora;
    if ("decisao" in valores) valores.decisao_em = agora;
    if ("fin_realizada" in valores || "fin_data" in valores) valores.fin_em = agora;
    const colunas = Object.keys(valores);
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO pcp_devolucao_acao (devolucao_id, ${colunas.join(", ")}, updated_at, updated_by) VALUES (?, ${colunas.map(() => "?").join(", ")}, ?, ?)
           ON CONFLICT(devolucao_id) DO UPDATE SET ${colunas.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
        )
        .run(...([id, ...Object.values(valores), agora, usuario] as never[]));
    });
    return this.obter(id);
  }

  adicionarPrint(id: number, etapa: string, nome: unknown, mime: unknown, base64: unknown, usuario: string): AcoesDevolucao {
    this.garantirDevolucao(id);
    if (!(ETAPAS_COM_PRINT as readonly string[]).includes(etapa)) throw new ErroProblematicos("Etapa inválida para anexar print.");
    if (typeof mime !== "string" || !Object.prototype.hasOwnProperty.call(ASSINATURAS, mime)) throw new ErroProblematicos("Anexe uma imagem PNG, JPG, WEBP ou GIF.");
    if (typeof base64 !== "string" || base64 === "") throw new ErroProblematicos("Arquivo vazio.");
    const dados = Buffer.from(base64, "base64");
    if (dados.length === 0) throw new ErroProblematicos("Arquivo vazio.");
    if (dados.length > MAX_PRINT_BYTES) throw new ErroProblematicos("A imagem passa de 4 MB.");
    if (!ASSINATURAS[mime](dados)) throw new ErroProblematicos("O arquivo não é uma imagem válida.");
    const ja = (this.db.prepare("SELECT COUNT(*) AS n FROM pcp_devolucao_print WHERE devolucao_id = ? AND etapa = ?").get(id, etapa) as { n: number }).n;
    if (ja >= MAX_PRINTS_POR_ETAPA) throw new ErroProblematicos(`No máximo ${MAX_PRINTS_POR_ETAPA} prints por etapa.`);

    const nomeLimpo = limpar(nome).replace(/[\\/\r\n\t]/g, " ").slice(0, 120) || "print";
    this.db
      .prepare("INSERT INTO pcp_devolucao_print (devolucao_id, etapa, nome, mime, dados, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, etapa, nomeLimpo, mime, dados, this.agora().toISOString(), usuario);
    this.carimbar(id, etapa, usuario);
    return this.obter(id);
  }

  /** Marca a etapa como mexida agora (usado ao anexar/remover print, que não passa por `salvar`). */
  private carimbar(id: number, etapa: string, usuario: string): void {
    const col = ({ sac: "sac_em", vera: "vera_em", dirceu: "dirceu_em" } as Record<string, string>)[etapa];
    if (!col) return;
    const agora = this.agora().toISOString();
    this.db
      .prepare(
        `INSERT INTO pcp_devolucao_acao (devolucao_id, ${col}, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(devolucao_id) DO UPDATE SET ${col} = excluded.${col}, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      )
      .run(id, agora, agora, usuario);
  }

  lerPrint(printId: number): { mime: string; nome: string; dados: Buffer } {
    const p = this.db.prepare("SELECT mime, nome, dados FROM pcp_devolucao_print WHERE id = ?").get(printId) as Linha | undefined;
    if (!p) throw new ErroProblematicos("Print não encontrado.", 404);
    return { mime: p.mime as string, nome: p.nome as string, dados: Buffer.from(p.dados as Uint8Array) };
  }

  removerPrint(printId: number): AcoesDevolucao {
    const p = this.db.prepare("SELECT devolucao_id, etapa FROM pcp_devolucao_print WHERE id = ?").get(printId) as Linha | undefined;
    if (!p) throw new ErroProblematicos("Print não encontrado.", 404);
    this.db.prepare("DELETE FROM pcp_devolucao_print WHERE id = ?").run(printId);
    this.carimbar(p.devolucao_id as number, p.etapa as string, "PCP");
    return this.obter(p.devolucao_id as number);
  }

  /** Chamado ao excluir a devolução: leva junto as ações e os prints. */
  apagarDaDevolucao(id: number): void {
    this.db.prepare("DELETE FROM pcp_devolucao_print WHERE devolucao_id = ?").run(id);
    this.db.prepare("DELETE FROM pcp_devolucao_acao WHERE devolucao_id = ?").run(id);
  }
}

export interface EtapaResumo {
  chave: "sac" | "vera" | "dirceu" | "decisao" | "financeiro";
  nome: string;
  feita: boolean;
  /** Texto curto do que foi registrado (aparece ao passar o mouse), ex.: "Cliente quer cancelar". */
  detalhe: string;
  /** Quando foi preenchida/alterada por último; nulo se ainda não foi. */
  em: string | null;
}

const dataBr = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : "");

export function resumirEtapas(a: AcoesDevolucao): EtapaResumo[] {
  const conversa = (t: string, prints: number) => [t ? (t.length > 80 ? `${t.slice(0, 80)}…` : t) : "", prints ? `${prints} print${prints > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
  const lista: Array<Omit<EtapaResumo, "em">> = [
    { chave: "sac", nome: "SAC", feita: !!(a.sac.quem || a.sac.conversa || a.sac.prints.length), detalhe: [a.sac.quem && `Atendeu: ${a.sac.quem}`, conversa(a.sac.conversa, a.sac.prints.length)].filter(Boolean).join(" · ") },
    { chave: "vera", nome: "Vera", feita: !!(a.vera.conversa || a.vera.prints.length), detalhe: conversa(a.vera.conversa, a.vera.prints.length) },
    { chave: "dirceu", nome: "Dirceu", feita: !!(a.dirceu.conversa || a.dirceu.prints.length), detalhe: conversa(a.dirceu.conversa, a.dirceu.prints.length) },
    { chave: "decisao", nome: "Decisão", feita: !!a.decisao, detalhe: a.decisao === "MANTEM" ? "Mantém o pedido" : a.decisao === "CANCELAR" ? "Cliente quer cancelar" : "" },
    {
      chave: "financeiro",
      nome: "Financeiro",
      feita: !!a.financeiro.realizada,
      detalhe: a.financeiro.realizada === "SIM" ? `Devolução realizada${a.financeiro.data ? ` em ${dataBr(a.financeiro.data)}` : ""}` : a.financeiro.realizada === "NAO" ? "Devolução ainda não realizada" : "",
    },
  ];
  return lista.map((e) => ({ ...e, em: e.feita ? a.datas[e.chave] : null }));
}

function contarEtapas(a: AcoesDevolucao): number {
  return (
    (a.sac.quem || a.sac.conversa || a.sac.prints.length ? 1 : 0) +
    (a.vera.conversa || a.vera.prints.length ? 1 : 0) +
    (a.dirceu.conversa || a.dirceu.prints.length ? 1 : 0) +
    (a.decisao ? 1 : 0) +
    (a.financeiro.realizada ? 1 : 0)
  );
}
