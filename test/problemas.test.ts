import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app";
import { montarPedido } from "../src/apresentacao";
import { openDatabase } from "../src/db";
import { PcpRepository } from "../src/repository";
import { SyncService } from "../src/sync";
import type { PedidoNomus, PedidoRow } from "../src/types";

const HOJE = "2026-09-28";
const linha = (extra: Partial<PedidoRow> = {}): PedidoRow => ({
  nomusId: 1, numero: 1, codigoPedido: "PD 00001", clienteId: 1, clienteNome: "Fulano", telefone: "15 99999-0000", prazoEntrega: "2026-10-20",
  primeiroVistoEm: "x", statusPcp: "PEDIDO LIBERADO", atendimento: "", responsavel: "", acao: "", prazoAcao: null, acaoStatus: "Pendente",
  atualizadoManualEm: null, prazoProducao: "2026-09-10", producaoItens: [], ...extra,
});
const codigos = (extra: Partial<PedidoRow>) => montarPedido(linha(extra), HOJE).problemas.map((p) => p.codigo);

test("pedido em ordem não tem problema", () => {
  assert.deepEqual(codigos({}), []);
});

test("cada situação problemática é reconhecida (e um pedido pode ter vários motivos)", () => {
  assert.deepEqual(codigos({ prazoEntrega: "2026-09-20" }), ["atrasado"]);
  assert.equal(montarPedido(linha({ prazoEntrega: "2026-09-20" }), HOJE).problemas[0].texto, "Prazo vencido há 8 dia(s)");
  assert.deepEqual(codigos({ prazoEntrega: null, prazoProducao: null }), ["sem_prazo"]);
  assert.deepEqual(codigos({ prazoEntrega: "2026-10-10", prazoProducao: "2026-10-15" }), ["producao_depois_da_entrega"]);
  assert.deepEqual(codigos({ prazoEntrega: "2026-09-30", prazoProducao: null }), ["vence_sem_producao"]);
  assert.deepEqual(codigos({ prazoEntrega: "2026-09-30", prazoProducao: "2026-09-29" }), [], "vence logo mas já está programado: ok");
  assert.deepEqual(codigos({ telefone: "  " }), ["sem_telefone"]);
  assert.deepEqual(codigos({ clienteNome: "" }), ["sem_nome"]);
  assert.deepEqual(codigos({ prazoEntrega: "2026-09-20", telefone: "", clienteNome: "" }), ["atrasado", "sem_telefone", "sem_nome"]);
});

test("GET /api/pedidos devolve os motivos e a contagem de pedidos problemáticos", async () => {
  const repo = new PcpRepository(openDatabase(":memory:"));
  const p = (id: number, prazo: string | null, telefone = "1"): PedidoNomus => ({
    nomusId: id, numero: id, codigoPedido: `PD ${id}`, clienteId: 1, clienteNome: "C", telefone, prazoEntrega: prazo,
  });
  repo.inserirNovos([p(1, "2026-10-30"), p(2, "2026-09-20"), p(3, null), p(4, "2026-10-30", "")], new Date("2026-09-28T14:00:00Z").toISOString());
  const sync = new SyncService({ get: async () => [] as never }, repo, { statusLiberado: 2 });
  const app = await buildApp({ repo, sync, accessToken: "", agora: () => new Date("2026-09-28T14:00:00Z") });

  const corpo = (await app.inject({ method: "GET", url: "/api/pedidos" })).json() as { problematicos: number; pedidos: Array<{ nomusId: number; problemas: Array<{ codigo: string }> }> };
  assert.equal(corpo.problematicos, 3, "atrasado, sem prazo e sem telefone");
  const por = Object.fromEntries(corpo.pedidos.map((x) => [x.nomusId, x.problemas.map((y) => y.codigo)]));
  assert.deepEqual(por[1], []);
  assert.deepEqual(por[2], ["atrasado"]);
  assert.deepEqual(por[3], ["sem_prazo"]);
  assert.deepEqual(por[4], ["sem_telefone"]);
});
