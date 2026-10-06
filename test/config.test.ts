import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, problemasDeConfiguracao } from "../src/config";

const producao = (extra: Record<string, string> = {}) => {
  const env = { NODE_ENV: "production", NOMUS_BASE_URL: "https://nomus.exemplo/rest", NOMUS_TOKEN: "abc", ACCESS_TOKEN: "codigo-de-acesso", ...extra } as NodeJS.ProcessEnv;
  return { env, config: loadConfig(env) };
};

test("produção completa: nenhum problema", () => {
  const { env, config } = producao();
  assert.deepEqual(problemasDeConfiguracao(config, env), []);
});

test("produção SEM ACCESS_TOKEN não sobe (dados de clientes ficariam abertos)", () => {
  const { env, config } = producao({ ACCESS_TOKEN: "" });
  const p = problemasDeConfiguracao(config, env);
  assert.equal(p.length, 1);
  assert.match(p[0], /ACCESS_TOKEN/);
});

test("ALLOW_NO_AUTH=true é a saída explícita para quem realmente quer aberto", () => {
  const { env, config } = producao({ ACCESS_TOKEN: "", ALLOW_NO_AUTH: "true" });
  assert.deepEqual(problemasDeConfiguracao(config, env), []);
});

test("ACCESS_TOKEN curto demais é recusado", () => {
  const { env, config } = producao({ ACCESS_TOKEN: "123" });
  assert.match(problemasDeConfiguracao(config, env)[0], /curto/);
});

test("produção sem credenciais da Nomus lista cada falta", () => {
  const { env, config } = producao({ NOMUS_BASE_URL: "", NOMUS_TOKEN: "" });
  assert.equal(problemasDeConfiguracao(config, env).length, 2);
});

test("em desenvolvimento nada é exigido", () => {
  const env = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
  assert.deepEqual(problemasDeConfiguracao(loadConfig(env), env), []);
  const semNada = {} as NodeJS.ProcessEnv;
  assert.deepEqual(problemasDeConfiguracao(loadConfig(semNada), semNada), []);
});

test("TRUST_PROXY_HOPS: padrão 1 em produção e 0 fora dela; valores inválidos voltam ao padrão", () => {
  const de = (env: Record<string, string>) => loadConfig(env as NodeJS.ProcessEnv).trustProxyHops;
  assert.equal(de({ NODE_ENV: "production" }), 1);
  assert.equal(de({}), 0);
  assert.equal(de({ NODE_ENV: "production", TRUST_PROXY_HOPS: "2" }), 2, "ex.: Cloudflare + EasyPanel");
  assert.equal(de({ NODE_ENV: "production", TRUST_PROXY_HOPS: "0" }), 0);
  assert.equal(de({ NODE_ENV: "production", TRUST_PROXY_HOPS: "abc" }), 1);
  assert.equal(de({ NODE_ENV: "production", TRUST_PROXY_HOPS: "-1" }), 1);
  assert.equal(de({ NODE_ENV: "production", TRUST_PROXY_HOPS: "99" }), 1);
  assert.equal(de({ NODE_ENV: "production", TRUST_PROXY_HOPS: "1.5" }), 1);
});

test("ENTREGA_DIAS_EXTRA: padrão 20; 0 desliga; valor inválido volta ao padrão", () => {
  const de = (v?: string) => loadConfig((v === undefined ? {} : { ENTREGA_DIAS_EXTRA: v }) as NodeJS.ProcessEnv).entregaDiasExtra;
  assert.equal(de(), 20);
  assert.equal(de(""), 20);
  assert.equal(de("0"), 0);
  assert.equal(de("30"), 30);
  assert.equal(de("365"), 365);
  for (const ruim of ["abc", "-5", "1.5", "366", "99999"]) assert.equal(de(ruim), 20, ruim);
});
