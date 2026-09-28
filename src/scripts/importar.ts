/**
 * Importa um backup JSON: `npm run importar -- arquivo.json [--atualizar]`.
 * Sem --atualizar só entram pedidos que ainda não existem. Com --atualizar, os que já existem recebem o status,
 * prazo, atendimento, responsável e plano de ação do arquivo (nome, telefone e código nunca são alterados).
 * Nunca apaga nada.
 */
import { readFileSync } from "node:fs";
import { loadConfigFromEnvFile } from "../config";
import { openDatabase } from "../db";
import { importar } from "../migracao";
import { PcpRepository } from "../repository";

const [caminho, ...flags] = process.argv.slice(2);
if (!caminho) {
  console.error("Uso: npm run importar -- arquivo.json [--atualizar]");
  process.exit(1);
}

const config = loadConfigFromEnvFile();
const repo = new PcpRepository(openDatabase(config.databaseFile));

try {
  const dados = JSON.parse(readFileSync(caminho, "utf8"));
  const r = importar(repo, dados, { atualizar: flags.includes("--atualizar"), agora: new Date().toISOString() });
  console.log(
    `Importação concluída: ${r.inseridos} pedidos inseridos, ${r.atualizados} atualizados, ${r.jaExistiam} já existiam (sem mudança); histórico: ${r.historico} inseridos.`
  );
} catch (erro) {
  console.error(`Falhou: ${erro instanceof Error ? erro.message : String(erro)}`);
  process.exit(1);
}
