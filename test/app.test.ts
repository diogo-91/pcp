import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app";
import { openDatabase } from "../src/db";
import { PcpRepository } from "../src/repository";
import { SyncService } from "../src/sync";
import type { PedidoNomus, PedidoPcp } from "../src/types";

// Relógio fixo: 28/09/2026 11:00 em São Paulo.
const AGORA = new Date("2026-09-28T14:00:00Z");

const pedido = (nomusId: number, prazoEntrega: string | null): PedidoNomus => ({
  nomusId,
  numero: nomusId - 31,
  codigoPedido: `PD ${String(nomusId - 31).padStart(5, "0")}`,
  clienteId: 1,
  clienteNome: `Cliente ${nomusId}`,
  telefone: "15 99999-0000",
  prazoEntrega,
});

async function montar(accessToken = "") {
  const repo = new PcpRepository(openDatabase(":memory:"));
  repo.inserirNovos(
    [
      pedido(2001, "2026-09-25"), // atrasado (3 dias)
      pedido(2002, "2026-09-27"), // ontem: atrasado (o HTML antigo mostrava "vence hoje")
      pedido(2003, "2026-09-28"), // hoje
      pedido(2004, "2026-09-30"), // hoje + 2: ainda "até 2 dias"
      pedido(2005, "2026-10-03"), // hoje + 5: "3 a 5 dias"
      pedido(2006, "2026-10-20"), // normal
      pedido(2007, null), // sem prazo
    ],
    AGORA.toISOString()
  );

  let dispararam = 0;
  const sync = new SyncService(
    { get: async (caminho: string) => ((caminho.startsWith("/pedidos?") && dispararam++, []) as never) },
    repo,
    { statusLiberado: 2 }
  );
  const app = await buildApp({ repo, sync, accessToken, agora: () => AGORA });
  return { app, repo, disparos: () => dispararam };
}

test("GET /api/pedidos devolve o alerta calculado no servidor e o resumo por pedido", async () => {
  const { app } = await montar();
  const res = await app.inject({ method: "GET", url: "/api/pedidos" });
  assert.equal(res.statusCode, 200);

  const corpo = res.json() as { hoje: string; pedidos: PedidoPcp[]; resumo: Record<string, number>; opcoes: { statusPcp: string[] } };
  assert.equal(corpo.hoje, "2026-09-28");

  const por = Object.fromEntries(corpo.pedidos.map((p) => [p.nomusId, p]));
  assert.equal(por[2001].alerta, "3 dia(s) em atraso");
  assert.equal(por[2002].faixa, "atrasado");
  assert.equal(por[2002].alerta, "1 dia(s) em atraso", "ontem é atraso de 1 dia");
  assert.equal(por[2003].alerta, "Vence hoje");
  assert.equal(por[2004].faixa, "ate2");
  assert.equal(por[2005].faixa, "de3a5");
  assert.equal(por[2006].faixa, "normal");
  assert.equal(por[2007].faixa, "semdata");
  assert.deepEqual(corpo.resumo, { total: 7, atrasado: 2, ate2: 2, de3a5: 1, normal: 1, semdata: 1 });
  assert.ok(corpo.opcoes.statusPcp.includes("EM PRODUÇÃO"));
  assert.deepEqual(
    corpo.pedidos.map((p) => p.nomusId),
    [2001, 2002, 2003, 2004, 2005, 2006, 2007],
    "ordenado por prazo, sem prazo por último"
  );
});

test("PATCH grava a tratativa e devolve o pedido atualizado", async () => {
  const { app, repo } = await montar();
  const res = await app.inject({
    method: "PATCH",
    url: "/api/pedidos/2003",
    payload: { statusPcp: "EM PRODUÇÃO", responsavel: "  Ana  ", prazoAcao: "2026-10-01", acaoStatus: "Em andamento" },
  });
  assert.equal(res.statusCode, 200);
  const p = res.json() as PedidoPcp;
  assert.equal(p.statusPcp, "EM PRODUÇÃO");
  assert.equal(p.responsavel, "Ana", "texto é aparado");
  assert.equal(repo.buscar(2003)!.prazoAcao, "2026-10-01", "gravou no banco");
  assert.equal(p.faixa, "ate2");
});

test("PATCH rejeita o que não pode: campo da Nomus, valor inválido, data inexistente, id ruim, pedido inexistente", async () => {
  const { app, repo } = await montar();
  const patch = (url: string, payload: unknown) => app.inject({ method: "PATCH", url, payload: payload as never });

  assert.equal((await patch("/api/pedidos/2003", { clienteNome: "X" })).statusCode, 400, "nome vem da Nomus");
  assert.equal((await patch("/api/pedidos/2003", { codigoPedido: "PD 99999" })).statusCode, 400, "número do pedido vem da Nomus");
  assert.equal((await patch("/api/pedidos/2003", { telefone: "11 1111-1111" })).statusCode, 400, "telefone vem da Nomus");
  assert.equal((await patch("/api/pedidos/2003", { prazoEntrega: "0002-10-15" })).statusCode, 400, "ano absurdo (digitação do ano)");
  assert.equal((await patch("/api/pedidos/2003", { prazoEntrega: "2101-01-01" })).statusCode, 400);
  assert.equal((await patch("/api/pedidos/2003", { prazoEntrega: "2026-02-30" })).statusCode, 400);
  assert.equal((await patch("/api/pedidos/2003", { prazoEntrega: "28/09/2026" })).statusCode, 400);
  assert.equal((await patch("/api/pedidos/2003", { statusPcp: "INVENTADO" })).statusCode, 400);
  assert.equal((await patch("/api/pedidos/2003", { acaoStatus: "Talvez" })).statusCode, 400);
  assert.equal((await patch("/api/pedidos/2003", { prazoAcao: "2026-02-30" })).statusCode, 400);
  assert.equal((await patch("/api/pedidos/2003", { acao: "x".repeat(2001) })).statusCode, 400);
  assert.equal((await patch("/api/pedidos/2003", { responsavel: 42 })).statusCode, 400);
  assert.equal((await patch("/api/pedidos/2003", {})).statusCode, 400);
  assert.equal((await patch("/api/pedidos/abc", { acao: "x" })).statusCode, 400);
  assert.equal((await patch("/api/pedidos/9999", { acao: "x" })).statusCode, 404);
  assert.equal(repo.buscar(2003)!.clienteNome, "Cliente 2003", "nada foi alterado");

  const limpar = await patch("/api/pedidos/2003", { prazoAcao: "" });
  assert.equal(limpar.statusCode, 200, "string vazia limpa a data");
});

test("o prazo de entrega é editável e o alerta é recalculado pelo servidor", async () => {
  const { app, repo } = await montar();
  const patch = (id: number, payload: unknown) => app.inject({ method: "PATCH", url: `/api/pedidos/${id}`, payload: payload as never });

  // 2006 estava "normal" (20/10). Adianta para amanhã: vira "até 2 dias".
  const adiantado = (await patch(2006, { prazoEntrega: "2026-09-29" })).json() as PedidoPcp;
  assert.equal(adiantado.prazoEntrega, "2026-09-29");
  assert.equal(adiantado.faixa, "ate2");
  assert.equal(adiantado.alerta, "Vence amanhã");

  // 2001 estava atrasado. Empurra para depois: sai do atraso.
  const empurrado = (await patch(2001, { prazoEntrega: "2026-10-15" })).json() as PedidoPcp;
  assert.equal(empurrado.faixa, "normal");

  // Limpar o prazo (vazio) = sem prazo; o pedido continua na tabela.
  const limpo = (await patch(2003, { prazoEntrega: "" })).json() as PedidoPcp;
  assert.equal(limpo.prazoEntrega, null);
  assert.equal(limpo.faixa, "semdata");

  // Um pedido que estava sem prazo pode ganhar um.
  const ganhou = (await patch(2007, { prazoEntrega: "2026-09-25" })).json() as PedidoPcp;
  assert.equal(ganhou.faixa, "atrasado");
  assert.equal(ganhou.alerta, "3 dia(s) em atraso");

  assert.equal(repo.buscar(2006)!.prazoEntrega, "2026-09-29", "gravado no banco");
});

test("os indicadores e a ordem refletem o prazo editado", async () => {
  const { app } = await montar();
  await app.inject({ method: "PATCH", url: "/api/pedidos/2006", payload: { prazoEntrega: "2026-09-24" } as never });

  const corpo = (await app.inject({ method: "GET", url: "/api/pedidos" })).json() as { pedidos: PedidoPcp[]; resumo: Record<string, number> };
  assert.equal(corpo.resumo.atrasado, 3, "2006 entrou nos atrasados");
  assert.equal(corpo.resumo.normal, 0);
  assert.equal(corpo.pedidos[0].nomusId, 2006, "prazo mais antigo vem primeiro");
});

test("encerrar um pedido tira ele da tabela, mas ?finalizados=1 ainda o mostra", async () => {
  const { app } = await montar();
  await app.inject({ method: "PATCH", url: "/api/pedidos/2003", payload: { statusPcp: "ENCERRADO" } });

  const ativos = (await app.inject({ method: "GET", url: "/api/pedidos" })).json() as { pedidos: PedidoPcp[] };
  assert.ok(!ativos.pedidos.some((p) => p.nomusId === 2003));

  const todos = (await app.inject({ method: "GET", url: "/api/pedidos?finalizados=1" })).json() as { pedidos: PedidoPcp[] };
  assert.ok(todos.pedidos.some((p) => p.nomusId === 2003));
});

test("POST /api/sync responde 202 e dispara a sincronização em segundo plano", async () => {
  const { app, disparos } = await montar();
  const res = await app.inject({ method: "POST", url: "/api/sync" });
  assert.equal(res.statusCode, 202);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(disparos(), 1);
});

test("com ACCESS_TOKEN: API exige o header, o health não, e o token errado é barrado", async () => {
  const { app } = await montar("segredo-123");

  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/pedidos" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/pedidos", headers: { "x-pcp-token": "errado" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/pedidos/2003", payload: { acao: "x" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/sync" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/pedidos", headers: { "x-pcp-token": "segredo-123" } })).statusCode, 200);
});

test("sem ACCESS_TOKEN a API é aberta (uso local)", async () => {
  const { app } = await montar("");
  assert.equal((await app.inject({ method: "GET", url: "/api/pedidos" })).statusCode, 200);
});
