import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/db";
import { exportar, importar } from "../src/migracao";
import { PcpRepository } from "../src/repository";
import type { PedidoNomus } from "../src/types";

const T1 = "2026-09-28T10:00:00.000Z";
const T2 = "2026-09-28T11:00:00.000Z";
const T3 = "2026-09-29T09:00:00.000Z";

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

/** Origem com pedidos variados e edições de todo tipo, inclusive um finalizado. */
function origemPreenchida() {
  const repo = novoRepo();
  repo.inserirNovos([pedido(2001), pedido(2002), pedido(2003, { prazoEntrega: null, telefone: "" })], T1);
  repo.atualizarTratativa(
    2001,
    { statusPcp: "EM PRODUÇÃO", prazoEntrega: "2026-10-25", atendimento: "Aguardando compras", responsavel: "Ana", acao: "Cobrar chapa", prazoAcao: "2026-10-02", acaoStatus: "Em andamento" },
    T2
  );
  repo.atualizarTratativa(2002, { statusPcp: "ENCERRADO" }, T2);
  return repo;
}

const viaJson = (repo: PcpRepository) => JSON.parse(JSON.stringify(exportar(repo, T3)));

test("exportar → importar num banco vazio reproduz TODOS os campos, inclusive finalizados e datas vazias", () => {
  const origem = origemPreenchida();
  const destino = novoRepo();

  const r = importar(destino, viaJson(origem), { atualizar: false, agora: T3 });
  assert.deepEqual(r, { inseridos: 3, atualizados: 0, jaExistiam: 0, historico: 0 });
  assert.deepEqual(destino.listar({ incluirFinalizados: true }), origem.listar({ incluirFinalizados: true }));
  assert.equal(destino.listar().length, 2, "o encerrado continua fora da tabela");
});

test("importar duas vezes não muda nada na segunda (idempotente)", () => {
  const origem = origemPreenchida();
  const destino = novoRepo();
  importar(destino, viaJson(origem), { atualizar: true, agora: T3 });
  const r = importar(destino, viaJson(origem), { atualizar: true, agora: T3 });
  assert.deepEqual(r, { inseridos: 0, atualizados: 0, jaExistiam: 3, historico: 0 });
});

test("sem --atualizar, pedido que já existe no destino NÃO é sobrescrito", () => {
  const origem = origemPreenchida();
  const destino = novoRepo();
  destino.inserirNovos([pedido(2001)], T1);
  destino.atualizarTratativa(2001, { statusPcp: "EXPEDIÇÃO", responsavel: "Carlos" }, T2);

  const r = importar(destino, viaJson(origem), { atualizar: false, agora: T3 });
  assert.deepEqual(r, { inseridos: 2, atualizados: 0, jaExistiam: 1, historico: 0 });
  assert.equal(destino.buscar(2001)!.statusPcp, "EXPEDIÇÃO", "o que já estava no destino fica");
  assert.equal(destino.buscar(2001)!.responsavel, "Carlos");
});

test("com --atualizar, pedido existente recebe os campos EDITÁVEIS, mas nome, telefone e código nunca mudam", () => {
  const origem = origemPreenchida();
  const destino = novoRepo();
  // O destino já tem o pedido (ex.: entrou pela sincronização com a Nomus), com outros dados de cliente.
  destino.inserirNovos([pedido(2001, { clienteNome: "Nome da Nomus", telefone: "11 00000-0000", prazoEntrega: "2026-09-01" })], T1);

  const r = importar(destino, viaJson(origem), { atualizar: true, agora: T3 });
  assert.equal(r.atualizados, 1);
  assert.equal(r.inseridos, 2);

  const p = destino.buscar(2001)!;
  assert.equal(p.statusPcp, "EM PRODUÇÃO");
  assert.equal(p.prazoEntrega, "2026-10-25");
  assert.equal(p.atendimento, "Aguardando compras");
  assert.equal(p.responsavel, "Ana");
  assert.equal(p.acao, "Cobrar chapa");
  assert.equal(p.prazoAcao, "2026-10-02");
  assert.equal(p.acaoStatus, "Em andamento");
  assert.equal(p.clienteNome, "Nome da Nomus", "nome vem da Nomus e não é tocado");
  assert.equal(p.telefone, "11 00000-0000");
});

test("importar NUNCA apaga: pedidos que não estão no arquivo continuam no banco", () => {
  const destino = novoRepo();
  destino.inserirNovos([pedido(9001), pedido(9002)], T1);
  importar(destino, viaJson(origemPreenchida()), { atualizar: true, agora: T3 });
  assert.equal(destino.contar(), 5);
  assert.ok(destino.buscar(9001) && destino.buscar(9002));
});

test("arquivo inválido: aborta TUDO antes de gravar (nem os pedidos bons entram)", () => {
  const origem = origemPreenchida();
  const casos: Array<[string, (a: any) => void, RegExp]> = [
    ["versão desconhecida", (a) => (a.versao = 2), /versão/],
    ["sem lista de pedidos", (a) => delete a.pedidos, /lista de pedidos/],
    ["status inexistente", (a) => (a.pedidos[2].statusPcp = "INVENTADO"), /statusPcp/],
    ["ano absurdo no prazo", (a) => (a.pedidos[1].prazoEntrega = "0002-10-15"), /prazoEntrega/],
    ["pedido sem nomusId", (a) => delete a.pedidos[0].nomusId, /nomusId/],
    ["texto gigante", (a) => (a.pedidos[0].acao = "x".repeat(2001)), /acao/],
  ];

  for (const [nome, corromper, esperado] of casos) {
    const destino = novoRepo();
    const arquivo = viaJson(origem);
    corromper(arquivo);
    assert.throws(() => importar(destino, arquivo, { atualizar: true, agora: T3 }), esperado, nome);
    assert.equal(destino.contar(), 0, `${nome}: nada foi gravado`);
  }

  assert.throws(() => importar(novoRepo(), null, { atualizar: false, agora: T3 }), /inválido/);
  assert.throws(() => importar(novoRepo(), "texto", { atualizar: false, agora: T3 }), /inválido/);
});

test("falha no meio da gravação desfaz tudo (transação única)", () => {
  const origem = origemPreenchida();
  const destino = novoRepo();
  const arquivo = viaJson(origem);
  // O arquivo é válido; a falha é simulada no meio da gravação (2º pedido) para provar o rollback.
  let chamadas = 0;
  const original = destino.restaurarPedido.bind(destino);
  destino.restaurarPedido = (p) => {
    if (++chamadas === 2) throw new Error("falha simulada");
    return original(p);
  };

  assert.throws(() => importar(destino, arquivo, { atualizar: false, agora: T3 }), /falha simulada/);
  assert.equal(destino.contar(), 0, "o primeiro pedido, que chegou a ser gravado, foi desfeito");
});

// ---------------------------------------------------------------- histórico (pedidos antigos, só para a consulta pública)

const antigo = (numero: number, statusPcp = "ENCERRADO", prazoEntrega: string | null = "2026-08-28") => ({
  numero, statusPcp, prazoEntrega, origem: "planilha", importadoEm: T3,
});

test("o histórico viaja junto no exportar → importar", () => {
  const origem = origemPreenchida();
  origem.restaurarHistorico(antigo(917));
  origem.restaurarHistorico(antigo(918, "CANCELADO", null));

  const destino = novoRepo();
  const r = importar(destino, viaJson(origem), { atualizar: true, agora: T3 });
  assert.equal(r.historico, 2);
  assert.deepEqual(destino.listarHistorico(), origem.listarHistorico());
  assert.equal(destino.buscarHistorico(918)!.prazoEntrega, null);
});

test("histórico existente não é sobrescrito e importar duas vezes é idempotente", () => {
  const destino = novoRepo();
  destino.restaurarHistorico(antigo(917, "EXPEDIÇÃO"));

  const arquivo = { versao: 1, exportadoEm: T3, pedidos: [], historico: [antigo(917, "ENCERRADO"), antigo(919)] };
  assert.equal(importar(destino, arquivo, { atualizar: true, agora: T3 }).historico, 1);
  assert.equal(destino.buscarHistorico(917)!.statusPcp, "EXPEDIÇÃO", "o que já estava fica");
  assert.equal(importar(destino, arquivo, { atualizar: true, agora: T3 }).historico, 0);
});

test("arquivo antigo, sem a chave histórico, continua sendo aceito", () => {
  const sem = { versao: 1, exportadoEm: T3, pedidos: viaJson(origemPreenchida()).pedidos };
  const r = importar(novoRepo(), sem, { atualizar: false, agora: T3 });
  assert.equal(r.inseridos, 3);
  assert.equal(r.historico, 0);
});

test("histórico inválido aborta TUDO, inclusive os pedidos bons", () => {
  const casos: Array<[string, (h: any) => void, RegExp]> = [
    ["status inexistente", (h) => (h.statusPcp = "INVENTADO"), /statusPcp/],
    ["ano absurdo", (h) => (h.prazoEntrega = "0002-10-15"), /prazoEntrega/],
    ["número zero", (h) => (h.numero = 0), /numero/],
    ["sem origem", (h) => (h.origem = ""), /origem/],
  ];
  for (const [nome, corromper, esperado] of casos) {
    const destino = novoRepo();
    const arquivo = viaJson(origemPreenchida());
    arquivo.historico = [antigo(917)];
    corromper(arquivo.historico[0]);
    assert.throws(() => importar(destino, arquivo, { atualizar: false, agora: T3 }), esperado, nome);
    assert.equal(destino.contar(), 0, `${nome}: nenhum pedido foi gravado`);
    assert.equal(destino.listarHistorico().length, 0, `${nome}: nenhum histórico foi gravado`);
  }
  const naoLista = { ...viaJson(origemPreenchida()), historico: "x" };
  assert.throws(() => importar(novoRepo(), naoLista, { atualizar: false, agora: T3 }), /histórico/);
});

test("exportar funciona num banco de formato ANTIGO (sem a tabela de histórico), sem migrá-lo", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  // Banco como o do servidor antigo: só as tabelas da 1ª migração.
  db.exec(`CREATE TABLE pedidos (nomus_id INTEGER PRIMARY KEY, numero INTEGER NOT NULL, codigo_pedido TEXT NOT NULL, cliente_id INTEGER,
    cliente_nome TEXT NOT NULL DEFAULT '', telefone TEXT NOT NULL DEFAULT '', prazo_entrega TEXT, liberado INTEGER NOT NULL DEFAULT 1,
    primeiro_visto_em TEXT NOT NULL, atualizado_nomus_em TEXT NOT NULL, status_pcp TEXT NOT NULL DEFAULT 'AGUARDANDO',
    atendimento TEXT NOT NULL DEFAULT '', responsavel TEXT NOT NULL DEFAULT '', acao TEXT NOT NULL DEFAULT '', prazo_acao TEXT,
    acao_status TEXT NOT NULL DEFAULT 'Pendente', atualizado_manual_em TEXT)`);
  db.prepare("INSERT INTO pedidos (nomus_id, numero, codigo_pedido, primeiro_visto_em, atualizado_nomus_em) VALUES (2001, 1970, 'PD 01970', ?, ?)").run(T1, T1);

  const arquivo = exportar(new PcpRepository(db), T3);
  assert.equal(arquivo.pedidos.length, 1);
  assert.deepEqual(arquivo.historico, []);
  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => (r as { name: string }).name);
  assert.ok(!tabelas.includes("historico_pedidos"), "o export não alterou o banco");
});
