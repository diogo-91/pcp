/** Exporta o banco (todos os pedidos, inclusive finalizados) para JSON: `npm run exportar -- arquivo.json` (sem arquivo, imprime na tela). */
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfigFromEnvFile } from "../config";
import { exportar } from "../migracao";
import { PcpRepository } from "../repository";

const config = loadConfigFromEnvFile();
const destino = process.argv[2];

// Conexão simples: exportar só lê e não deve mexer no modo do banco (o servidor pode estar com ele aberto).
const db = new DatabaseSync(config.databaseFile);
db.exec("PRAGMA busy_timeout = 8000");
const arquivo = exportar(new PcpRepository(db), new Date().toISOString());
db.close();

const json = JSON.stringify(arquivo);
if (destino) {
  writeFileSync(destino, json);
  console.error(`${arquivo.pedidos.length} pedidos exportados para ${destino}`);
} else {
  process.stdout.write(json);
}
