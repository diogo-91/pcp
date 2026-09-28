import { buildApp } from "./app";
import { loadConfigFromEnvFile, problemasDeConfiguracao } from "./config";
import { openDatabase } from "./db";
import { NomusClient } from "./nomus";
import { PcpRepository } from "./repository";
import { SyncService, type Logger } from "./sync";

const config = loadConfigFromEnvFile();

const problemas = problemasDeConfiguracao(config);
if (problemas.length > 0) {
  console.error("O servidor não vai subir: configuração de produção incompleta.");
  for (const problema of problemas) console.error(`  - ${problema}`);
  process.exit(1);
}

const db = openDatabase(config.databaseFile);
const repo = new PcpRepository(db);
repo.encerrarSyncsOrfaos(new Date().toISOString());

const log: Logger = {
  info: (mensagem) => console.log(`[sync] ${mensagem}`),
  warn: (mensagem) => console.warn(`[sync] ${mensagem}`),
};

const nomus = new NomusClient({
  baseUrl: config.nomusBaseUrl,
  token: config.nomusToken,
  timeoutMs: config.nomusTimeoutMs,
});

const sync = new SyncService(nomus, repo, { statusLiberado: config.nomusStatusLiberado, log });
const app = await buildApp({ repo, sync, accessToken: config.accessToken, logger: true });

await app.listen({ port: config.port, host: "0.0.0.0" });

console.log(`\nPCP & Entrega em http://localhost:${config.port}`);
console.log(`Banco : ${config.databaseFile}`);
console.log(`Nomus : ${config.nomusBaseUrl || "(NOMUS_BASE_URL não configurada)"} | token ${config.nomusToken ? "ok" : "AUSENTE"}`);
console.log(`Acesso: ${config.accessToken ? "protegido por ACCESS_TOKEN" : "SEM proteção (defina ACCESS_TOKEN em produção)"}\n`);

let timer: NodeJS.Timeout | undefined;
if (config.syncEnabled) {
  setTimeout(() => void sync.executar("inicio"), 3000);
  timer = setInterval(() => void sync.executar("agendada"), config.syncIntervalMs);
}

const encerrar = async () => {
  if (timer) clearInterval(timer);
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", encerrar);
process.on("SIGINT", encerrar);
