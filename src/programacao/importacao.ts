import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { importarPlanilha, relatorioCsv, type ResultadoImportacao } from "./planilha";
import type { ProgramacaoRepository } from "./repo";
import { lerXlsx } from "./xlsx";

export interface RespostaImportacao {
  gravou: boolean;
  /** Arquivo do backup feito antes de gravar (null no dry-run). */
  backup: string | null;
  resumo: ResultadoImportacao["resumo"];
  csv: string;
}

/**
 * Lê a planilha (.xlsx), importa e devolve o relatório. `gravar = false` é o dry-run: nada é escrito.
 * Ao gravar, tira antes um backup consistente do banco (VACUUM INTO) na pasta indicada.
 */
export function importarDeArquivo(
  buf: Buffer,
  ctx: { db: DatabaseSync; repo: ProgramacaoRepository; gravar: boolean; forcar?: boolean; pastaBackup: string | null; agora?: () => Date }
): RespostaImportacao {
  const planilha = lerXlsx(buf);
  const base = planilha.aba("Base");
  if (!base) throw new Error(`A planilha não tem a aba "Base" (abas encontradas: ${planilha.abas.join(", ") || "nenhuma"}).`);
  const rotas = planilha.aba("Rotas");

  let backup: string | null = null;
  if (ctx.gravar && ctx.pastaBackup) {
    mkdirSync(ctx.pastaBackup, { recursive: true });
    const carimbo = (ctx.agora?.() ?? new Date()).toISOString().replace(/[-:T]/g, "").slice(0, 14);
    backup = join(ctx.pastaBackup, `backup-antes-de-importar-planilha-${carimbo}.sqlite`);
    ctx.db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }

  const resultado = importarPlanilha({ repo: ctx.repo, base, rotas, gravar: ctx.gravar, forcar: ctx.forcar, agora: ctx.agora });
  return { gravou: resultado.gravou, backup, resumo: resultado.resumo, csv: relatorioCsv(resultado) };
}
