import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app";
import { openDatabase } from "../src/db";
import { PcpRepository } from "../src/repository";
import { SyncService } from "../src/sync";
import type { PedidoNomus, PedidoPcp } from "../src/types";

const AGORA = new Date("2026-09-28T14:00:00Z");
const pedido = (nomusId: number, prazoEntrega: string | null): PedidoNomus => ({
  nomusId, numero: nomusId - 31, codigoPedido: `PD ${String(nomusId - 31).padStart(5, "0")}`, clienteId: 1,
  clienteNome: `Cliente ${nomusId}`, telefone: "15 99999-0000", prazoEntrega,
});

async function montar(accessToken = "", consulta = "") {
  const repo = new PcpRepository(openDatabase(":memory:"));
  repo.inserirNovos([pedido(2001, "2026-10-10"), pedido(2002, "2026-10-20"), pedido(2003, null)], AGORA.toISOString());
  const sync = new SyncService({ get: async () => [] as never }, repo, { statusLiberado: 2 });
  const app = await buildApp({ repo, sync, accessToken, accessTokenConsulta: consulta, agora: () => AGORA });
  return { app, repo };
}
const post = (app: Awaited<ReturnType<typeof montar>>["app"], payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/api/pedidos/lote", payload: payload as object, headers });

test("lote: o mesmo patch em vários pedidos, devolvendo os pedidos já atualizados", async () => {
  const { app, repo } = await montar();
  const r = await post(app, { ids: [2001, 2002], patch: { statusPcp: "EM PRODUÇÃO", responsavel: "Ana", acaoStatus: "Em andamento" } });
  assert.equal(r.statusCode, 200);
  const corpo = r.json() as { atualizados: number; pedidos: PedidoPcp[] };
  assert.equal(corpo.atualizados, 2);
  assert.ok(corpo.pedidos.every((p) => p.statusPcp === "EM PRODUÇÃO" && p.responsavel === "Ana"));
  assert.equal(repo.buscar(2002)!.acaoStatus, "Em andamento");
  assert.equal(repo.buscar(2003)!.statusPcp, "PEDIDO LIBERADO", "quem não foi selecionado não muda");
});

test("lote é tudo ou nada: um id inexistente ou um valor inválido não grava NADA", async () => {
  const { app, repo } = await montar();
  const a = await post(app, { ids: [2001, 9999], patch: { responsavel: "Ana" } });
  assert.equal(a.statusCode, 404);
  assert.equal(repo.buscar(2001)!.responsavel, "", "o pedido válido também ficou como estava");

  assert.equal((await post(app, { ids: [2001], patch: { statusPcp: "INVENTADO" } })).statusCode, 400);
  assert.equal((await post(app, { ids: [2001], patch: { prazoEntrega: "xx" } })).statusCode, 400);
  assert.equal((await post(app, { ids: [2001], patch: { clienteNome: "x" } })).statusCode, 400, "campo da Nomus não é editável");
  assert.equal((await post(app, { ids: [], patch: { responsavel: "x" } })).statusCode, 400);
  assert.equal((await post(app, { ids: ["a"], patch: { responsavel: "x" } })).statusCode, 400);
  assert.equal((await post(app, { ids: [2001] })).statusCode, 400, "sem o que alterar");
  assert.equal((await post(app, [1, 2])).statusCode, 400);
});

test("lote: somar dias desloca o prazo de cada pedido e pula o que não tem prazo", async () => {
  const { app, repo } = await montar();
  const r = await post(app, { ids: [2001, 2002, 2003], somarDias: 7 });
  const corpo = r.json() as { atualizados: number; semPrazo: number };
  assert.equal(corpo.semPrazo, 1);
  assert.equal(repo.buscar(2001)!.prazoEntrega, "2026-10-17");
  assert.equal(repo.buscar(2002)!.prazoEntrega, "2026-10-27");
  assert.equal(repo.buscar(2003)!.prazoEntrega, null);

  await post(app, { ids: [2001], somarDias: -10 });
  assert.equal(repo.buscar(2001)!.prazoEntrega, "2026-10-07");
  assert.equal((await post(app, { ids: [2001], somarDias: 0 })).statusCode, 400);
  assert.equal((await post(app, { ids: [2001], somarDias: 1.5 })).statusCode, 400);
  assert.equal((await post(app, { ids: [2001], somarDias: 999 })).statusCode, 400);
  assert.equal((await post(app, { ids: [2001], somarDias: 1, patch: { prazoEntrega: "2026-11-01" } })).statusCode, 400, "prazo fixo OU somar dias");
});

test("lote: formato por pedido (usado pelo Desfazer) restaura os valores anteriores", async () => {
  const { app, repo } = await montar();
  await post(app, { ids: [2001, 2002], patch: { statusPcp: "ENCERRADO", responsavel: "Ana" }, somarDias: 5 });
  assert.equal(repo.buscar(2001)!.statusPcp, "ENCERRADO");

  const r = await post(app, {
    itens: [
      { id: 2001, patch: { statusPcp: "PEDIDO LIBERADO", responsavel: "", prazoEntrega: "2026-10-10" } },
      { id: 2002, patch: { statusPcp: "PEDIDO LIBERADO", responsavel: "", prazoEntrega: "2026-10-20" } },
    ],
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([repo.buscar(2001)!.statusPcp, repo.buscar(2001)!.responsavel, repo.buscar(2001)!.prazoEntrega], ["PEDIDO LIBERADO", "", "2026-10-10"]);
  assert.equal(repo.buscar(2002)!.prazoEntrega, "2026-10-20");
});

test("lote: perfil de consulta não pode editar em massa; sem o código a API recusa", async () => {
  const { app } = await montar("codigo-completo", "codigo-consulta");
  const corpo = { ids: [2001], patch: { responsavel: "x" } };
  assert.equal((await post(app, corpo)).statusCode, 401);
  assert.equal((await post(app, corpo, { "x-pcp-token": "codigo-consulta" })).statusCode, 403);
  assert.equal((await post(app, corpo, { "x-pcp-token": "codigo-completo" })).statusCode, 200);
});
