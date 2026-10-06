import { buildApp } from "./app";
import { loadConfigFromEnvFile, problemasDeConfiguracao } from "./config";
import { openDatabase } from "./db";
import { NomusClient } from "./nomus";
import { PlanejamentoService, montarEndpoint } from "./planejamento";
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

const sync = new SyncService(nomus, repo, {
  statusLiberado: config.nomusStatusLiberado,
  diasExtraEntrega: config.entregaDiasExtra,
  log,
});

if (config.planejamentoUrl && montarEndpoint(config.planejamentoUrl) === null) {
  console.error(`[planejamento] PLANEJAMENTO_URL inválida ("${config.planejamentoUrl}"): use um endereço http(s). A coluna "Prazo de produção" ficará vazia.`);
}
const planejamento = new PlanejamentoService(repo, {
  url: config.planejamentoUrl,
  log: { info: (m) => console.log(`[planejamento] ${m}`), warn: (m) => console.warn(`[planejamento] ${m}`) },
});
const app = await buildApp({
  repo,
  sync,
  planejamento,
  accessToken: config.accessToken,
  logger: true,
  trustProxyHops: config.trustProxyHops,
  publico: { origens: config.publicOrigins },
});

await app.listen({ port: config.port, host: "0.0.0.0" });

console.log(`\nPCP & Entrega em http://localhost:${config.port}`);
console.log(`Banco : ${config.databaseFile}`);
console.log(`Nomus : ${config.nomusBaseUrl || "(NOMUS_BASE_URL não configurada)"} | token ${config.nomusToken ? "ok" : "AUSENTE"}`);
console.log(`Acesso: ${config.accessToken ? "protegido por ACCESS_TOKEN" : "SEM proteção (defina ACCESS_TOKEN em produção)"}`);
console.log(`Planej: ${planejamento.configurado() ? config.planejamentoUrl : "(PLANEJAMENTO_URL não configurada: sem prazo de produção)"}\n`);

let timer: NodeJS.Timeout | undefined;
if (config.syncEnabled) {
  setTimeout(() => void sync.executar("inicio"), 3000);
  timer = setInterval(() => void sync.executar("agendada"), config.syncIntervalMs);
}

// A programação da produção não depende da Nomus (nem do SYNC_ENABLED): lê o calendário do apontamento sozinha.
let timerPlanejamento: NodeJS.Timeout | undefined;
if (planejamento.configurado()) {
  setTimeout(() => void planejamento.executar(), 5000);
  timerPlanejamento = setInterval(() => void planejamento.executar(), config.planejamentoIntervalMs);
}

const encerrar = async () => {
  if (timer) clearInterval(timer);
  if (timerPlanejamento) clearInterval(timerPlanejamento);
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", encerrar);
process.on("SIGINT", encerrar);
