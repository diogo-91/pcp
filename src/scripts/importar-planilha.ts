/**
 * Importação única do histórico da planilha de programação (aba Base + aba Rotas).
 *   npm run importar-planilha -- "Programação de Produção 2026.xlsx"            (simulação: não grava nada)
 *   npm run importar-planilha -- "Programação de Produção 2026.xlsx" --gravar   (grava, com backup antes)
 * Só importa o que existe apenas na planilha; o relatório CSV mostra o que foi importado, ajustado e rejeitado.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfigFromEnvFile } from "../config";
import { openDatabase } from "../db";
import { importarDeArquivo } from "../programacao/importacao";
import { ProgramacaoRepository } from "../programacao/repo";

const [arquivo, ...flags] = process.argv.slice(2);
if (!arquivo) {
  console.error('Uso: npm run importar-planilha -- "caminho\planilha.xlsx" [--gravar] [--forcar]');
  process.exit(2);
}
const gravar = flags.includes("--gravar");
const forcar = flags.includes("--forcar");

const config = loadConfigFromEnvFile();
const db = openDatabase(config.databaseFile);
const repo = new ProgramacaoRepository(db);

const r = importarDeArquivo(readFileSync(arquivo), { db, repo, gravar, forcar, pastaBackup: join(dirname(config.databaseFile), "backups-operacoes") });

const pasta = join(dirname(config.databaseFile), "relatorios");
mkdirSync(pasta, { recursive: true });
const destino = join(pasta, `importacao-planilha-${gravar ? "gravada" : "simulacao"}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.csv`);
writeFileSync(destino, r.csv, "utf8");

console.log(gravar ? "IMPORTAÇÃO GRAVADA" : "SIMULAÇÃO (nada foi gravado; use --gravar para valer)");
if (r.backup) console.log(`Backup do banco: ${r.backup}`);
console.log(r.resumo);
console.log(`Relatório: ${destino}`);
db.close();
