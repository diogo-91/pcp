import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app";
import { openDatabase } from "../src/db";
import {
  calcularBobina, diasUteis, ExtrasService, nivelDeOcupacao, pecasDeForroPvc, quantidadeAComprar, ultimosMesesFechados,
} from "../src/programacao/extras";
import { ProgramacaoRepository } from "../src/programacao/repo";
import { ErroDeValidacao, ProgramacaoService } from "../src/programacao/service";
import { ProgramacaoSync } from "../src/programacao/sync";
import { PcpRepository } from "../src/repository";
import { SyncService, type NomusLeitor, type NomusPedidoLista } from "../src/sync";

// ------------------------------------------------------------------ funções puras

test("dias de trabalho: segunda a sexta, menos feriados", () => {
  // 05/10/2026 é segunda; 12/10 é segunda
  assert.deepEqual(diasUteis("2026-10-05", "2026-10-12", new Set()), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"]);
  assert.deepEqual(diasUteis("2026-10-05", "2026-10-09", new Set(["2026-10-07"])), ["2026-10-05", "2026-10-06", "2026-10-08", "2026-10-09"]);
});

test("barra de ocupação: verde até 80%, amarela até 100%, vermelha acima", () => {
  assert.deepEqual([0, 80, 81, 100, 101].map(nivelDeOcupacao), ["verde", "verde", "amarelo", "amarelo", "vermelho"]);
});

test("parafusos: demanda 100, média 50, estoque 300 → comprar 0; estoque 150 → comprar 50", () => {
  assert.equal(quantidadeAComprar(100, 50, 300), 0);
  assert.equal(quantidadeAComprar(100, 50, 150), 50);
  assert.equal(quantidadeAComprar(0, 0, 10), 0, "nunca negativo");
});

test("forro PVC: peças = metros ÷ (comprimento da peça × 0,20), arredondado para cima", () => {
  assert.equal(pecasDeForroPvc(24, 6), 20); // 24 / 1,2
  assert.equal(pecasDeForroPvc(25, 6), 21);
  assert.equal(pecasDeForroPvc(24, null), null);
});

test("calculadora de bobina nos dois sentidos (0,5 mm × 1,2 m × 7850 = 4,71 kg/m)", () => {
  const a = calcularBobina({ espessuraMm: 0.5, larguraM: 1.2, pesoKg: 471 });
  assert.equal(a.kgPorMetro, 4.71);
  assert.equal(a.comprimentoM, 100);
  const b = calcularBobina({ espessuraMm: 0.5, larguraM: 1.2, comprimentoM: 100 });
  assert.equal(b.pesoKg, 471);
  assert.throws(() => calcularBobina({ espessuraMm: 0, larguraM: 1.2, pesoKg: 1 }), ErroDeValidacao);
  assert.throws(() => calcularBobina({ espessuraMm: 0.5, larguraM: 1.2 }), /peso.*comprimento/i);
});

test("últimos meses fechados atravessam a virada do ano", () => {
  assert.deepEqual(ultimosMesesFechados("2026-02-10", 3), ["2025-11", "2025-12", "2026-01"]);
});

// ------------------------------------------------------------------ fixture

const item = (id: number, produto: number, info: string, quantidade: string, dataEntrega = "20/10/2026 00:00:00") => ({
  id, item: String(id % 100).padStart(5, "0"), idProduto: produto, informacoesAdicionaisProduto: info, quantidade, valorUnitario: "10", status: 2, dataEntrega,
});
const pedido = (id: number, codigo: string, itens: ReturnType<typeof item>[], valorTotal = "1.000,00", emissao = "05/10/2026 00:00:00"): NomusPedidoLista => ({
  id, codigoPedido: `PD ${codigo}`, idPessoaCliente: 100, dataEmissao: emissao, valorTotal, itensPedido: itens,
});

class NomusFalso implements NomusLeitor {
  async get<T>(caminho: string): Promise<T> {
    if (caminho.startsWith("/produtos?query=")) {
      const ids = [...caminho.matchAll(/id=(\d+)/g)].map((m) => Number(m[1]));
      const desc: Record<number, string> = { 3: "TELHA SANDUICHE TR25 - UMA FACE PINTADA", 9: "TELHA SIMPLES TR25 - SEM PINTURA" };
      return ids.map((id) => ({ id, codigo: `P${id}`, descricao: desc[id] })) as T;
    }
    if (caminho.startsWith("/ordens?query=")) return [] as T;
    throw new Error(caminho);
  }
}

async function montar(pedidos?: NomusPedidoLista[]) {
  const db = openDatabase(":memory:");
  const repo = new ProgramacaoRepository(db);
  const relogio = { atual: new Date("2026-10-08T12:00:00Z") }; // quinta-feira
  const agora = () => relogio.atual;
  const sync = new ProgramacaoSync(new NomusFalso(), repo, { statusLiberado: 2, agora, sleep: async () => {} });
  const carregar = async (ids: number[]) => new Map(ids.map((i) => [i, { nomusId: i, nome: "Cliente Cem", telefone: "+55 15 991585191", buscadoEm: "x", municipio: "Ibiúna", uf: "SP" }]));
  await sync.processarPagina(
    pedidos ?? [
      pedido(1001, "00648", [item(1, 3, "10 X 5,00", "50"), item(2, 9, "4 X 5,00", "20")], "37.698,00"), // 50 m + 20 m
      pedido(1002, "01822", [item(3, 3, "20 X 5,00", "100")], "5.000,00"), // 100 m
    ],
    carregar
  );
  const servico = new ProgramacaoService(repo, agora);
  const extras = new ExtrasService(db, servico, repo, agora);
  const id = (nomusItemId: number) => repo.buscarItemPorNomus(nomusItemId)!.id;
  return { db, repo, servico, extras, relogio, id, agora };
}

// ------------------------------------------------------------------ agenda

test("agenda: soma os metros do dia, compara com a capacidade e mostra a carga livre", async () => {
  const { servico, extras, repo, id } = await montar();
  repo.definirParametro("capacidade_m_dia", 100);
  servico.editarItem(id(1), { dataProgramacao: "2026-10-12", situacao: "PROGRAMADO" }, "Ana"); // 50 m
  servico.editarItem(id(2), { dataProgramacao: "2026-10-12", situacao: "PROGRAMADO" }, "Ana"); // 20 m
  servico.editarItem(id(3), { dataProgramacao: "2026-10-13", situacao: "PROGRAMADO" }, "Ana"); // 100 m

  const a = extras.agenda("2026-10-12", "2026-10-16", "completo");
  assert.deepEqual(a.dias.map((d) => d.data), ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]);
  const [seg, ter, qua] = a.dias;
  assert.equal(seg.metros, 70);
  assert.equal(seg.ocupacaoPct, 70);
  assert.equal(seg.nivel, "verde");
  assert.equal(seg.livre, 30);
  assert.equal(seg.itens.length, 2);
  assert.equal(seg.valor, 37698, "valor do pedido somado uma vez no dia");
  assert.equal(seg.eps, 50, "só o sanduíche usa EPS");
  assert.equal(ter.nivel, "amarelo");
  assert.equal(qua.metros, 0);
});

test("agenda: mover um item de dia atualiza a data e a ocupação dos dois dias", async () => {
  const { servico, extras, repo, id } = await montar();
  repo.definirParametro("capacidade_m_dia", 100);
  servico.editarItem(id(3), { dataProgramacao: "2026-10-12", situacao: "PROGRAMADO" }, "Ana");
  assert.equal(extras.agenda("2026-10-12", "2026-10-13", "completo").dias[0].ocupacaoPct, 100);

  servico.editarItem(id(3), { dataProgramacao: "2026-10-13" }, "Ana"); // o que o arrastar faz
  const a = extras.agenda("2026-10-12", "2026-10-13", "completo");
  assert.equal(a.dias[0].metros, 0);
  assert.equal(a.dias[1].metros, 100);
  assert.equal(repo.buscarItem(id(3))!.dataProgramacao, "2026-10-13");
});

test("agenda: feriado não é dia de trabalho; sábado só aparece se tiver item; sobra vira 'a programar' e atraso vira alerta", async () => {
  const { servico, extras, id } = await montar();
  extras.adicionarFeriado("2026-10-14", "Feriado de teste");
  servico.editarItem(id(1), { dataProgramacao: "2026-10-17", situacao: "PROGRAMADO" }, "Ana"); // sábado
  servico.editarItem(id(2), { dataProgramacao: "2026-10-06", situacao: "PROGRAMADO" }, "Ana"); // já passou

  const a = extras.agenda("2026-10-12", "2026-10-18", "completo");
  assert.ok(!a.dias.some((d) => d.data === "2026-10-14"), "feriado fora da agenda");
  const sab = a.dias.find((d) => d.data === "2026-10-17")!;
  assert.equal(sab.util, false);
  assert.equal(sab.itens.length, 1);
  assert.deepEqual(a.aProgramar.map((i) => i.id), [id(3)], "só o item liberado sem data");
  assert.deepEqual(a.vencidas.map((i) => i.id), [id(2)]);
  assert.throws(() => extras.agenda("2026-10-20", "2026-10-12", "completo"), ErroDeValidacao);
  assert.throws(() => extras.adicionarFeriado("xx", "y"), ErroDeValidacao);
});

test("agenda não conta cancelados", async () => {
  const { servico, extras, id } = await montar();
  servico.editarItem(id(3), { dataProgramacao: "2026-10-12", situacao: "PROGRAMADO" }, "Ana");
  servico.editarItem(id(3), { situacao: "CANCELADO" }, "Ana");
  assert.equal(extras.agenda("2026-10-12", "2026-10-12", "completo").dias[0].metros, 0);
});

// ------------------------------------------------------------------ painel

test("painel: em aberto por situação (metros, pintura, EPS, bobina, valor) e por rota", async () => {
  const { servico, extras, id } = await montar();
  servico.editarItem(id(1), { situacao: "PROGRAMADO", dataProgramacao: "2026-10-12" }, "Ana");
  servico.editarPedido(servico.todasAsLinhas("completo")[0].pedidoId, { rotaId: 1 }, "Ana");

  const p = extras.painel(undefined, undefined, "completo");
  const prog = p.porSituacao.find((s) => s.situacao === "PROGRAMADO")!;
  assert.equal(prog.itens, 1);
  assert.equal(prog.metros, 50);
  assert.equal(prog.metrosPintados, 50, "sanduíche com 1 face pintada");
  assert.equal(prog.eps, 50);
  assert.equal(prog.bobinaKg, 360, "100 m de chapa × 3,6");
  const programar = p.porSituacao.find((s) => s.situacao === "PROGRAMAR")!;
  assert.equal(programar.itens, 2);
  assert.equal(p.totalEmAberto.itens, 3);

  const rota1 = p.porRota.find((r) => r.rota.startsWith("Sorocaba"))!;
  assert.equal(rota1.pedidos.length, 1);
  assert.equal(rota1.pedidos[0].itens, 2);
  assert.equal(rota1.pedidos[0].situacao, "PROGRAMAR", "situação do pedido = a do item menos avançado");
  assert.ok(p.porRota.some((r) => r.rota === "Sem rota"));
});

test("painel: produção x vendas por mês, média por dia útil e % no prazo; cancelados ficam fora", async () => {
  const { servico, extras, id, relogio } = await montar([
    pedido(1001, "00648", [item(1, 3, "10 X 5,00", "50"), item(2, 9, "4 X 5,00", "20")], "1.000,00", "10/09/2026 00:00:00"),
    pedido(1002, "01822", [item(3, 3, "20 X 5,00", "100")], "1.000,00", "05/10/2026 00:00:00"),
  ]);
  // item 1 produzido e entregue no prazo em setembro; item 2 cancelado
  servico.editarItem(id(1), { situacao: "ENTREGUE", dataLiberacaoProducao: "2026-09-12", dataProduzida: "2026-09-15", dataEntregaRealizada: "2026-10-01" }, "Ana");
  servico.editarItem(id(2), { situacao: "CANCELADO" }, "Ana");
  relogio.atual = new Date("2026-10-08T12:00:00Z");

  const p = extras.painel("2026-09-01", "2026-10-31", "completo");
  const set = p.mensal.find((m) => m.mes === "2026-09")!;
  assert.equal(set.produzido.metros, 50);
  assert.equal(set.produzido.metrosPintados, 50);
  assert.equal(set.produzido.mediaDiaMetros, Math.round((50 / 22) * 100) / 100, "setembro/2026 tem 22 dias úteis");
  assert.equal(set.vendido.metros, 70 - 20, "vendido em setembro: só o pedido 1001, sem o item cancelado");
  const out = p.mensal.find((m) => m.mes === "2026-10")!;
  assert.equal(out.vendido.metros, 100);
  assert.equal(out.entregues, 1);
  assert.equal(out.pontualidadePct, 100, "entregue em 01/10, prazo 20/10");
});

// ------------------------------------------------------------------ compras

test("compra de forro Anfer: valor = metros × preço do parâmetro; vincula ao pedido pelo número", async () => {
  const { extras, repo } = await montar();
  const idCompra = extras.criarCompra({ tipo: "FORRO_ANFER", numeroPedido: 648, medidas: [{ qtd: 14, comprimento_m: 5.9 }], material: "amadeirado escuro", tr: "TR25" }, "Ana");
  let c = extras.compras({}, "completo").compras.find((x) => x.id === idCompra)!;
  assert.equal(c.totalMetros, 82.6);
  assert.equal(c.valor, 4130, "82,6 m × R$ 50");
  assert.equal(c.valorManual, false);
  assert.equal(c.pedido!.numero, 648);
  assert.equal(c.pedido!.telefone, "(15) 99158-5191");
  assert.equal(c.status, "A_COTAR");

  repo.definirParametro("preco_forro_anfer_m", 60);
  c = extras.compras({}, "completo").compras.find((x) => x.id === idCompra)!;
  assert.equal(c.valor, 4956, "acompanha o parâmetro");

  extras.editarCompra(idCompra, { valor: 4000 }, "Ana");
  c = extras.compras({}, "completo").compras.find((x) => x.id === idCompra)!;
  assert.deepEqual([c.valor, c.valorManual], [4000, true]);
  extras.editarCompra(idCompra, { valor: null }, "Ana");
  assert.equal(extras.compras({}, "completo").compras[0].valorManual, false, "volta ao valor calculado");
});

test("compra: marcar como comprado registra quem e quando; telefone oculto no perfil de consulta", async () => {
  const { extras } = await montar();
  const id = extras.criarCompra({ tipo: "TRANSLUCIDA", numeroPedido: 1822, totalMetros: 12, material: "leitosa" }, "Ana");
  extras.editarCompra(id, { status: "COMPRADO" }, "Bruno");
  const c = extras.compras({}, "completo").compras[0];
  assert.deepEqual([c.status, c.compradoPor, c.compradoEm], ["COMPRADO", "Bruno", "2026-10-08"]);
  assert.equal(extras.compras({}, "consulta").compras[0].pedido!.telefone, null);
});

test("compra de PVC mostra o número de peças", async () => {
  const { extras } = await montar();
  extras.criarCompra({ tipo: "FORRO_PVC", totalMetros: 24, comprimentoPecaM: 6 }, "Ana");
  assert.equal(extras.compras({}, "completo").compras[0].pecas, 20);
});

test("compra: validações e filtros", async () => {
  const { extras } = await montar();
  assert.throws(() => extras.criarCompra({ tipo: "INVENTADO" }, "Ana"), /Tipo/);
  assert.throws(() => extras.criarCompra({ tipo: "FORRO_PVC", numeroPedido: 99999 }, "Ana"), /não está na Programação/);
  assert.throws(() => extras.criarCompra({ tipo: "FORRO_PVC", status: "XYZ" }, "Ana"), /Status/);
  assert.throws(() => extras.criarCompra({ tipo: "FORRO_PVC", medidas: [{ qtd: 0, comprimento_m: 1 }] }, "Ana"), /Medidas/);
  assert.throws(() => extras.criarCompra({ tipo: "FORRO_PVC", fornecedorId: 9999 }, "Ana"), /Fornecedor/);
  assert.throws(() => extras.editarCompra(9999, { observacao: "x" }, "Ana"), /não encontrada/);

  extras.criarCompra({ tipo: "FORRO_PVC", totalMetros: 10, material: "branco" }, "Ana");
  extras.criarCompra({ tipo: "TELHA_PIR", totalMetros: 5 }, "Ana");
  assert.equal(extras.compras({ tipo: "TELHA_PIR" }, "completo").compras.length, 1);
  assert.equal(extras.compras({ q: "branco" }, "completo").compras.length, 1);
  assert.equal(extras.compras({ status: "COMPRADO" }, "completo").compras.length, 0);
});

test("fornecedor: total comprado, pago e saldo a pagar (só compras firmes contam)", async () => {
  const { extras } = await montar();
  const anfer = extras.fornecedores().find((f) => f.nome === "Anfer")!;
  const a = extras.criarCompra({ tipo: "FORRO_ANFER", fornecedorId: anfer.id, totalMetros: 100, status: "COMPRADO" }, "Ana"); // R$ 5.000
  extras.criarCompra({ tipo: "FORRO_ANFER", fornecedorId: anfer.id, totalMetros: 40, status: "COTADO" }, "Ana"); // não conta
  extras.criarCompra({ tipo: "FORRO_ANFER", fornecedorId: anfer.id, totalMetros: 10, status: "CANCELADO" }, "Ana"); // não conta
  extras.registrarPagamento({ fornecedorId: anfer.id, valor: 1500, data: "2026-10-05" }, "Ana");
  extras.registrarPagamento({ fornecedorId: anfer.id, valor: 500 }, "Ana");

  const f = extras.fornecedores().find((x) => x.nome === "Anfer")!;
  assert.deepEqual([f.totalComprado, f.totalPago, f.saldoAPagar], [5000, 2000, 3000]);
  assert.equal(extras.pagamentos(anfer.id).length, 2);
  assert.throws(() => extras.registrarPagamento({ fornecedorId: anfer.id, valor: -5 }, "Ana"), ErroDeValidacao);
  assert.throws(() => extras.registrarPagamento({ fornecedorId: 9999, valor: 5 }, "Ana"), /não encontrado/);
  assert.ok(a > 0);
  assert.throws(() => extras.salvarFornecedor({ nome: "Anfer" }), /Já existe/);
});

// ------------------------------------------------------------------ parafusos

test("parafusos: consumo médio dos 6 meses fechados, demanda dos pedidos em aberto, estoque e quantidade a comprar", async () => {
  const { servico, extras, id } = await montar();
  // item 1: produzido em setembro com 600 parafusos (média = 600/6 = 100/mês); item 3: em aberto com 100 de demanda
  servico.editarItem(id(1), { situacao: "PRODUZIDO", dataProduzida: "2026-09-10" }, "Ana");
  servico.definirConsumoManual(id(1), "parafuso_1", 600, null, "Ana");
  servico.definirConsumoManual(id(3), "parafuso_1", 100, null, "Ana");
  servico.definirConsumoManual(id(3), "parafuso_2", 40, null, "Ana");

  let p = extras.parafusos("completo");
  assert.equal(p.itens.length, 13);
  assert.equal(p.mesesBase.length, 6);
  const p1 = p.itens.find((x) => x.codigo === "parafuso_1")!;
  assert.deepEqual([p1.consumoMedioMes, p1.demanda, p1.estoque], [100, 100, 0]);
  assert.equal(p1.comprar, 300, "100 + 2×100 − 0");

  extras.definirEstoque("parafuso_1", 300, "2026-10-07");
  p = extras.parafusos("completo");
  assert.deepEqual([p.itens[0].estoque, p.itens[0].contadoEm, p.itens[0].comprar], [300, "2026-10-07", 0]);
  assert.equal(p.itens.find((x) => x.codigo === "parafuso_2")!.comprar, 40);
  assert.throws(() => extras.definirEstoque("bobina", 1), /desconhecido/);
  assert.throws(() => extras.definirEstoque("parafuso_1", -1), ErroDeValidacao);
});

// ------------------------------------------------------------------ API

test("API: agenda, painel, calculadora, compras e permissões do perfil de consulta", async () => {
  const { db, servico, extras, id, agora } = await montar();
  const app = await buildApp({
    repo: new PcpRepository(db), sync: new SyncService(new NomusFalso(), new PcpRepository(db), { statusLiberado: 2 }), programacao: servico,
    extrasProgramacao: extras, accessToken: "codigo-completo", accessTokenConsulta: "codigo-consulta", agora,
  });
  const completo = { "x-pcp-token": "codigo-completo" };
  const consulta = { "x-pcp-token": "codigo-consulta" };

  servico.editarItem(id(3), { dataProgramacao: "2026-10-12", situacao: "PROGRAMADO" }, "Ana");
  const ag = (await app.inject({ method: "GET", url: "/api/programacao/agenda?de=2026-10-12&ate=2026-10-14", headers: consulta })).json();
  assert.equal(ag.dias[0].metros, 100);
  assert.equal((await app.inject({ method: "GET", url: "/api/programacao/painel", headers: consulta })).statusCode, 200);

  const calc = (await app.inject({ method: "GET", url: "/api/programacao/calculadora?espessura=0,5&largura=1,2&peso=471", headers: completo })).json();
  assert.equal(calc.comprimentoM, 100);
  assert.equal((await app.inject({ method: "GET", url: "/api/programacao/calculadora?espessura=0,5", headers: completo })).statusCode, 400);

  const nova = await app.inject({ method: "POST", url: "/api/programacao/compras", headers: completo, payload: { tipo: "FORRO_PVC", totalMetros: 24, comprimentoPecaM: 6 } });
  assert.equal(nova.statusCode, 200);
  const lista = (await app.inject({ method: "GET", url: "/api/programacao/compras?tipo=FORRO_PVC", headers: consulta })).json();
  assert.equal(lista.compras[0].pecas, 20);
  assert.equal((await app.inject({ method: "POST", url: "/api/programacao/compras", headers: consulta, payload: { tipo: "FORRO_PVC" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "PUT", url: "/api/programacao/feriados", headers: consulta, payload: { data: "2026-12-25", nome: "Natal" } })).statusCode, 403);

  const fer = await app.inject({ method: "PUT", url: "/api/programacao/feriados", headers: completo, payload: { data: "2026-12-25", nome: "Natal" } });
  assert.equal(fer.json()[0].nome, "Natal");
  assert.equal((await app.inject({ method: "DELETE", url: "/api/programacao/feriados/2026-12-25", headers: completo })).json().length, 0);

  const est = await app.inject({ method: "PUT", url: "/api/programacao/parafusos/parafuso_3/estoque", headers: completo, payload: { quantidade: 80 } });
  assert.equal(est.json().itens.find((x: { codigo: string }) => x.codigo === "parafuso_3").estoque, 80);

  const forn = (await app.inject({ method: "GET", url: "/api/programacao/fornecedores", headers: consulta })).json();
  assert.ok(forn.some((f: { nome: string }) => f.nome === "Anfer"));
  const pag = await app.inject({ method: "POST", url: `/api/programacao/fornecedores/${forn[0].id}/pagamentos`, headers: completo, payload: { valor: 100 } });
  assert.equal(pag.json().length, 1);
});
