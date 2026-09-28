import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

export interface AppConfig {
  port: number;
  nomusBaseUrl: string;
  nomusToken: string;
  nomusTimeoutMs: number;
  /** Código de `itensPedido[].status` que a Nomus usa para "Liberado" (1 = Aguardando liberação, 2 = Liberado). */
  nomusStatusLiberado: number;
  databaseFile: string;
  syncEnabled: boolean;
  syncIntervalMs: number;
  /** Se definido, /api/* (exceto /api/health) exige o header `x-pcp-token` com este valor. */
  accessToken: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3100),
    nomusBaseUrl: (env.NOMUS_BASE_URL ?? "").replace(/\/$/, ""),
    nomusToken: env.NOMUS_TOKEN ?? "",
    nomusTimeoutMs: Number(env.NOMUS_TIMEOUT ?? 30000),
    nomusStatusLiberado: Number(env.NOMUS_STATUS_LIBERADO ?? 2),
    // Dado digitado à mão não dá pra refazer: em produção monte um volume persistente na pasta do banco.
    databaseFile: env.DATABASE_FILE ?? resolve(process.cwd(), "data/pcp.sqlite"),
    syncEnabled: env.SYNC_ENABLED !== "false",
    // Uma varredura completa leva 10 a 15 min por causa do rate limit da Nomus (o mesmo token é usado pelo
    // dashboard do MES), então o padrão é 1 h. O botão "Sincronizar" força uma rodada quando precisar.
    syncIntervalMs: Number(env.SYNC_INTERVAL_MS ?? 60 * 60 * 1000),
    accessToken: env.ACCESS_TOKEN ?? "",
  };
}

/** Carrega o .env (se existir) e devolve a configuração. Variáveis já definidas no ambiente têm prioridade. */
export function loadConfigFromEnvFile(): AppConfig {
  loadDotenv({ quiet: true });
  return loadConfig();
}

/**
 * Problemas que impedem o servidor de subir EM PRODUÇÃO (NODE_ENV=production). Em desenvolvimento não se aplica.
 * A tela mostra nome e telefone de clientes e permite editar a tabela: sem ACCESS_TOKEN qualquer pessoa com o
 * endereço teria acesso, então em produção o servidor recusa subir aberto (a menos que ALLOW_NO_AUTH=true).
 */
export function problemasDeConfiguracao(config: AppConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];

  const problemas: string[] = [];
  if (!config.accessToken && env.ALLOW_NO_AUTH !== "true") {
    problemas.push("ACCESS_TOKEN não definido: sem ele qualquer pessoa com o endereço vê nomes e telefones de clientes e edita a tabela. Defina um código de acesso.");
  } else if (config.accessToken && config.accessToken.length < 8) {
    problemas.push("ACCESS_TOKEN muito curto: use pelo menos 8 caracteres.");
  }
  if (!config.nomusBaseUrl) problemas.push("NOMUS_BASE_URL não definido.");
  if (!config.nomusToken) problemas.push("NOMUS_TOKEN não definido.");
  return problemas;
}
