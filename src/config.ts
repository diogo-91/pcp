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
  /** Segundo código, de perfil "consulta" (só lê a Programação, sem telefones nem edição). Vazio = não existe. */
  accessTokenConsulta: string;
  /** Códigos de itensPedido[].status que a Nomus usa para "cancelado" (vazio = ainda não identificado). */
  nomusStatusCancelado: number[];
  /** Origens (sites) autorizadas a chamar a consulta pública do navegador. Vazio = qualquer uma. */
  publicOrigins: string[];
  /**
   * Quantos servidores intermediários (proxies) ficam entre o visitante e o app. O app só confia no IP anotado por
   * eles, nunca no que o visitante escreve no cabeçalho X-Forwarded-For (que ele pode inventar). No domínio padrão do
   * EasyPanel é 1; atrás de um serviço a mais (ex.: Cloudflare) é 2. Padrão: 1 em produção, 0 fora dela.
   */
  trustProxyHops: number;
  /** Endereço do sistema de apontamento, de onde vem a programação da produção ("Prazo de produção"). Vazio = desligado. */
  planejamentoUrl: string;
  planejamentoIntervalMs: number;
  /** Dias somados ao prazo de entrega da Nomus quando um pedido novo entra na tabela. Padrão: 20. */
  entregaDiasExtra: number;
}

const v_ok = (n: number) => Number.isInteger(n) && n >= 0;

function hopsDoProxy(env: NodeJS.ProcessEnv): number {
  const padrao = env.NODE_ENV === "production" ? 1 : 0;
  const valor = env.TRUST_PROXY_HOPS;
  if (valor === undefined || valor === "") return padrao;
  const n = Number(valor);
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : padrao;
}

/** ENTREGA_DIAS_EXTRA: inteiro de 0 a 365. Vazio ou inválido volta ao padrão (20); 0 desliga a margem. */
function diasExtraEntrega(env: NodeJS.ProcessEnv): number {
  const valor = env.ENTREGA_DIAS_EXTRA;
  if (valor === undefined || valor.trim() === "") return 20;
  const n = Number(valor);
  return Number.isInteger(n) && n >= 0 && n <= 365 ? n : 20;
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
    accessTokenConsulta: (env.ACCESS_TOKEN_CONSULTA ?? "").trim(),
    nomusStatusCancelado: (env.NOMUS_STATUS_CANCELADO ?? "").split(",").map((v) => Number(v.trim())).filter((n) => v_ok(n)),
    publicOrigins: (env.PUBLIC_ORIGINS ?? "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean),
    trustProxyHops: hopsDoProxy(env),
    planejamentoUrl: (env.PLANEJAMENTO_URL ?? "").trim(),
    // O calendário muda ao longo do dia (arrastar ordens); a leitura é leve e o botão "Sincronizar" força uma.
    planejamentoIntervalMs: Number(env.PLANEJAMENTO_INTERVAL_MS ?? 10 * 60 * 1000),
    entregaDiasExtra: diasExtraEntrega(env),
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
  if (config.accessTokenConsulta && config.accessTokenConsulta === config.accessToken) {
    problemas.push("ACCESS_TOKEN_CONSULTA igual ao ACCESS_TOKEN: use um código diferente para o perfil de consulta.");
  } else if (config.accessTokenConsulta && config.accessTokenConsulta.length < 8) {
    problemas.push("ACCESS_TOKEN_CONSULTA muito curto: use pelo menos 8 caracteres.");
  }
  if (!config.nomusBaseUrl) problemas.push("NOMUS_BASE_URL não definido.");
  if (!config.nomusToken) problemas.push("NOMUS_TOKEN não definido.");
  return problemas;
}
