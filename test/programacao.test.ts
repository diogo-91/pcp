import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app";
import { openDatabase } from "../src/db";
import { ProgramacaoRepository } from "../src/programacao/repo";
import { ErroDeValidacao, ProgramacaoService } from "../src/programacao/service";
import { ProgramacaoSync } from "../src/programacao/sync";
import { PcpRepository } from "../src/repository";
import { SyncService, type NomusLeitor, type NomusPedidoLista } from "../src/sync";

// ------------------------------------------------------------------ infraestrutura de teste

const PRODUTOS: Record<number, { descricao: string }> = {
  3: { descricao: "TELHA SANDUICHE TR25 - 1020mm - (GALVALUME) - UMA FACE PINTADA" },
  9: { descricao: "TELHA SIMPLES TR25 - 1020mm - (GALVALUME) - SEM PINTURA" },
  50: { descricao: "CUMIEIRA TR25 SIMPLES" },
};

class NomusFalso implements NomusLeitor {
  chamadas: string[] = [];
  ordens: Array<{ id: number; nome: string; status: string; dataHoraInicialPlanejada: string; itensPedido: Array<{ id: number }> }> = [];
  falharOrdens = false;

  async get<T>(caminho: string): Promise<T> {
    this.chamadas.push(caminho);
    if (caminho.startsWith("/produtos?query=")) {
      const ids = [...caminho.matchAll(/id=(\d+)/g)].map((m) => Number(m[1]));
      return ids.filter((id) => PRODUTOS[id]).map((id) => ({ id, codigo: `P${id}`, descricao: PRODUTOS[id].descricao, nomeTipoProduto: "Produto acabado", siglaUnidadeMedida: "M2" })) as T;
    }
    if (caminho.startsWith("/ordens?query=")) {
      if (this.falharOrdens) throw new Error("Nomus fora do ar");
      const ids = [...caminho.matchAll(/itensPedido\.id=(\d+)/g)].map((m) => Number(m[1]));
      return this.ordens.filter((o) => o.itensPedido.some((i) => ids.includes(i.id))) as T;
    }
    throw new Error(`caminho inesperado: ${caminho}`);
  }
}

const pessoas = new Map([
  [100, { nomusId: 100, nome: "Cliente Cem", telefone: "+55 15 991585191", buscadoEm: "x", municipio: "Ibiúna", uf: "SP" }],
  [200, { nomusId: 200, nome: "Cliente Duzentos", telefone: "(11) 3222-1234", buscadoEm: "x", municipio: "Mairinque", uf: "SP" }],
]);
const carregarPessoas = async (ids: number[]) => new Map(ids.filter((i) => pessoas.has(i)).map((i) => [i, pessoas.get(i)!]));

const item = (id: number, produto: number, info: string, quantidade: string, extra: Partial<{ status: number; dataEntrega: string }> = {}) => ({
  id,
  item: `${String(id % 100).padStart(5, "0")}`,
  idProduto: produto,
  informacoesAdicionaisProduto: info,
  quantidade,
  valorUnitario: "10",
  status: 2,
  dataEntrega: "20/10/2026 00:00:00",
  ...extra,
});
const pedido = (id: number, codigo: string, cliente: number, itens: ReturnType<typeof item>[], valorTotal = "1.000,00"): NomusPedidoLista => ({
  id,
  codigoPedido: `PD ${codigo}`,
  idPessoaCliente: cliente,
  dataEmissao: "05/10/2026 00:00:00",
  valorTotal,
  itensPedido: itens,
});

function montar(inicio = "2026-10-08T12:00:00Z", opcoes: { statusCancelado?: number[] } = {}) {
  const db = openDatabase(":memory:");
  const relogio = { atual: new Date(inicio) };
  const agora = () => relogio.atual;
  const repo = new ProgramacaoRepository(db);
  const nomus = new NomusFalso();
  const sync = new ProgramacaoSync(nomus, repo, { statusLiberado: 2, statusCancelado: opcoes.statusCancelado, agora, sleep: async () => {} });
  const servico = new ProgramacaoService(repo, agora);
  const rodar = (pedidos: NomusPedidoLista[]) => sync.processarPagina(pedidos, carregarPessoas);
  const todas = () => servico.todasAsLinhas("completo");
  return { db, repo, nomus, sync, servico, rodar, relogio, todas };
}

/** Pedido padrão dos testes: 1 sanduíche (27,94 m de telha) + 1 simples. */
const pedidoPadrao = () =>
  pedido(2127, "02085", 100, [item(4329, 3, "5 X 4,16\r\n2 X 3,57\r\nUMA FACE PRETO EXTERNO", "27,94"), item(4330, 9, "10 X 3.000", "30")], "37.698,00");

// ------------------------------------------------------------------ sincronização

test("a sincronização cria pedido e itens com cidade, telefone, medidas, cor e consumos", async () => {
  const { rodar, todas, repo } = montar();
  const r = await rodar([pedidoPadrao()]);
  assert.deepEqual(r, { lidos: 1, criados: 1, atualizados: 0, erros: 0 });

  const linhas = todas();
  assert.equal(linhas.length, 2);
  const sand = linhas.find((l) => l.categoria === "SANDUICHE")!;
  assert.equal(sand.cliente, "Cliente Cem");
  assert.equal(sand.cidade, "Ibiúna-SP");
  assert.equal(sand.telefone, "(15) 99158-5191");
  assert.equal(sand.prazoVigente, "2026-10-20");
  assert.equal(sand.metrosTelha, 27.94);
  assert.equal(sand.metrosChapa, 55.88);
  assert.equal(sand.trapezio, "TR25");
  assert.equal(sand.tipoPintura, "PINTURA");
  assert.equal(sand.facesPintura, 1);
  assert.match(sand.cor?.nome ?? "", /^Preto fosco/);
  assert.equal(sand.situacao, "PROGRAMAR");
  const consumo = Object.fromEntries(sand.consumos.map((c) => [c.material, c.quantidade]));
  assert.deepEqual(consumo, { bobina: 201.17, eps: 27.94, cola: 5.59, tinta: 5.59 });
  assert.equal(repo.listarPedidos()[0].dataPedido, "2026-10-05");
});

test("rodar a sincronização duas vezes não duplica nem altera nada (nem updated_at)", async () => {
  const { rodar, relogio, repo, db } = montar();
  await rodar([pedidoPadrao()]);
  const antes = db.prepare("SELECT updated_at FROM pcp_pedido_item ORDER BY id").all();
  const antesPedido = db.prepare("SELECT updated_at, nomus_hash FROM pcp_pedido").all();

  relogio.atual = new Date("2026-10-09T12:00:00Z");
  const r = await rodar([pedidoPadrao()]);

  assert.deepEqual(r, { lidos: 1, criados: 0, atualizados: 0, erros: 0 });
  assert.equal(repo.listarItens().length, 2);
  assert.equal(repo.listarPedidos().length, 1);
  assert.deepEqual(db.prepare("SELECT updated_at FROM pcp_pedido_item ORDER BY id").all(), antes);
  assert.deepEqual(db.prepare("SELECT updated_at, nomus_hash FROM pcp_pedido").all(), antesPedido);
});

test("a sincronização NUNCA sobrescreve o que o PCP editou; só atualiza os campos da Nomus", async () => {
  const { rodar, servico, repo, todas } = montar();
  await rodar([pedidoPadrao()]);
  const sand = todas().find((l) => l.categoria === "SANDUICHE")!;

  servico.editarItem(sand.id, { situacao: "PROGRAMADO", dataProgramacao: "2026-10-12", dataLiberacaoProducao: "2026-10-09", fornecedorTerceiro: "Fenix" }, "Ana");
  servico.editarPedido(sand.pedidoId, { observacao: "Cliente retira", dataEntregaNegociada: "2026-11-05", rotaId: 7 }, "Ana");

  // A Nomus muda: nome do cliente, valor, data de entrega e a quantidade/medidas do item.
  const mudou = pedido(2127, "02085", 100, [item(4329, 3, "6 X 4,16\r\nUMA FACE PRETO EXTERNO", "24,96", { dataEntrega: "30/12/2026 00:00:00" }), item(4330, 9, "10 X 3.000", "30")], "40.000,00");
  pessoas.set(100, { ...pessoas.get(100)!, nome: "Cliente Cem Ltda" });
  try {
    const r = await rodar([mudou]);
    assert.equal(r.atualizados, 1);
  } finally {
    pessoas.set(100, { ...pessoas.get(100)!, nome: "Cliente Cem" });
  }

  const ped = repo.listarPedidos()[0];
  assert.equal(ped.clienteNome, "Cliente Cem Ltda", "campo da Nomus foi atualizado");
  assert.equal(ped.valorCentavos, 4000000);
  assert.equal(ped.observacao, "Cliente retira", "observação do PCP preservada");
  assert.equal(ped.dataEntregaNegociada, "2026-11-05", "prazo negociado preservado");
  assert.equal(ped.dataEntregaOriginal, "2026-10-20", "prazo original é imutável depois da primeira carga");
  assert.equal(ped.rotaId, 7, "rota escolhida à mão preservada");

  const novo = repo.buscarItem(sand.id)!;
  assert.equal(novo.situacao, "PROGRAMADO");
  assert.equal(novo.dataProgramacao, "2026-10-12");
  assert.equal(novo.dataLiberacaoProducao, "2026-10-09");
  assert.equal(novo.fornecedorTerceiro, "Fenix");
  assert.equal(novo.metrosTelha, 24.96, "medida nova da Nomus recalculou");
  assert.equal(novo.alteradoNoErp, true, "item já programado + mudança no ERP = alerta");
  assert.ok(todas().find((l) => l.id === sand.id)!.alertas.some((a) => a.codigo === "alterado_erp"));
  const consumos = Object.fromEntries(repo.consumosDoItem(sand.id).map((c) => [c.material, c.quantidade]));
  assert.equal(consumos.bobina, 179.71, "consumo recalculado (24,96 × 2 × 3,6)");
});

test("correção manual de campo derivado (ex.: medidas) não é desfeita pela Nomus", async () => {
  const { rodar, servico, repo, todas } = montar();
  await rodar([pedidoPadrao()]);
  const sand = todas().find((l) => l.categoria === "SANDUICHE")!;
  servico.editarItem(sand.id, { medidas: [{ qtd: 3, comprimento_m: 6 }] }, "Ana");
  assert.equal(repo.buscarItem(sand.id)!.metrosTelha, 18);
  assert.equal(repo.buscarItem(sand.id)!.metrosChapa, 36);

  await rodar([pedido(2127, "02085", 100, [item(4329, 3, "9 X 9,00\r\nUMA FACE PRETO EXTERNO", "81"), item(4330, 9, "10 X 3.000", "30")], "37.698,00")]);
  assert.equal(repo.buscarItem(sand.id)!.metrosTelha, 18, "medida corrigida à mão continua valendo");

  servico.editarItem(sand.id, { resetar: ["medidas"] }, "Ana");
  assert.equal(repo.buscarItem(sand.id)!.metrosTelha, 81, "voltou ao cálculo automático");
});

test("item que some do pedido na Nomus é marcado (não apagado)", async () => {
  const { rodar, repo } = montar();
  await rodar([pedidoPadrao()]);
  await rodar([pedido(2127, "02085", 100, [item(4329, 3, "5 X 4,16\r\n2 X 3,57\r\nUMA FACE PRETO EXTERNO", "27,94")], "37.698,00")]);
  const sumido = repo.buscarItemPorNomus(4330)!;
  assert.equal(sumido.removidoNoErp, true);
  assert.equal(repo.listarItens().length, 2);
});

test("item que continua no pedido mas deixou de estar liberado NÃO vira 'removido'", async () => {
  const { rodar, repo } = montar();
  await rodar([pedidoPadrao()]);
  await rodar([pedido(2127, "02085", 100, [item(4329, 3, "5 X 4,16\r\n2 X 3,57\r\nUMA FACE PRETO EXTERNO", "27,94"), item(4330, 9, "10 X 3.000", "30", { status: 4 })])]);
  assert.equal(repo.buscarItemPorNomus(4330)!.removidoNoErp, false);
});

test("pedido cancelado na Nomus: itens viram CANCELADO com evento de origem 'sync'", async () => {
  const { rodar, repo, todas } = montar("2026-10-08T12:00:00Z", { statusCancelado: [9] });
  await rodar([pedidoPadrao()]);
  await rodar([pedido(2127, "02085", 100, [item(4329, 3, "5 X 4,16", "27,94", { status: 9 }), item(4330, 9, "10 X 3.000", "30", { status: 2 })])]);
  const cancelado = todas().find((l) => l.id === repo.buscarItemPorNomus(4329)!.id)!;
  assert.equal(cancelado.situacao, "CANCELADO");
  const evento = repo.eventosDoPedido(cancelado.pedidoId).find((e) => e.campo === "situacao")!;
  assert.equal(evento.origem, "sync");
  assert.equal(evento.valorNovo, "CANCELADO");
});

test("OPs vêm da Nomus (/ordens) e ligam ao item; falha na consulta não apaga as que já existem", async () => {
  const { rodar, nomus, repo, todas } = montar();
  nomus.ordens = [
    { id: 1, nome: "OS 02697 - 001", status: "Liberada", dataHoraInicialPlanejada: "19/10/2026 00:00:00", itensPedido: [{ id: 4329 }] },
    { id: 2, nome: "OS 02697 - 002", status: "Confirmada", dataHoraInicialPlanejada: "20/10/2026 00:00:00", itensPedido: [{ id: 4329 }] },
  ];
  await rodar([pedidoPadrao()]);
  const sand = todas().find((l) => l.categoria === "SANDUICHE")!;
  assert.deepEqual(sand.ops.map((o) => o.numero), ["OS 02697 - 001", "OS 02697 - 002"]);
  assert.equal(sand.ops[0].status, "Liberada");

  nomus.falharOrdens = true;
  const r = await rodar([pedidoPadrao()]);
  assert.equal(r.erros, 0);
  assert.equal(repo.opsDoItem(sand.id).length, 2, "OPs preservadas");
});

test("erro em um pedido não interrompe o lote", async () => {
  const { rodar, repo } = montar();
  const ruim = { ...pedido(1, "sem-numero", 100, [item(9001, 9, "1 X 1", "1")]), codigoPedido: "PD" };
  const r = await rodar([ruim, pedidoPadrao()]);
  assert.equal(r.erros, 1);
  assert.equal(r.criados, 1);
  assert.equal(repo.listarPedidos().length, 1);
});

test("integração: o SyncService repassa cada página ao módulo e grava o log da rodada", async () => {
  const db = openDatabase(":memory:");
  const pcpRepo = new PcpRepository(db);
  const progRepo = new ProgramacaoRepository(db);
  const nomus = new NomusFalso();
  const original = nomus.get.bind(nomus);
  nomus.get = async <T,>(c: string): Promise<T> => {
    if (c.startsWith("/pedidos?")) return [pedidoPadrao()] as T;
    if (c.startsWith("/pessoas?query=")) return [{ id: 100, nome: "Cliente Cem", telefone: "15 99999-0000", municipio: "Ibiúna", uf: "SP" }] as T;
    return original<T>(c);
  };
  const progSync = new ProgramacaoSync(nomus, progRepo, { statusLiberado: 2, sleep: async () => {} });
  const sync = new SyncService(nomus, pcpRepo, { statusLiberado: 2, programacao: progSync, sleep: async () => {} });

  const run = await sync.executar("teste");
  assert.equal(run.status, "ok");
  assert.equal(progRepo.listarItens().length, 2);
  const log = progRepo.ultimaSyncProgramacao()!;
  assert.equal(log.criados, 1);
  assert.ok(log.finalizadoEm);
  assert.equal(progRepo.listarPedidos()[0].cidade, "Ibiúna-SP");
});

test("falha no módulo Programação não derruba a sincronização do PCP", async () => {
  const db = openDatabase(":memory:");
  const pcpRepo = new PcpRepository(db);
  const nomus = new NomusFalso();
  nomus.get = async <T,>(c: string): Promise<T> => {
    if (c.startsWith("/pedidos?")) return [pedidoPadrao()] as T;
    if (c.startsWith("/pessoas?query=")) return [{ id: 100, nome: "C", telefone: "1", municipio: "S", uf: "SP" }] as T;
    throw new Error("x");
  };
  const quebrado = { iniciarRodada() {}, async lerPagina() { throw new Error("bug no módulo"); }, finalizarRodada() {} };
  const sync = new SyncService(nomus, pcpRepo, { statusLiberado: 2, programacao: quebrado, sleep: async () => {} });
  const run = await sync.executar("teste");
  assert.equal(run.status, "ok");
  assert.equal(pcpRepo.contar(), 1);
});

// ------------------------------------------------------------------ edição e validações

test("salvar data produzida anterior à liberação é bloqueado", async () => {
  const { rodar, servico, todas, repo } = montar();
  await rodar([pedidoPadrao()]);
  const id = todas()[0].id;
  servico.editarItem(id, { dataLiberacaoProducao: "2026-10-10" }, "Ana");
  assert.throws(() => servico.editarItem(id, { situacao: "PRODUZIDO", dataProduzida: "2026-10-09" }, "Ana"), (e) => e instanceof ErroDeValidacao && /anterior/.test(e.message));
  assert.equal(repo.buscarItem(id)!.dataProduzida, null, "nada foi gravado");
  assert.equal(repo.buscarItem(id)!.situacao, "PROGRAMAR");
});

test("PRODUZIDO sem data é bloqueado; ENTREGUE sem data assume hoje", async () => {
  const { rodar, servico, todas, repo } = montar();
  await rodar([pedidoPadrao()]);
  const id = todas()[0].id;
  assert.throws(() => servico.editarItem(id, { situacao: "PRODUZIDO" }, "Ana"), ErroDeValidacao);
  servico.editarItem(id, { situacao: "ENTREGUE" }, "Ana");
  assert.equal(repo.buscarItem(id)!.dataEntregaRealizada, "2026-10-08");
});

test("datas inválidas e texto livre são recusados", async () => {
  const { rodar, servico, todas } = montar();
  await rodar([pedidoPadrao()]);
  const id = todas()[0].id;
  for (const ruim of ["xxx", "22/01 e 23/01", "2026-02-30", "0002-10-15"]) {
    assert.throws(() => servico.editarItem(id, { dataProgramacao: ruim }, "Ana"), ErroDeValidacao, ruim);
  }
  assert.throws(() => servico.editarItem(id, { situacao: "aguardo?" }, "Ana"), ErroDeValidacao);
});

test("toda mudança de situação, data e observação gera evento com autor", async () => {
  const { rodar, servico, todas, repo } = montar();
  await rodar([pedidoPadrao()]);
  const l = todas()[0];
  servico.editarItem(l.id, { situacao: "PROGRAMADO", dataProgramacao: "2026-10-12" }, "Ana");
  servico.editarPedido(l.pedidoId, { observacao: "Liberado 18/05" }, "Bruno");
  const eventos = repo.eventosDoPedido(l.pedidoId);
  const por = (campo: string) => eventos.find((e) => e.campo === campo)!;
  assert.equal(por("situacao").usuario, "Ana");
  assert.deepEqual([por("situacao").valorAntigo, por("situacao").valorNovo], ["PROGRAMAR", "PROGRAMADO"]);
  assert.equal(por("data_programacao").valorNovo, "2026-10-12");
  assert.equal(por("observacao").usuario, "Bruno");
  // Salvar o mesmo valor de novo não gera evento.
  const n = eventos.length;
  servico.editarItem(l.id, { situacao: "PROGRAMADO" }, "Ana");
  assert.equal(repo.eventosDoPedido(l.pedidoId).length, n);
});

test("edição em massa é atômica: se um item for inválido, nada é gravado", async () => {
  const { rodar, servico, todas, repo } = montar();
  await rodar([pedidoPadrao()]);
  const [a, b] = todas();
  servico.editarItem(b.id, { situacao: "PRODUZIDO", dataProduzida: "2026-10-01" }, "Ana"); // b exige data de entrega ≥ produzida abaixo
  assert.throws(() => servico.editarEmLote([a.id, 99999], { situacao: "PROGRAMADO" }, "Ana"), ErroDeValidacao);
  assert.equal(repo.buscarItem(a.id)!.situacao, "PROGRAMAR", "o item válido também ficou como estava");

  const r = servico.editarEmLote([a.id, b.id], { dataProgramacao: "2026-10-15", rotaId: 3 }, "Ana");
  assert.equal(r.atualizados, 2);
  assert.equal(repo.buscarItem(a.id)!.dataProgramacao, "2026-10-15");
  assert.equal(repo.buscarPedido(a.pedidoId)!.rotaId, 3);
});

// ------------------------------------------------------------------ totais, filtros, indicadores

test("pedido com 2 itens e R$ 37.698,00 soma R$ 37.698,00 no rodapé (não o dobro)", async () => {
  const { rodar, servico } = montar();
  await rodar([pedidoPadrao()]);
  const lista = servico.listar({}, "completo");
  assert.equal(lista.itens.length, 2);
  assert.equal(lista.totais.valor, 37698);
  assert.equal(lista.totais.pedidos, 1);
  assert.equal(lista.totais.itens, 2);
  assert.equal(lista.indicadores.valorEmAberto, 37698);
});

test("agregados padrão excluem CANCELADO e DEVOLUÇÃO", async () => {
  const { rodar, servico, todas } = montar();
  await rodar([pedidoPadrao(), pedido(2128, "02086", 200, [item(5001, 9, "4 X 5,00", "20")], "5.000,00")]);
  const [a, b, c] = todas();
  servico.editarItem(a.id, { situacao: "CANCELADO" }, "Ana");
  servico.editarItem(b.id, { situacao: "DEVOLUCAO" }, "Ana");

  const lista = servico.listar({ visao: "todos" }, "completo");
  assert.equal(lista.itens.length, 3, "a grade ainda mostra tudo na visão 'todos'");
  assert.equal(lista.totais.itens, 1, "mas o total só conta o que não é cancelado/devolvido");
  assert.equal(lista.indicadores.itensEmAberto, 1);
  assert.ok([a, b, c].length === 3);
});

test("item ENTREGUE, mesmo com prazo vencido, não conta como atrasado nos indicadores", async () => {
  const { rodar, servico, todas, relogio } = montar();
  await rodar([pedidoPadrao()]);
  const [a, b] = todas();
  servico.editarItem(a.id, { situacao: "ENTREGUE", dataEntregaRealizada: "2026-10-15" }, "Ana");
  relogio.atual = new Date("2026-10-25T12:00:00Z"); // depois do prazo (20/10)

  const lista = servico.listar({ visao: "todos" }, "completo");
  const entregue = lista.itens.find((i) => i.id === a.id)!;
  const aberto = lista.itens.find((i) => i.id === b.id)!;
  assert.equal(entregue.statusPrazo.codigo, "entregue_no_prazo");
  assert.equal(aberto.statusPrazo.codigo, "atrasado");
  assert.equal(lista.indicadores.atrasados.itens, 1);
  assert.equal(lista.indicadores.atrasados.diasMediano, 5);
  assert.deepEqual(lista.indicadores.pontualidadeMes, { entregues: 1, noPrazo: 1, percentual: 100 });
});

test("visão 'Atrasados' + rota retorna exatamente os atrasados em aberto daquela rota", async () => {
  const { rodar, servico, todas, relogio, repo } = montar();
  await rodar([
    pedido(1, "00001", 100, [item(11, 9, "1 X 1,00", "1", { dataEntrega: "01/10/2026 00:00:00" })]),
    pedido(2, "00002", 200, [item(12, 9, "1 X 1,00", "1", { dataEntrega: "02/10/2026 00:00:00" })]),
    pedido(3, "00003", 100, [item(13, 9, "1 X 1,00", "1", { dataEntrega: "30/12/2026 00:00:00" })]),
  ]);
  const linhas = todas();
  const id = (num: number) => linhas.find((l) => l.numeroPedido === num)!;
  servico.editarPedido(id(1).pedidoId, { rotaId: 1 }, "Ana");
  servico.editarPedido(id(2).pedidoId, { rotaId: 2 }, "Ana");
  servico.editarPedido(id(3).pedidoId, { rotaId: 1 }, "Ana");
  assert.ok(relogio.atual && repo);

  const r = servico.listar({ visao: "atrasados", rota: ["1"] }, "completo");
  assert.deepEqual(r.itens.map((i) => i.numeroPedido), [1]);
  assert.equal(servico.listar({ visao: "atrasados" }, "completo").itens.length, 2);
  assert.equal(servico.listar({ visao: "atrasados", rota: ["sem"] }, "completo").itens.length, 0);
});

test("filtros por situação, busca por cliente/OP, intervalo de datas e 'só alertas'", async () => {
  const { rodar, servico, todas, nomus } = montar();
  nomus.ordens = [{ id: 1, nome: "OS 02697 - 001", status: "Liberada", dataHoraInicialPlanejada: "19/10/2026 00:00:00", itensPedido: [{ id: 5001 }] }];
  await rodar([pedidoPadrao(), pedido(2128, "02086", 200, [item(5001, 9, "4 X 5,00", "20")], "5.000,00")]);
  const l = todas().find((x) => x.numeroPedido === 2086)!;
  servico.editarItem(l.id, { situacao: "PROGRAMADO", dataProgramacao: "2026-10-12" }, "Ana");

  assert.equal(servico.listar({ situacao: ["PROGRAMADO"] }, "completo").itens.length, 1);
  assert.equal(servico.listar({ q: "duzentos" }, "completo").itens.length, 1);
  assert.equal(servico.listar({ q: "02697" }, "completo").itens.length, 1, "busca por OP");
  assert.equal(servico.listar({ campoData: "programacao", de: "2026-10-10", ate: "2026-10-14" }, "completo").itens.length, 1);
  assert.equal(servico.listar({ campoData: "programacao", de: "2026-10-13" }, "completo").itens.length, 0);
  const comAlerta = servico.listar({ soAlertas: true }, "completo").itens;
  assert.ok(comAlerta.length > 0 && comAlerta.every((i) => i.alertas.length > 0));
});

test("indicador 'liberados após o prazo' e flags de pronta entrega", async () => {
  const { rodar, servico, todas } = montar();
  await rodar([pedidoPadrao()]);
  const [a, b] = todas();
  servico.editarItem(a.id, { dataLiberacaoProducao: "2026-10-25" }, "Ana"); // prazo 20/10 → liberado depois
  servico.editarItem(b.id, { dataLiberacaoProducao: "2026-10-10", situacao: "PRODUZIDO", dataProduzida: "2026-10-12" }, "Ana");
  const lista = servico.listar({ visao: "todos" }, "completo");
  assert.equal(lista.itens.find((i) => i.id === a.id)!.liberadoAposPrazo, true);
  assert.equal(lista.itens.find((i) => i.id === a.id)!.prontaEntrega, false, "sem data produzida não é pronta entrega");
  assert.equal(lista.itens.find((i) => i.id === b.id)!.prontaEntrega, true);
  assert.deepEqual(lista.indicadores.liberadosAposPrazo, { itens: 1, base: 2, percentual: 50 });
  assert.equal(servico.listar({ visao: "liberados_apos_prazo" }, "completo").itens.length, 1);
  assert.equal(servico.listar({ visao: "produzidos_aguardando_entrega" }, "completo").itens.length, 1);
});

test("programação vencida e cidade sem rota viram alertas", async () => {
  const { rodar, servico, todas, relogio } = montar();
  await rodar([pedidoPadrao()]);
  const l = todas()[0];
  servico.editarItem(l.id, { situacao: "PROGRAMADO", dataProgramacao: "2026-10-12" }, "Ana");
  relogio.atual = new Date("2026-10-15T12:00:00Z");
  const alertas = servico.listar({ visao: "todos" }, "completo").itens.find((i) => i.id === l.id)!.alertas.map((a) => a.codigo);
  assert.ok(alertas.includes("programacao_vencida"));
  assert.ok(alertas.includes("sem_rota"));
});

// ------------------------------------------------------------------ parâmetros, rota, produto

test("alterar o parâmetro de bobina recalcula itens não produzidos e preserva os já produzidos", async () => {
  const { rodar, servico, todas, repo } = montar();
  await rodar([pedidoPadrao()]);
  const [a, b] = todas();
  servico.editarItem(b.id, { situacao: "PRODUZIDO", dataProduzida: "2026-10-09" }, "Ana");
  const bobina = (id: number) => repo.consumosDoItem(id).find((c) => c.material === "bobina")!.quantidade;
  const antesA = bobina(a.id);
  const antesB = bobina(b.id);

  servico.alterarParametro("bobina_kg_por_metro", 3.3, "Admin");
  assert.equal(bobina(a.id), Math.round(a.metrosChapa * 3.3 * 100) / 100, "não produzido: recalculado");
  assert.notEqual(bobina(a.id), antesA);
  assert.equal(bobina(b.id), antesB, "produzido: congelado");
  assert.equal(repo.parametro("bobina_kg_por_metro"), 3.3);
  assert.throws(() => servico.alterarParametro("nao_existe", 1), ErroDeValidacao);
  assert.throws(() => servico.alterarParametro("bobina_kg_por_metro", -1), ErroDeValidacao);
});

test("cidade → rota: escolher a rota de um pedido e lembrar vale para os próximos da cidade", async () => {
  const { rodar, servico, todas, repo } = montar();
  await rodar([pedidoPadrao()]);
  servico.editarPedido(todas()[0].pedidoId, { rotaId: 1, lembrarCidade: true }, "Ana");
  assert.equal(repo.rotaDaCidade("ibiuna-sp"), 1);

  await rodar([pedido(3000, "03000", 100, [item(7001, 9, "1 X 2,00", "2")])]);
  const novo = todas().find((l) => l.numeroPedido === 3000)!;
  assert.equal(novo.rota?.id, 1, "pedido novo da mesma cidade já nasce com a rota");

  const r = servico.definirRotaDaCidade("Mairinque-SP", 7);
  assert.equal(r.pedidosAfetados, 0);
});

test("corrigir a categoria de um produto refaz os itens que o usam e recalcula os consumos", async () => {
  const { rodar, servico, todas, repo } = montar();
  await rodar([pedidoPadrao()]);
  const simples = todas().find((l) => l.categoria === "SIMPLES")!;
  assert.equal(simples.metrosChapa, 30);

  const r = servico.definirCategoriaDoProduto(9, "SANDUICHE", "Ana");
  assert.equal(r.itensAfetados, 1);
  const depois = repo.buscarItem(simples.id)!;
  assert.equal(depois.categoria, "SANDUICHE");
  assert.equal(depois.metrosChapa, 60);
  assert.ok(repo.consumosDoItem(simples.id).some((c) => c.material === "eps"));
  assert.throws(() => servico.definirCategoriaDoProduto(9, "INVENTADA"), ErroDeValidacao);
});

test("consumo manual (parafuso) é gravado e sobrevive ao recálculo", async () => {
  const { rodar, servico, todas, repo } = montar();
  await rodar([pedidoPadrao()]);
  const id = todas()[0].id;
  servico.definirConsumoManual(id, "parafuso_1", 120, null, "Ana");
  servico.alterarParametro("bobina_kg_por_metro", 3.5, "Admin");
  const manual = repo.consumosDoItem(id).find((c) => c.material === "parafuso_1")!;
  assert.equal(manual.quantidade, 120);
  assert.equal(manual.origem, "manual");
  assert.equal(manual.unidade, "un");
  assert.throws(() => servico.definirConsumoManual(id, "inexistente", 1, null), ErroDeValidacao);
});

// ------------------------------------------------------------------ exportação

test("CSV da visão filtrada: separador ;, BOM, sem telefone no perfil consulta e sem injeção de fórmula", async () => {
  const { rodar, servico, todas } = montar();
  await rodar([pedidoPadrao()]);
  servico.editarPedido(todas()[0].pedidoId, { observacao: '=HYPERLINK("http://x")' }, "Ana");

  const csv = servico.exportarCsv({}, "completo");
  assert.ok(csv.startsWith("﻿Pedido;"));
  assert.match(csv, /\(15\) 99158-5191/);
  assert.match(csv, /'=HYPERLINK/, "texto que começa com = é neutralizado");
  assert.doesNotMatch(servico.exportarCsv({}, "consulta"), /99158-5191/);
});

// ------------------------------------------------------------------ API e perfis

async function montarApi(opcoes: { accessToken?: string; consulta?: string } = {}) {
  const base = montar();
  await base.rodar([pedidoPadrao()]);
  const db = base.db;
  const pcpRepo = new PcpRepository(db);
  const sync = new SyncService(base.nomus, pcpRepo, { statusLiberado: 2 });
  const app = await buildApp({
    repo: pcpRepo, sync, programacao: base.servico, accessToken: opcoes.accessToken ?? "", accessTokenConsulta: opcoes.consulta, agora: () => base.relogio.atual,
  });
  return { ...base, app };
}

test("API: lista, detalhe do pedido, edição e eventos", async () => {
  const { app, todas } = await montarApi();
  const lista = (await app.inject({ method: "GET", url: "/api/programacao" })).json();
  assert.equal(lista.itens.length, 2);
  assert.equal(lista.perfil, "completo");
  assert.ok(lista.opcoes.situacoes.length >= 18);

  const alvo = todas()[0];
  const patch = await app.inject({
    method: "PATCH", url: `/api/programacao/itens/${alvo.id}`, headers: { "x-pcp-usuario": encodeURIComponent("Ana Souza") },
    payload: { situacao: "PROGRAMADO", dataProgramacao: "2026-10-12", campoInventado: "x" },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().situacao, "PROGRAMADO");

  const detalhe = (await app.inject({ method: "GET", url: `/api/programacao/pedidos/${alvo.pedidoId}` })).json();
  assert.equal(detalhe.itens.length, 2);
  assert.equal(detalhe.eventos[0].usuario, "Ana Souza");

  const ruim = await app.inject({ method: "PATCH", url: `/api/programacao/itens/${alvo.id}`, payload: { situacao: "PRODUZIDO" } });
  assert.equal(ruim.statusCode, 400);
  assert.match(ruim.json().erro, /data produzida/i);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/programacao/itens/99999", payload: { situacao: "PROGRAMADO" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/programacao/itens/abc", payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/programacao?visao=atrasados" })).json().itens.length, 0);
});

test("API: perfil de consulta não vê telefone, não edita e não acessa o resto do PCP", async () => {
  const { app, todas } = await montarApi({ accessToken: "codigo-completo", consulta: "codigo-consulta" });
  const completo = { "x-pcp-token": "codigo-completo" };
  const consulta = { "x-pcp-token": "codigo-consulta" };

  assert.equal((await app.inject({ method: "GET", url: "/api/programacao" })).statusCode, 401);

  const c = (await app.inject({ method: "GET", url: "/api/programacao", headers: consulta })).json();
  assert.equal(c.perfil, "consulta");
  assert.ok(c.itens.every((i: { telefone: string | null }) => i.telefone === null), "telefone oculto");
  assert.equal(JSON.stringify(c).includes("99158"), false);

  const f = (await app.inject({ method: "GET", url: "/api/programacao", headers: completo })).json();
  assert.equal(f.itens[0].telefone, "(15) 99158-5191");

  const id = todas()[0].id;
  assert.equal((await app.inject({ method: "PATCH", url: `/api/programacao/itens/${id}`, headers: consulta, payload: { situacao: "PROGRAMADO" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/pedidos", headers: consulta })).statusCode, 403);
  const csv = await app.inject({ method: "GET", url: "/api/programacao/exportar.csv", headers: consulta });
  assert.equal(csv.statusCode, 200);
  assert.doesNotMatch(csv.body, /99158/);
  assert.equal((await app.inject({ method: "GET", url: "/api/pedidos", headers: completo })).statusCode, 200);
});

test("API: parâmetros, produtos e cidade→rota exigem perfil completo", async () => {
  const { app } = await montarApi({ accessToken: "codigo-completo", consulta: "codigo-consulta" });
  const completo = { "x-pcp-token": "codigo-completo" };
  assert.equal((await app.inject({ method: "GET", url: "/api/programacao/parametros", headers: { "x-pcp-token": "codigo-consulta" } })).statusCode, 403);

  const p = await app.inject({ method: "PATCH", url: "/api/programacao/parametros", headers: completo, payload: { chave: "bobina_kg_por_metro", valor: 3.4 } });
  assert.equal(p.statusCode, 200);
  const r = await app.inject({ method: "PUT", url: "/api/programacao/cidades-rota", headers: completo, payload: { cidade: "Ibiúna-SP", rotaId: 1 } });
  assert.equal(r.json().pedidosAfetados, 1);
  const prod = (await app.inject({ method: "GET", url: "/api/programacao/produtos", headers: completo })).json();
  assert.ok(prod.length >= 2);
});

test("sincronizar um pedido só: busca na Nomus e atualiza apenas ele; pedido desconhecido é recusado", async () => {
  const { rodar, sync, nomus, repo, todas } = montar();
  await rodar([pedidoPadrao()]);

  const original = nomus.get.bind(nomus);
  nomus.get = async <T,>(c: string): Promise<T> => {
    if (c === "/pedidos/2127") return pedido(2127, "02085", 100, [item(4329, 3, "9 X 9,00", "81"), item(4330, 9, "10 X 3.000", "30")], "37.698,00") as T;
    if (c === "/pessoas/100") return { id: 100, nome: "Cliente Cem", telefone: "15 99158-5191", municipio: "Ibiúna", uf: "sp" } as T;
    return original<T>(c);
  };

  const r = await sync.sincronizarPedido(2127);
  assert.equal(r.atualizados, 1);
  assert.equal(todas().find((l) => l.categoria === "SANDUICHE")!.metrosTelha, 81);
  assert.equal(repo.listarPedidos()[0].uf, "SP");
  await assert.rejects(() => sync.sincronizarPedido(999), /não encontrado/);
});

test("API: botão 'sincronizar este pedido' devolve 503 sem Nomus e 404 para pedido inexistente", async () => {
  const { app, todas } = await montarApi();
  const id = todas()[0].pedidoId;
  assert.equal((await app.inject({ method: "POST", url: `/api/programacao/pedidos/${id}/sincronizar` })).statusCode, 503);
  assert.equal((await app.inject({ method: "POST", url: "/api/programacao/pedidos/9999/sincronizar" })).statusCode, 503);
});

test("cidades que o nome da rota cita já nascem com a rota (ex.: Sorocaba → rota 1); as demais ficam 'sem rota'", async () => {
  const { rodar, todas, repo } = montar();
  pessoas.set(300, { nomusId: 300, nome: "Cliente Trezentos", telefone: "1", buscadoEm: "x", municipio: "Sorocaba", uf: "SP" });
  try {
    await rodar([pedido(3100, "03100", 300, [item(8001, 9, "1 X 2,00", "2")]), pedidoPadrao()]);
  } finally {
    pessoas.delete(300);
  }
  const l = todas();
  assert.equal(l.find((x) => x.numeroPedido === 3100)!.rota?.id, 1);
  assert.equal(l.find((x) => x.numeroPedido === 2085)!.rota, null, "Ibiúna não está no mapa");
  assert.ok(repo.contarCidadesRota() >= 15);
});
