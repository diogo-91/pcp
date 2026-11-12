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
      atualizadoEm: (a?.updated_at as string | undefined) ?? null,
      atualizadoPor: (a?.updated_by as string | undefined) ?? null,
    };
    resultado.feitas = contarEtapas(resultado);
    return resultado;
  }

  /** Quantas etapas já têm algo, de todas as devoluções de uma vez (para o botão "Ações 2/5" da lista). */
  feitasPorDevolucao(): Map<number, number> {
    const comPrint = new Map<number, Set<string>>();
    for (const p of this.db.prepare("SELECT DISTINCT devolucao_id, etapa FROM pcp_devolucao_print").all() as Linha[]) {
      const id = p.devolucao_id as number;
      if (!comPrint.has(id)) comPrint.set(id, new Set());
      comPrint.get(id)!.add(p.etapa as string);
    }
    const linhas = new Map<number, Linha>();
    for (const a of this.db.prepare("SELECT * FROM pcp_devolucao_acao").all() as Linha[]) linhas.set(a.devolucao_id as number, a);

    const mapa = new Map<number, number>();
    for (const id of new Set([...comPrint.keys(), ...linhas.keys()])) {
      const a = linhas.get(id) ?? {};
      const tem = (c: string) => String(a[c] ?? "").trim() !== "";
      const print = (e: string) => comPrint.get(id)?.has(e) ?? false;
      mapa.set(
        id,
        (tem("sac_quem") || tem("sac_conversa") || print("sac") ? 1 : 0) +
          (tem("vera_conversa") || print("vera") ? 1 : 0) +
          (tem("dirceu_conversa") || print("dirceu") ? 1 : 0) +
          (tem("decisao") ? 1 : 0) +
          (tem("fin_realizada") ? 1 : 0)
      );
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

    const colunas = Object.keys(valores);
    const agora = this.agora().toISOString();
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
    return this.obter(id);
  }

  lerPrint(printId: number): { mime: string; nome: string; dados: Buffer } {
    const p = this.db.prepare("SELECT mime, nome, dados FROM pcp_devolucao_print WHERE id = ?").get(printId) as Linha | undefined;
    if (!p) throw new ErroProblematicos("Print não encontrado.", 404);
    return { mime: p.mime as string, nome: p.nome as string, dados: Buffer.from(p.dados as Uint8Array) };
  }

  removerPrint(printId: number): AcoesDevolucao {
    const p = this.db.prepare("SELECT devolucao_id FROM pcp_devolucao_print WHERE id = ?").get(printId) as Linha | undefined;
    if (!p) throw new ErroProblematicos("Print não encontrado.", 404);
    this.db.prepare("DELETE FROM pcp_devolucao_print WHERE id = ?").run(printId);
    return this.obter(p.devolucao_id as number);
  }

  /** Chamado ao excluir a devolução: leva junto as ações e os prints. */
  apagarDaDevolucao(id: number): void {
    this.db.prepare("DELETE FROM pcp_devolucao_print WHERE devolucao_id = ?").run(id);
    this.db.prepare("DELETE FROM pcp_devolucao_acao WHERE devolucao_id = ?").run(id);
  }
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
