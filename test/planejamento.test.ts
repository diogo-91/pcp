import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app";
import { openDatabase } from "../src/db";
import { PlanejamentoService, casarComPedidos, lerPlanejamento, montarEndpoint } from "../src/planejamento";
import { PcpRepository } from "../src/repository";
import { SyncService } from "../src/sync";
import type { PedidoNomus, PedidoPcp } from "../src/types";

const T = "2026-10-02T12:00:00.000Z";

const pedido = (nomusId: number, extra: Partial<PedidoNomus> = {}): PedidoNomus => ({
  nomusId,
  numero: nomusId + 3, // como na Nomus real: o id interno não é o número do pedido
  codigoPedido: `PD ${String(nomusId + 3).padStart(5, "0")}`,
  clienteId: 1,
  clienteNome: `Cliente ${nomusId}`,
  telefone: "15 99999-0000",
  prazoEntrega: "2026-10-20",
  ...extra,
});

/** Item como o GET /api/planejamento do sistema de apontamento devolve (só os campos que importam + ruído). */
const item = (nomeOrdem: string, idPedido: number | null, pedidoCodigo: string | null, data: string) => ({
  id: "uuid-" + nomeOrdem,
  nomeOrdem,
  idPedido,
  pedido: pedidoCodigo,
  data,
  idProduto: 7,
  materiais: [{ nome: "chapa", quantidade: 3 }],
});

const resposta = (corpo: unknown, status = 200) => new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), { status });

function montar(corpoInicial: unknown, opcoes: { url?: string; timeoutMs?: number } = {}) {
  const repo = new PcpRepository(openDatabase(":memory:"));
  repo.inserirNovos([pedido(2001), pedido(2002), pedido(2003)], T);

  const estado = { corpo: corpoInicial as unknown, status: 200, chamadas: 0, erroRede: null as Error | null, travar: false };
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    estado.chamadas++;
    if (estado.erroRede) return Promise.reject(estado.erroRede);
    if (estado.travar) {
      return new Promise((_ok, falha) => init?.signal?.addEventListener("abort", () => falha(new DOMException("Aborted", "AbortError"))));
    }
    return Promise.resolve(resposta(estado.corpo, estado.status));
  }) as unknown as typeof fetch;

  const logs: string[] = [];
  const servico = new PlanejamentoService(repo, {
    url: opcoes.url ?? "https://apontamento.exemplo.com",
    timeoutMs: opcoes.timeoutMs,
    fetchImpl,
    agora: () => new Date(T),
    log: { info: (m) => logs.push("info: " + m), warn: (m) => logs.push("warn: " + m) },
  });
  return { repo, servico, estado, logs };
}

// ---------------------------------------------------------------- leitura e validação

test("lerPlanejamento aceita itens válidos, extrai o número do pedido do código e descarta o inválido sem derrubar os outros", () => {
  const { itens, descartados } = lerPlanejamento([
    item("OS 01 - 001", 2001, "PD 01279", "2026-10-05"),
    item("OS 02 - 001", null, "PD 01280", "2026-10-06"),
    item("OS 03 - 001", 2002, null, "2026-02-30"), // data que não existe
    item("OS 04 - 001", 2002, "PD 1", "0002-10-05"), // ano absurdo
    { nomeOrdem: "", idPedido: 1, pedido: "PD 1", data: "2026-10-05" }, // sem nome
    null,
    "lixo",
    { ...item("OS 05 - 001", 2.5, "sem número", "2026-10-07") }, // id não inteiro, código sem dígitos
  ]);

  assert.deepEqual(
    itens.map((i) => [i.os, i.idPedido, i.numeroPedido, i.data]),
    [
      ["OS 01 - 001", 2001, 1279, "2026-10-05"],
      ["OS 02 - 001", null, 1280, "2026-10-06"],
      ["OS 05 - 001", null, null, "2026-10-07"],
    ]
  );
  assert.equal(descartados, 5);
});

test("lerPlanejamento recusa resposta que não é lista", () => {
  for (const ruim of [{}, "texto", 42, null, undefined]) assert.throws(() => lerPlanejamento(ruim), /não é uma lista/);
});

// ---------------------------------------------------------------- casamento OS → pedido

test("casa pelo id da Nomus; sem id válido, cai no número do pedido; o resto é contado como sem pedido", () => {
  const pedidos = [
    { nomusId: 2001, numero: 2004 },
    { nomusId: 2002, numero: 2005 },
  ];
  const { itens } = lerPlanejamento([
    item("OS A", 2001, "PD 02004", "2026-10-05"), // id casa
    item("OS B", 9999, "PD 02005", "2026-10-06"), // id não existe na tabela -> número 2005 -> pedido 2002
    item("OS C", null, "PD 02004", "2026-10-07"), // sem id -> número -> pedido 2001
    item("OS D", 7777, "PD 07777", "2026-10-08"), // nenhum casa
  ]);

  const { programacao, semPedido } = casarComPedidos(itens, pedidos);
  assert.equal(semPedido, 1);
  assert.deepEqual([...programacao.keys()].sort(), [2001, 2002]);
  assert.equal(programacao.get(2002)!.prazoProducao, "2026-10-06");
});

test("o id vence o número quando os dois apontam para pedidos diferentes", () => {
  const { itens } = lerPlanejamento([item("OS A", 2001, "PD 02005", "2026-10-05")]); // id=2001, mas o código é do 2002
  const { programacao } = casarComPedidos(itens, [{ nomusId: 2001, numero: 2004 }, { nomusId: 2002, numero: 2005 }]);
  assert.deepEqual([...programacao.keys()], [2001]);
});

test("pedido com várias ordens: vale a data MAIS TARDIA, as ordens saem em ordem, e ordem repetida não duplica", () => {
  const { itens } = lerPlanejamento([
    item("OS 2", 2001, null, "2026-10-09"),
    item("OS 1", 2001, null, "2026-10-05"),
    item("OS 1", 2001, null, "2026-10-05"), // repetida
    item("OS 3", 2001, null, "2026-10-07"),
  ]);
  const prog = casarComPedidos(itens, [{ nomusId: 2001, numero: 2004 }]).programacao.get(2001)!;
  assert.equal(prog.prazoProducao, "2026-10-09");
  assert.deepEqual(prog.itens, [
    { os: "OS 1", data: "2026-10-05" },
    { os: "OS 3", data: "2026-10-07" },
    { os: "OS 2", data: "2026-10-09" },
  ]);
});

// ---------------------------------------------------------------- o serviço grava na tabela

test("grava prazo de produção e ordens nos pedidos certos; pedido sem ordem fica como não programado", async () => {
  const { repo, servico } = montar([item("OS 10 - 001", 2001, "PD 02004", "2026-10-06"), item("OS 11 - 001", 2002, null, "2026-10-08")]);
  await servico.executar();

  const p1 = repo.buscar(2001)!;
  assert.equal(p1.prazoProducao, "2026-10-06");
  assert.deepEqual(p1.producaoItens, [{ os: "OS 10 - 001", data: "2026-10-06" }]);
  assert.equal(repo.buscar(2002)!.prazoProducao, "2026-10-08");
  assert.equal(repo.buscar(2003)!.prazoProducao, null);
  assert.deepEqual(repo.buscar(2003)!.producaoItens, []);

  const st = servico.status();
  assert.equal(st.configurado, true);
  assert.equal(st.erro, null);
  assert.equal(st.ultimoSucesso, T);
  assert.equal(st.pedidosProgramados, 2);
});

test("ler de novo o mesmo calendário não muda nada; mover uma ordem de dia atualiza; tirar do calendário limpa", async () => {
  const { repo, servico, estado, logs } = montar([item("OS 10 - 001", 2001, null, "2026-10-06")]);
  await servico.executar();
  await servico.executar();
  assert.match(logs.at(-1)!, /0 mudaram/);

  estado.corpo = [item("OS 10 - 001", 2001, null, "2026-10-13")]; // arrastada para outro dia
  await servico.executar();
  assert.equal(repo.buscar(2001)!.prazoProducao, "2026-10-13");

  estado.corpo = [item("OS 99 - 001", 2002, null, "2026-10-14")]; // a do 2001 saiu do calendário
  await servico.executar();
  assert.equal(repo.buscar(2001)!.prazoProducao, null, "saiu do calendário → volta a não programado");
  assert.deepEqual(repo.buscar(2001)!.producaoItens, []);
  assert.equal(repo.buscar(2002)!.prazoProducao, "2026-10-14");
});

test("NUNCA toca nos dados da Nomus nem nos digitados pelo PCP, nem conta como edição manual", async () => {
  const { repo, servico } = montar([item("OS 10 - 001", 2001, null, "2026-10-06")]);
  repo.atualizarTratativa(2001, { statusPcp: "EM PRODUÇÃO", atendimento: "Aguardando compras", responsavel: "Ana", acao: "Cobrar chapa", prazoEntrega: "2026-10-30" }, "2026-10-01T10:00:00.000Z");
  const antes = repo.buscar(2001)!;

  await servico.executar();

  const depois = repo.buscar(2001)!;
  assert.equal(depois.prazoProducao, "2026-10-06");
  const { prazoProducao: _a, producaoItens: _b, ...restoDepois } = depois;
  const { prazoProducao: _c, producaoItens: _d, ...restoAntes } = antes;
  assert.deepEqual(restoDepois, restoAntes, "todo o resto do pedido ficou idêntico (inclusive atualizadoManualEm)");
});

// ---------------------------------------------------------------- falhas: a programação anterior sobrevive

test("falha do apontamento (HTTP, JSON ruim, rede, timeout) nunca apaga a programação; a próxima leitura boa limpa o erro", async () => {
  const { repo, servico, estado } = montar([item("OS 10 - 001", 2001, null, "2026-10-06")], { timeoutMs: 30 });
  await servico.executar();
  assert.equal(repo.buscar(2001)!.prazoProducao, "2026-10-06");

  const falhas: Array<[string, () => void, RegExp]> = [
    ["HTTP 500", () => { estado.status = 500; }, /HTTP 500/],
    ["não é JSON", () => { estado.status = 200; estado.corpo = "<html>erro</html>"; }, /não é JSON/],
    ["não é lista", () => { estado.corpo = { erro: "x" }; }, /não é uma lista/],
    ["rede caiu", () => { estado.corpo = []; estado.erroRede = new Error("ECONNREFUSED"); }, /ECONNREFUSED/],
    ["não responde", () => { estado.erroRede = null; estado.travar = true; }, /não respondeu/],
  ];
  for (const [nome, preparar, esperado] of falhas) {
    preparar();
    await servico.executar();
    assert.match(servico.status().erro ?? "", esperado, nome);
    assert.equal(repo.buscar(2001)!.prazoProducao, "2026-10-06", `${nome}: a programação anterior continua`);
    assert.equal(servico.status().ultimoSucesso, T);
  }

  estado.travar = false; estado.erroRede = null; estado.status = 200;
  estado.corpo = [item("OS 10 - 001", 2001, null, "2026-10-07")];
  await servico.executar();
  assert.equal(servico.status().erro, null, "uma leitura boa limpa o erro");
  assert.equal(repo.buscar(2001)!.prazoProducao, "2026-10-07");
});

test("PROTEÇÃO: lista vazia com pedidos programados não apaga nada (o apontamento sobe vazio se o arquivo estiver ilegível)", async () => {
  const { repo, servico, estado } = montar([item("OS 10 - 001", 2001, null, "2026-10-06")]);
  await servico.executar();

  estado.corpo = [];
  await servico.executar();
  assert.match(servico.status().erro ?? "", /0 itens/);
  assert.equal(repo.buscar(2001)!.prazoProducao, "2026-10-06");
});

test("lista vazia sem nada programado é normal (calendário realmente vazio)", async () => {
  const { servico } = montar([]);
  await servico.executar();
  assert.equal(servico.status().erro, null);
  assert.ok(servico.status().ultimoSucesso);
});

test("uma leitura por vez: chamadas simultâneas compartilham a mesma", async () => {
  const { servico, estado } = montar([item("OS 10 - 001", 2001, null, "2026-10-06")]);
  await Promise.all([servico.executar(), servico.executar(), servico.executar()]);
  assert.equal(estado.chamadas, 1);
});

test("desligado: sem URL (ou URL inválida) nada é chamado e o status diz que não está configurado", async () => {
  for (const url of ["", "   ", "não é url", "ftp://x.com", "javascript:alert(1)"]) {
    const { servico, estado } = montar([], { url });
    await servico.executar();
    assert.equal(servico.configurado(), false, url);
    assert.equal(estado.chamadas, 0, url);
    assert.equal(servico.status().ultimaTentativa, null);
  }
});

test("montarEndpoint: aceita o endereço do sistema (com ou sem barra) ou o caminho completo", () => {
  assert.equal(montarEndpoint("https://ap.exemplo.com"), "https://ap.exemplo.com/api/planejamento");
  assert.equal(montarEndpoint("https://ap.exemplo.com/"), "https://ap.exemplo.com/api/planejamento");
  assert.equal(montarEndpoint("  http://localhost:3000///"), "http://localhost:3000/api/planejamento");
  assert.equal(montarEndpoint("https://ap.exemplo.com/api/planejamento"), "https://ap.exemplo.com/api/planejamento");
  assert.equal(montarEndpoint(""), null);
});

// ---------------------------------------------------------------- banco

test("producao_itens corrompido no banco não quebra a listagem: o pedido só aparece sem programação", () => {
  const db = openDatabase(":memory:");
  const repo = new PcpRepository(db);
  repo.inserirNovos([pedido(2001)], T);
  db.prepare("UPDATE pedidos SET prazo_producao = '2026-10-06', producao_itens = '{isso não é json' WHERE nomus_id = 2001").run();

  const p = repo.buscar(2001)!;
  assert.equal(p.prazoProducao, "2026-10-06");
  assert.deepEqual(p.producaoItens, []);
  assert.equal(repo.listar().length, 1);
});

test("um banco já existente (sem as colunas de produção) é migrado ao abrir, sem perder nada", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");

  const dir = mkdtempSync(join(tmpdir(), "pcp-"));
  const arquivo = join(dir, "pcp.sqlite");
  try {
    const novo = openDatabase(arquivo);
    new PcpRepository(novo).inserirNovos([pedido(2001)], T);
    novo.close();

    // Volta o banco para como estava antes desta mudança (versão 2 do schema).
    const antigo = new DatabaseSync(arquivo);
    antigo.exec("ALTER TABLE pedidos DROP COLUMN prazo_producao; ALTER TABLE pedidos DROP COLUMN producao_itens;");
    // ...e sem o módulo Programação (migração seguinte), que também já rodou ao abrir o banco novo.
    antigo.exec(
      "DROP TABLE pcp_estoque; DROP TABLE pcp_pagamento; DROP TABLE pcp_compra; DROP TABLE pcp_fornecedor; DROP TABLE pcp_feriado; DROP TABLE pcp_sync_programacao; DROP TABLE pcp_evento; DROP TABLE pcp_item_consumo; DROP TABLE pcp_item_op; DROP TABLE pcp_pedido_item; " +
        "DROP TABLE pcp_pedido; DROP TABLE pcp_produto_nomus; DROP TABLE pcp_parametro; DROP TABLE pcp_material; DROP TABLE pcp_cor; " +
        "DROP TABLE pcp_cidade_rota; DROP TABLE pcp_rota; ALTER TABLE pessoas DROP COLUMN municipio; ALTER TABLE pessoas DROP COLUMN uf; PRAGMA user_version = 2;"
    );
    antigo.close();

    const migrado = openDatabase(arquivo);
    const repo = new PcpRepository(migrado);
    const p = repo.buscar(2001)!;
    assert.equal(p.clienteNome, "Cliente 2001", "o pedido continua lá");
    assert.equal(p.prazoProducao, null);
    assert.equal(repo.aplicarProducao(new Map([[2001, { prazoProducao: "2026-10-06", itens: [{ os: "OS 1", data: "2026-10-06" }] }]])), 1);
    assert.equal(repo.buscar(2001)!.prazoProducao, "2026-10-06");
    migrado.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- API

async function montarApi(corpo: unknown) {
  const base = montar(corpo);
  const sync = new SyncService({ get: async () => [] as never }, base.repo, { statusLiberado: 2 });
  const app = await buildApp({ repo: base.repo, sync, planejamento: base.servico, accessToken: "", agora: () => new Date("2026-10-02T15:00:00Z") });
  return { app, ...base };
}

test("GET /api/pedidos traz prazoProducao, as ordens, o aviso 'produção depois da entrega' e o status da leitura", async () => {
  const { app, repo, servico } = await montarApi([
    item("OS 10 - 001", 2001, null, "2026-10-10"), // entrega 20/10: ok
    item("OS 11 - 001", 2002, null, "2026-10-25"), // entrega 20/10: produção DEPOIS
    item("OS 12 - 001", 2003, null, "2026-10-20"), // mesmo dia: não é "depois"
  ]);
  await servico.executar();
  repo.atualizarTratativa(2003, { prazoEntrega: "2026-10-20" }, T);

  const corpo = (await app.inject({ method: "GET", url: "/api/pedidos" })).json() as {
    pedidos: PedidoPcp[];
    planejamento: { configurado: boolean; ultimoSucesso: string | null; erro: string | null; pedidosProgramados: number };
  };
  const por = Object.fromEntries(corpo.pedidos.map((p) => [p.nomusId, p]));

  assert.equal(por[2001].prazoProducao, "2026-10-10");
  assert.deepEqual(por[2001].producaoItens, [{ os: "OS 10 - 001", data: "2026-10-10" }]);
  assert.equal(por[2001].producaoAposEntrega, false);
  assert.equal(por[2002].producaoAposEntrega, true);
  assert.equal(por[2003].producaoAposEntrega, false, "mesmo dia da entrega não conta como atraso");
  assert.deepEqual(corpo.planejamento, { configurado: true, ultimaTentativa: T, ultimoSucesso: T, erro: null, pedidosProgramados: 3 });
});

test("pedido sem programação ou sem prazo de entrega nunca acende o aviso", async () => {
  const { app, repo, servico } = await montarApi([item("OS 10 - 001", 2001, null, "2026-12-01")]);
  await servico.executar();
  repo.atualizarTratativa(2001, { prazoEntrega: null }, T); // sem prazo de entrega

  const corpo = (await app.inject({ method: "GET", url: "/api/pedidos" })).json() as { pedidos: PedidoPcp[] };
  const por = Object.fromEntries(corpo.pedidos.map((p) => [p.nomusId, p]));
  assert.equal(por[2001].producaoAposEntrega, false);
  assert.equal(por[2002].prazoProducao, null);
  assert.equal(por[2002].producaoAposEntrega, false);
});

test("sem serviço configurado a API continua funcionando e informa configurado: false", async () => {
  const repo = new PcpRepository(openDatabase(":memory:"));
  repo.inserirNovos([pedido(2001)], T);
  const sync = new SyncService({ get: async () => [] as never }, repo, { statusLiberado: 2 });
  const app = await buildApp({ repo, sync, accessToken: "" });

  const corpo = (await app.inject({ method: "GET", url: "/api/pedidos" })).json() as { pedidos: PedidoPcp[]; planejamento: { configurado: boolean } };
  assert.equal(corpo.planejamento.configurado, false);
  assert.equal(corpo.pedidos[0].prazoProducao, null);
});

test("o botão Sincronizar (POST /api/sync) também relê a programação da produção", async () => {
  const { app, estado, repo } = await montarApi([item("OS 10 - 001", 2001, null, "2026-10-06")]);
  assert.equal(estado.chamadas, 0);

  const r = await app.inject({ method: "POST", url: "/api/sync" });
  assert.equal(r.statusCode, 202);
  await new Promise((ok) => setTimeout(ok, 50));

  assert.equal(estado.chamadas, 1);
  assert.equal(repo.buscar(2001)!.prazoProducao, "2026-10-06");
});

test("falha de conexão mostra o motivo real (a causa do fetch), não o genérico 'fetch failed'", async () => {
  const { servico, estado } = montar([item("OS 10 - 001", 2001, null, "2026-10-06")]);
  estado.erroRede = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  await servico.executar();
  assert.equal(servico.status().erro, "Não foi possível conectar ao Planejamento (ECONNREFUSED).");
});
