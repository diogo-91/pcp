/** Roda uma sincronização com a Nomus e sai. Útil para a carga inicial e para diagnóstico: `npm run sync`. */
import { loadConfigFromEnvFile } from "../config";
import { openDatabase } from "../db";
import { NomusClient } from "../nomus";
import { PcpRepository } from "../repository";
import { SyncService } from "../sync";

const config = loadConfigFromEnvFile();
const db = openDatabase(config.databaseFile);
const repo = new PcpRepository(db);
repo.encerrarSyncsOrfaos(new Date().toISOString());

const nomus = new NomusClient({
  baseUrl: config.nomusBaseUrl,
  token: config.nomusToken,
  timeoutMs: config.nomusTimeoutMs,
});

const sync = new SyncService(nomus, repo, {
  statusLiberado: config.nomusStatusLiberado,
  log: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
});

const inicio = Date.now();
const resultado = await sync.executar("manual-cli");
db.close();

console.log(`\n${resultado.status.toUpperCase()} em ${Math.round((Date.now() - inicio) / 1000)}s`, resultado);
process.exit(resultado.status === "ok" ? 0 : 1);
