import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app";
import { openDatabase } from "../src/db";
import { LimitadorPorJanela } from "../src/limite";
import { consultarPedidoPublico, isoParaBr } from "../src/publico";
import { PcpRepository } from "../src/repository";
import { SyncService } from "../src/sync";
import type { PedidoNomus } from "../src/types";

const T = "2026-09-28T10:00:00.000Z";

const pedido = (nomusId: number, extra: Partial<PedidoNomus> = {}): PedidoNomus => ({
  nomusId,
  numero: nomusId - 31,
  codigoPedido: `PD ${String(nomusId - 31).padStart(5, "0")}`,
  clienteId: 100 + nomusId,
  clienteNome: `Maria da Silva ${nomusId}`,
  telefone: `15 99999-${String(nomusId).padStart(4, "0")}`,
  prazoEntrega: "2026-11-01",
  ...extra,
});

function novoRepo() {
  const repo = new PcpRepository(openDatabase(":memory:"));
  repo.inserirNovos(
    [pedido(2009), pedido(2001, { prazoEntrega: null }), pedido(2002, { prazoEntrega: "2026-10-10" })],
    T
  );
  repo.atualizarTratativa(2009, { statusPcp: "EM PRODUÇÃO", atendimento: "Texto interno que o cliente não pode ver", responsavel: "Ana" }, T);
  repo.atualizarTratativa(2002, { statusPcp: "ENCERRADO" }, T);
  return repo;
}

const falsoSync = (repo: PcpRepository) => new SyncService({ get: async () => [] as never }, repo, { statusLiberado: 2 });

async function montarApp(opcoes: { accessToken?: string; publico?: Parameters<typeof buildApp>[0]["publico"]; trustProxyHops?: number; agora?: () => Date } = {}) {
  const repo = novoRepo();
  const app = await buildApp({ repo, sync: falsoSync(repo), accessToken: opcoes.accessToken ?? "", ...opcoes });
  return { app, repo };
}

// ---------------------------------------------------------------- a lógica da consulta

test("formato IDÊNTICO ao do Google Apps Script: só success, pedido, status e prazo (dd/mm/aaaa)", () => {
  const r = consultarPedidoPublico(novoRepo(), "1978");
  assert.deepEqual(r, { success: true, pedido: "1978", status: "EM PRODUÇÃO", prazo: "01/11/2026" });
  assert.deepEqual(Object.keys(r), ["success", "pedido", "status", "prazo"]);
});

test("NADA pessoal ou interno vaza: nem nome, nem telefone, nem atendimento, nem responsável", () => {
  const texto = JSON.stringify(consultarPedidoPublico(novoRepo(), "1978"));
  for (const proibido of ["Maria", "Silva", "99999", "Texto interno", "Ana", "atendimento", "telefone", "cliente", "responsavel"]) {
    assert.ok(!texto.includes(proibido), `vazou: ${proibido}`);
  }
});

test("aceita o número de qualquer jeito que o cliente digitar (só os dígitos contam)", () => {
  const repo = novoRepo();
  for (const entrada of ["1978", " 1978 ", "01978", "PD 01978", "PD-01978", "#1978", 1978]) {
    assert.equal(consultarPedidoPublico(repo, entrada).pedido, "1978", `entrada ${JSON.stringify(entrada)}`);
  }
});

test("mostra o prazo que o PCP ajustou; sem prazo devolve vazio (o site mostra 'Em definição')", () => {
  const repo = novoRepo();
  assert.equal(consultarPedidoPublico(repo, "1970").prazo, "", "pedido sem prazo");
  repo.atualizarTratativa(2001, { prazoEntrega: "2026-12-24" }, T);
  assert.equal(consultarPedidoPublico(repo, "1970").prazo, "24/12/2026", "prazo editado no PCP");
});

test("pedido encerrado no PCP continua consultável (cliente vê 'ENCERRADO')", () => {
  const r = consultarPedidoPublico(novoRepo(), "1971");
  assert.equal(r.success, true);
  assert.equal(r.status, "ENCERRADO");
});

test("pedidos antigos vêm do histórico; o da tabela tem prioridade sobre o histórico de mesmo número", () => {
  const repo = novoRepo();
  repo.restaurarHistorico({ numero: 917, statusPcp: "ENCERRADO", prazoEntrega: "2026-08-28", origem: "planilha", importadoEm: T });
  repo.restaurarHistorico({ numero: 1978, statusPcp: "AGUARDANDO", prazoEntrega: "2020-01-01", origem: "planilha", importadoEm: T });

  assert.deepEqual(consultarPedidoPublico(repo, "917"), { success: true, pedido: "917", status: "ENCERRADO", prazo: "28/08/2026" });
  assert.equal(consultarPedidoPublico(repo, "1978").status, "EM PRODUÇÃO", "a tabela do PCP vale mais que o histórico");
});

test("não encontrado e entradas inválidas: success=false com mensagem, sem estourar", () => {
  const repo = novoRepo();
  assert.deepEqual(consultarPedidoPublico(repo, "999999"), { success: false, message: "Confira o número do pedido informado." });
  for (const ruim of [undefined, null, "", "   ", "abc", {}, [], "---"]) {
    const r = consultarPedidoPublico(repo, ruim);
    assert.equal(r.success, false, JSON.stringify(ruim));
    assert.equal(r.message, "Informe um número de pedido válido.");
  }
  for (const absurdo of ["0", "000", "1234567890123", "9".repeat(50)]) {
    assert.equal(consultarPedidoPublico(repo, absurdo).success, false, absurdo);
  }
});

test("injeção de SQL no número não faz nada (só os dígitos são usados)", () => {
  const repo = novoRepo();
  const r = consultarPedidoPublico(repo, "1978'; DROP TABLE pedidos; --");
  assert.equal(r.pedido, "1978", "ficou só 1978 (+ dígitos, se houver)");
  assert.equal(repo.contar(), 3, "a tabela continua inteira");
});

test("isoParaBr", () => {
  assert.equal(isoParaBr("2026-11-01"), "01/11/2026");
  assert.equal(isoParaBr(null), "");
});

// ---------------------------------------------------------------- a rota HTTP

test("GET /api/publico/pedido devolve 200 no formato do site, para encontrado e não encontrado", async () => {
  const { app } = await montarApp();
  const ok = await app.inject({ method: "GET", url: "/api/publico/pedido?pedido=1978" });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { success: true, pedido: "1978", status: "EM PRODUÇÃO", prazo: "01/11/2026" });
  assert.equal(ok.headers["cache-control"], "no-store");

  const nao = await app.inject({ method: "GET", url: "/api/publico/pedido?pedido=424242" });
  assert.equal(nao.statusCode, 200, "o site decide a mensagem pelo success, como fazia com o Apps Script");
  assert.equal(nao.json().success, false);

  const semParametro = await app.inject({ method: "GET", url: "/api/publico/pedido" });
  assert.equal(semParametro.json().success, false);
});

test("a consulta pública funciona SEM o código de acesso, mas a API do PCP continua protegida", async () => {
  const { app } = await montarApp({ accessToken: "codigo-de-acesso" });
  assert.equal((await app.inject({ method: "GET", url: "/api/publico/pedido?pedido=1978" })).json().success, true);
  assert.equal((await app.inject({ method: "GET", url: "/api/pedidos" })).statusCode, 401);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/pedidos/2009", payload: { acao: "x" } })).statusCode, 401);
});

test("CORS: sem lista, qualquer site pode consultar (dado público); com lista, só os autorizados", async () => {
  const aberto = await montarApp();
  const r1 = await aberto.app.inject({ method: "GET", url: "/api/publico/pedido?pedido=1978", headers: { origin: "https://qualquer.com" } });
  assert.equal(r1.headers["access-control-allow-origin"], "*");

  const restrito = await montarApp({ publico: { origens: ["https://www.gferro.com.br"] } });
  const ok = await restrito.app.inject({ method: "GET", url: "/api/publico/pedido?pedido=1978", headers: { origin: "https://www.gferro.com.br" } });
  assert.equal(ok.headers["access-control-allow-origin"], "https://www.gferro.com.br");
  assert.equal(ok.headers["vary"], "Origin");

  const intruso = await restrito.app.inject({ method: "GET", url: "/api/publico/pedido?pedido=1978", headers: { origin: "https://malicioso.com" } });
  assert.equal(intruso.headers["access-control-allow-origin"], undefined, "origem não autorizada não recebe o cabeçalho");
});

test("pré-voo (OPTIONS) responde 204 com os cabeçalhos de CORS", async () => {
  const { app } = await montarApp();
  const r = await app.inject({ method: "OPTIONS", url: "/api/publico/pedido", headers: { origin: "https://site.com", "access-control-request-method": "GET" } });
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.match(String(r.headers["access-control-allow-methods"]), /GET/);
});

test("LIMITE: passou de N consultas na janela → 429; outro visitante não é afetado; a janela renova", async () => {
  let agora = new Date("2026-09-28T12:00:00Z");
  const { app } = await montarApp({ publico: { limite: { maximo: 3, janelaMs: 60_000 } }, agora: () => agora });
  const consulta = (ip: string) => app.inject({ method: "GET", url: "/api/publico/pedido?pedido=1978", remoteAddress: ip });

  for (let i = 0; i < 3; i++) assert.equal((await consulta("10.0.0.1")).statusCode, 200);
  const bloqueada = await consulta("10.0.0.1");
  assert.equal(bloqueada.statusCode, 429);
  assert.equal(bloqueada.json().success, false);
  assert.equal(bloqueada.headers["retry-after"], "60");

  assert.equal((await consulta("10.0.0.2")).statusCode, 200, "outro visitante tem o próprio limite");

  agora = new Date(agora.getTime() + 61_000);
  assert.equal((await consulta("10.0.0.1")).statusCode, 200, "passada a janela, volta a funcionar");
});

test("atrás de 1 proxy o limite usa o IP real do visitante (o anotado pelo proxy), não o do proxy", async () => {
  const { app } = await montarApp({ trustProxyHops: 1, publico: { limite: { maximo: 2, janelaMs: 60_000 } } });
  // O proxy (172.18.0.2) anota o IP de quem se conectou a ele em X-Forwarded-For.
  const consulta = (ipReal: string) =>
    app.inject({ method: "GET", url: "/api/publico/pedido?pedido=1978", remoteAddress: "172.18.0.2", headers: { "x-forwarded-for": ipReal } });

  await consulta("200.1.1.1"); await consulta("200.1.1.1");
  assert.equal((await consulta("200.1.1.1")).statusCode, 429, "o visitante 200.1.1.1 estourou o limite");
  assert.equal((await consulta("200.2.2.2")).statusCode, 200, "outro visitante atrás do MESMO proxy passa");
});

test("NÃO dá para burlar o limite inventando o cabeçalho X-Forwarded-For", async () => {
  const { app } = await montarApp({ trustProxyHops: 1, publico: { limite: { maximo: 3, janelaMs: 60_000 } } });
  // O visitante manda um IP inventado diferente a cada consulta; o proxy acrescenta o IP verdadeiro (200.9.9.9) no fim.
  const codigos: number[] = [];
  for (let i = 1; i <= 6; i++) {
    const r = await app.inject({
      method: "GET",
      url: "/api/publico/pedido?pedido=1978",
      remoteAddress: "172.18.0.2",
      headers: { "x-forwarded-for": `10.0.0.${i}, 200.9.9.9` },
    });
    codigos.push(r.statusCode);
  }
  assert.deepEqual(codigos, [200, 200, 200, 429, 429, 429], "o IP inventado é ignorado; vale o que o proxy anotou");
});

test("sem proxy confiável (0), o X-Forwarded-For é ignorado e vale o endereço da conexão", async () => {
  const { app } = await montarApp({ trustProxyHops: 0, publico: { limite: { maximo: 2, janelaMs: 60_000 } } });
  const codigos: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const r = await app.inject({ method: "GET", url: "/api/publico/pedido?pedido=1978", remoteAddress: "198.51.100.7", headers: { "x-forwarded-for": `10.0.0.${i}` } });
    codigos.push(r.statusCode);
  }
  assert.deepEqual(codigos, [200, 200, 429, 429]);
});

// ---------------------------------------------------------------- o limitador sozinho

test("LimitadorPorJanela: conta por chave, renova a janela e não cresce sem parar", () => {
  let t = 0;
  const l = new LimitadorPorJanela(2, 1000, () => t);
  assert.deepEqual([l.permitir("a"), l.permitir("a"), l.permitir("a")], [true, true, false]);
  assert.equal(l.permitir("b"), true);
  t = 1000;
  assert.equal(l.permitir("a"), true);

  // Muitos visitantes distintos: as janelas vencidas são descartadas.
  t = 0;
  const grande = new LimitadorPorJanela(1, 1000, () => t);
  for (let i = 0; i < 6000; i++) grande.permitir(`ip${i}`);
  t = 5000;
  grande.permitir("novo");
  assert.ok((grande as unknown as { janelas: Map<string, unknown> }).janelas.size < 6000, "janelas vencidas foram limpas");
});
