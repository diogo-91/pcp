import type { DatabaseSync } from "node:sqlite";
import { ErroProblematicos } from "./problematicos";

/**
 * Anexos dos registros de Clientes / Defeitos (foto do defeito, laudo em PDF, conversa...).
 * Ficam no próprio banco (um arquivo só, entra no backup). Só imagem comum e PDF: nunca SVG/HTML, que poderiam carregar script.
 */

export const MAX_ANEXO_BYTES = 5 * 1024 * 1024;
export const MAX_ANEXOS_POR_DEFEITO = 15;

const ASSINATURAS: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  "image/gif": (b) => b.length > 6 && ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")),
  "application/pdf": (b) => b.length > 5 && b.subarray(0, 5).toString("latin1") === "%PDF-",
};

type Linha = Record<string, unknown>;

export interface AnexoInfo {
  id: number;
  nome: string;
  tipo: string;
  tamanho: number;
  criadoEm: string;
  criadoPor: string;
}

export class AnexosDefeitoService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly agora: () => Date = () => new Date()
  ) {}

  /** Lista (só os dados, sem o arquivo) dos anexos de todos os defeitos, agrupados por defeito. */
  porDefeito(): Map<number, AnexoInfo[]> {
    const mapa = new Map<number, AnexoInfo[]>();
    for (const a of this.db.prepare("SELECT id, defeito_id, nome, mime, LENGTH(dados) AS tamanho, created_at, created_by FROM pcp_defeito_anexo ORDER BY id").all() as Linha[]) {
      const id = a.defeito_id as number;
      if (!mapa.has(id)) mapa.set(id, []);
      mapa.get(id)!.push({ id: a.id as number, nome: a.nome as string, tipo: a.mime as string, tamanho: a.tamanho as number, criadoEm: a.created_at as string, criadoPor: a.created_by as string });
    }
    return mapa;
  }

  adicionar(defeitoId: number, nome: unknown, tipo: unknown, base64: unknown, usuario: string): void {
    if (!this.db.prepare("SELECT 1 FROM pcp_defeito WHERE id = ?").get(defeitoId)) throw new ErroProblematicos("Registro de defeito não encontrado.", 404);
    if (typeof tipo !== "string" || !Object.prototype.hasOwnProperty.call(ASSINATURAS, tipo)) throw new ErroProblematicos("Anexe uma imagem (PNG, JPG, WEBP, GIF) ou um PDF.");
    if (typeof base64 !== "string" || base64 === "") throw new ErroProblematicos("Arquivo vazio.");
    const dados = Buffer.from(base64, "base64");
    if (dados.length === 0) throw new ErroProblematicos("Arquivo vazio.");
    if (dados.length > MAX_ANEXO_BYTES) throw new ErroProblematicos("O arquivo passa de 5 MB.");
    if (!ASSINATURAS[tipo](dados)) throw new ErroProblematicos("O conteúdo do arquivo não confere com o tipo informado.");
    const ja = (this.db.prepare("SELECT COUNT(*) AS n FROM pcp_defeito_anexo WHERE defeito_id = ?").get(defeitoId) as { n: number }).n;
    if (ja >= MAX_ANEXOS_POR_DEFEITO) throw new ErroProblematicos(`No máximo ${MAX_ANEXOS_POR_DEFEITO} anexos por registro.`);

    const nomeLimpo = String(nome ?? "").replace(/[\\/\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "anexo";
    this.db
      .prepare("INSERT INTO pcp_defeito_anexo (defeito_id, nome, mime, dados, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(defeitoId, nomeLimpo, tipo, dados, this.agora().toISOString(), usuario);
  }

  ler(id: number): { nome: string; mime: string; dados: Buffer } {
    const a = this.db.prepare("SELECT nome, mime, dados FROM pcp_defeito_anexo WHERE id = ?").get(id) as Linha | undefined;
    if (!a) throw new ErroProblematicos("Anexo não encontrado.", 404);
    return { nome: a.nome as string, mime: a.mime as string, dados: Buffer.from(a.dados as Uint8Array) };
  }

  remover(id: number): void {
    const r = this.db.prepare("DELETE FROM pcp_defeito_anexo WHERE id = ?").run(id);
    if (Number(r.changes) === 0) throw new ErroProblematicos("Anexo não encontrado.", 404);
  }

  apagarDoDefeito(defeitoId: number): void {
    this.db.prepare("DELETE FROM pcp_defeito_anexo WHERE defeito_id = ?").run(defeitoId);
  }
}
