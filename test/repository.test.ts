import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/db";
import { PcpRepository } from "../src/repository";
import type { PedidoNomus } from "../src/types";

const T1 = "2026-09-28T10:00:00.000Z";
const T2 = "2026-09-28T11:00:00.000Z";

const pedido = (nomusId: number, extra: Partial<PedidoNomus> = {}): PedidoNomus => ({
  nomusId,
  numero: nomusId - 31,
  codigoPedido: `PD ${String(nomusId - 31).padStart(5, "0")}`,
  clienteId: 100 + nomusId,
  clienteNome: `Cliente ${nomusId}`,
  telefone: "15 99999-0000",
  prazoEntrega: "2026-10-10",
  ...extra,
});

const novoRepo = () => new PcpRepository(openDatabase(":memory:"));

test("inserirNovos cria os pedidos com a tratativa em valores padrão", () => {
  const repo = novoRepo();
  assert.equal(repo.inserirNovos([pedido(2001), pedido(2002)], T1), 2);

  const p = repo.buscar(2001)!;
  assert.equal(p.clienteNome, "Cliente 2001");
  assert.equal(p.prazoEntrega, "2026-10-10");
  assert.equal(p.statusPcp, "PEDIDO LIBERADO");
  assert.equal(p.acaoStatus, "Pendente");
  assert.equal(p.atendimento, "");
  assert.equal(p.primeiroVistoEm, T1);
});

test("pedido que já existe NUNCA é alterado pela sincronização (nome, telefone, prazo e tratativa)", () => {
  const repo = novoRepo();
  repo.inserirNovos([pedido(2001)], T1);
  repo.atualizarTratativa(
    2001,
    { statusPcp: "EM PRODUÇÃO", atendimento: "Aguardando compras", responsavel: "Ana", acao: "Cobrar chapa", prazoAcao: "2026-10-02", acaoStatus: "Em andamento", prazoEntrega: "2026-10-25" },
    T1
  );

  // A Nomus agora diz outra coisa sobre o mesmo pedido: nada disso pode entrar.
  const incluidos = repo.inserirNovos(
    [pedido(2001, { clienteNome: "Outro Nome", telefone: "11 00000-0000", prazoEntrega: "2026-11-30", codigoPedido: "PD 99999" })],
    T2
  );
  assert.equal(incluidos, 0);

  const p = repo.buscar(2001)!;
  assert.equal(p.clienteNome, "Cliente 2001");
  assert.equal(p.telefone, "15 99999-0000");
  assert.equal(p.codigoPedido, "PD 01970");
  assert.equal(p.prazoEntrega, "2026-10-25", "o prazo ajustado pelo PCP fica");
  assert.equal(p.statusPcp, "EM PRODUÇÃO");
  assert.equal(p.atendimento, "Aguardando compras");
  assert.equal(p.responsavel, "Ana");
  assert.equal(p.acao, "Cobrar chapa");
  assert.equal(p.prazoAcao, "2026-10-02");
  assert.equal(p.acaoStatus, "Em andamento");
  assert.equal(p.primeiroVistoEm, T1);
});

test("mistura de novos e existentes: só os novos entram", () => {
  const repo = novoRepo();
  repo.inserirNovos([pedido(2001)], T1);
  assert.equal(repo.inserirNovos([pedido(2001), pedido(2002), pedido(2003)], T2), 2);
  assert.equal(repo.contar(), 3);
});

test("idsExistentes diz quais pedidos já estão no banco", () => {
  const repo = novoRepo();
  repo.inserirNovos([pedido(2001), pedido(2003)], T1);
  assert.deepEqual([...repo.idsExistentes([2001, 2002, 2003, 2004])].sort(), [2001, 2003]);
  assert.deepEqual([...repo.idsExistentes([])], []);
});

test("o prazo de entrega é editável, pode ser limpo e volta a ser editado", () => {
  const repo = novoRepo();
  repo.inserirNovos([pedido(2001)], T1);

  assert.equal(repo.atualizarTratativa(2001, { prazoEntrega: "2026-10-20" }, T2)!.prazoEntrega, "2026-10-20");
  assert.equal(repo.atualizarTratativa(2001, { prazoEntrega: null }, T2)!.prazoEntrega, null);
  assert.equal(repo.atualizarTratativa(2001, { prazoEntrega: "2026-11-05" }, T2)!.prazoEntrega, "2026-11-05");
  assert.equal(repo.buscar(2001)!.atualizadoManualEm, T2);
});

test("pedido que a Nomus deixa de listar continua na tabela até o PCP encerrar", () => {
  const repo = novoRepo();
  repo.inserirNovos([pedido(2001), pedido(2002)], T1);
  repo.inserirNovos([pedido(2001)], T2); // a Nomus não lista mais o 2002

  assert.deepEqual(repo.listar().map((p) => p.nomusId).sort(), [2001, 2002]);
});

test("listar esconde ENCERRADO/CANCELADO por padrão e ordena por prazo (sem prazo por último)", () => {
  const repo = novoRepo();
  repo.inserirNovos(
    [
      pedido(2001, { prazoEntrega: "2026-10-15" }),
      pedido(2002, { prazoEntrega: null }),
      pedido(2003, { prazoEntrega: "2026-10-01" }),
      pedido(2004, { prazoEntrega: "2026-10-05" }),
      pedido(2005, { prazoEntrega: "2026-10-01" }),
    ],
    T1
  );
  repo.atualizarTratativa(2004, { statusPcp: "ENCERRADO" }, T1);
  repo.atualizarTratativa(2005, { statusPcp: "CANCELADO" }, T1);

  assert.deepEqual(repo.listar().map((p) => p.nomusId), [2003, 2001, 2002]);
  assert.deepEqual(
    repo.listar({ incluirFinalizados: true }).map((p) => p.nomusId),
    [2003, 2005, 2004, 2001, 2002]
  );
});

test("a ordem segue o prazo editado", () => {
  const repo = novoRepo();
  repo.inserirNovos([pedido(2001, { prazoEntrega: "2026-10-01" }), pedido(2002, { prazoEntrega: "2026-10-10" })], T1);
  repo.atualizarTratativa(2001, { prazoEntrega: "2026-10-30" }, T2);
  assert.deepEqual(repo.listar().map((p) => p.nomusId), [2002, 2001]);
});

test("atualizarTratativa: só campos da whitelist, limpar data e pedido inexistente", () => {
  const repo = novoRepo();
  repo.inserirNovos([pedido(2001)], T1);

  repo.atualizarTratativa(2001, { prazoAcao: "2026-10-02" }, T1);
  assert.equal(repo.buscar(2001)!.prazoAcao, "2026-10-02");
  repo.atualizarTratativa(2001, { prazoAcao: null }, T2);
  assert.equal(repo.buscar(2001)!.prazoAcao, null);

  // Campo fora da whitelist é ignorado, nunca vira coluna de SQL.
  repo.atualizarTratativa(2001, { clienteNome: "hack", "nome; DROP TABLE pedidos": "x" } as never, T2);
  assert.equal(repo.buscar(2001)!.clienteNome, "Cliente 2001");

  assert.equal(repo.atualizarTratativa(9999, { acao: "x" }, T2), null);
});

test("histórico de sincronizações e rodadas órfãs", () => {
  const repo = novoRepo();
  assert.equal(repo.ultimaSync(), null);

  const id = repo.iniciarSync("teste", T1);
  assert.equal(repo.ultimaSync()!.status, "executando");

  repo.encerrarSyncsOrfaos(T2);
  const orfa = repo.ultimaSync()!;
  assert.equal(orfa.status, "erro");
  assert.match(orfa.erro!, /reiniciou/);

  const id2 = repo.iniciarSync("teste", T2);
  repo.atualizarProgressoSync(id2, 3, 1);
  assert.equal(repo.buscarSync(id2)!.pedidosLidos, 3);
  repo.finalizarSync(id2, { status: "ok", pedidosLidos: 5, novos: 2, erro: null }, T2);
  assert.equal(repo.ultimaSync(true)!.id, id2);
  assert.equal(repo.ultimaSync(true)!.pedidosLidos, 5);
  assert.notEqual(id, id2);
});

test("migração é idempotente: reabrir o banco não recria nem perde dados", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "pcp-"));
  const arquivo = join(dir, "sub", "pcp.sqlite");
  try {
    const db1 = openDatabase(arquivo);
    new PcpRepository(db1).inserirNovos([pedido(2001)], T1);
    db1.close();

    const db2 = openDatabase(arquivo);
    assert.equal(new PcpRepository(db2).buscar(2001)!.codigoPedido, "PD 01970");
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TUDO que o PCP altera fica gravado no arquivo do banco (status, prazo, atendimento...) e sobrevive a reabrir e a sincronizar", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "pcp-"));
  const arquivo = join(dir, "pcp.sqlite");
  try {
    // 1) O pedido entra com o prazo da Nomus.
    const db1 = openDatabase(arquivo);
    const repo1 = new PcpRepository(db1);
    repo1.inserirNovos([pedido(2001, { prazoEntrega: "2026-10-10" })], T1);
    assert.equal(repo1.buscar(2001)!.prazoEntrega, "2026-10-10");

    // 2) O PCP altera tudo no sistema, e cada alteração é gravada na hora.
    repo1.atualizarTratativa(2001, { prazoEntrega: "2026-10-25" }, T2);
    repo1.atualizarTratativa(2001, { statusPcp: "EM PRODUÇÃO" }, T2);
    repo1.atualizarTratativa(2001, { atendimento: "Aguardando compras", responsavel: "Ana", acao: "Cobrar chapa", prazoAcao: "2026-10-02", acaoStatus: "Em andamento" }, T2);
    db1.close(); // como se o servidor caísse/reiniciasse

    // 3) Reabre o arquivo: está tudo lá.
    const db2 = openDatabase(arquivo);
    const repo2 = new PcpRepository(db2);
    const esperado = { prazoEntrega: "2026-10-25", statusPcp: "EM PRODUÇÃO", atendimento: "Aguardando compras", responsavel: "Ana", acao: "Cobrar chapa", prazoAcao: "2026-10-02", acaoStatus: "Em andamento", atualizadoManualEm: T2 };
    assert.deepEqual(pick(repo2.buscar(2001)!, esperado), esperado);

    // 4) Uma nova sincronização (a Nomus traz outro prazo para o mesmo pedido) não desfaz nada.
    repo2.inserirNovos([pedido(2001, { prazoEntrega: "2026-12-31", clienteNome: "Outro" })], "2026-09-29T09:00:00.000Z");
    db2.close();

    const db3 = openDatabase(arquivo);
    assert.deepEqual(pick(new PcpRepository(db3).buscar(2001)!, esperado), esperado);
    db3.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Recorta de `linha` só as chaves de `modelo`, para comparar campo a campo. */
function pick(linha: object, modelo: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(modelo).map((k) => [k, (linha as Record<string, unknown>)[k]]));
}
