import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "../src/app";
import { openDatabase } from "../src/db";
import { importarDeArquivo } from "../src/programacao/importacao";
import { importarPlanilha, lerDataDaPlanilha, relatorioCsv } from "../src/programacao/planilha";
import { ProgramacaoRepository } from "../src/programacao/repo";
import { ProgramacaoService } from "../src/programacao/service";
import { ProgramacaoSync } from "../src/programacao/sync";
import { lerXlsx, serialParaIso } from "../src/programacao/xlsx";
import { PcpRepository } from "../src/repository";
import { SyncService, type NomusLeitor, type NomusPedidoLista } from "../src/sync";
import { montarXlsx, type Folha } from "./xlsx-teste";

// ------------------------------------------------------------------ leitor de .xlsx e datas

test("o leitor de .xlsx lê abas, textos (sharedStrings), números e ignora células de erro (#REF!)", () => {
  const buf = montarXlsx({
    Base: { 3: { A: "PEDIDO", H: "SITUAÇÃO" }, 4: { A: 648, H: "Aguardando Liberação", BZ: { erro: "#REF!" } } },
    Rotas: { 1: { A: "Cidade", B: "Rota" }, 2: { A: "Sorocaba-SP", B: "ROTA 1" } },
  });
  const p = lerXlsx(buf);
  assert.deepEqual(p.abas, ["Base", "Rotas"]);
  const base = p.aba("base")!; // nome sem diferenciar maiúscula
  assert.equal(base.get(4)!.get("A"), 648);
  assert.equal(base.get(4)!.get("H"), "Aguardando Liberação");
  assert.equal(base.get(4)!.has("BZ"), false, "célula com erro de fórmula não vira valor");
  assert.equal(p.aba("Inexistente"), null);
  assert.throws(() => lerXlsx(Buffer.from("isto não é um zip")), /inválido/i);
});

test("datas da planilha: serial do Excel, dd/mm/aaaa; texto livre e ano < 2025 são rejeitados", () => {
  assert.equal(serialParaIso(46303), "2026-10-08");
  assert.deepEqual(lerDataDaPlanilha(46303), { iso: "2026-10-08", erro: null });
  assert.equal(lerDataDaPlanilha("08/10/2026").iso, "2026-10-08");
  assert.equal(lerDataDaPlanilha("8/1/26").iso, "2026-01-08");
  assert.equal(lerDataDaPlanilha(null).erro, null);
  for (const ruim of ["xxx", "22/01 e 23/01", "02/004", "30/02/2026"]) {
    const r = lerDataDaPlanilha(ruim);
    assert.equal(r.iso, null, ruim);
    assert.ok(r.erro, ruim);
  }
  assert.match(lerDataDaPlanilha("10/10/2024").erro ?? "", /2025/);
});

// ------------------------------------------------------------------ importação

const item = (id: number, produto: number, info: string, quantidade: string) => ({
  id, item: String(id % 100).padStart(5, "0"), idProduto: produto, informacoesAdicionaisProduto: info, quantidade, valorUnitario: "10", status: 2, dataEntrega: "20/10/2026 00:00:00",
});
const pedido = (id: number, codigo: string, itens: ReturnType<typeof item>[]): NomusPedidoLista => ({
  id, codigoPedido: `PD ${codigo}`, idPessoaCliente: 100, dataEmissao: "05/10/2026 00:00:00", valorTotal: "1.000,00", itensPedido: itens,
});

class NomusFalso implements NomusLeitor {
  async get<T>(caminho: string): Promise<T> {
    if (caminho.startsWith("/produtos?query=")) {
      const ids = [...caminho.matchAll(/id=(\d+)/g)].map((m) => Number(m[1]));
      const desc: Record<number, string> = { 3: "TELHA SANDUICHE TR25", 9: "TELHA SIMPLES TR25", 50: "CUMIEIRA TR25 SIMPLES" };
      return ids.map((id) => ({ id, codigo: `P${id}`, descricao: desc[id] })) as T;
    }
    if (caminho.startsWith("/ordens?query=")) return [] as T;
    throw new Error(caminho);
  }
}

async function montar() {
  const db = openDatabase(":memory:");
  const repo = new ProgramacaoRepository(db);
  const relogio = { atual: new Date("2026-10-08T12:00:00Z") };
  const sync = new ProgramacaoSync(new NomusFalso(), repo, { statusLiberado: 2, agora: () => relogio.atual, sleep: async () => {} });
  const carregar = async (ids: number[]) =>
    new Map(ids.map((i) => [i, { nomusId: i, nome: "Cliente Cem", telefone: "1", buscadoEm: "x", municipio: "Ibiúna", uf: "SP" }]));
  await sync.processarPagina(
    [
      pedido(1001, "00648", [item(1, 3, "5 X 4,16", "20,8"), item(2, 9, "2 X 3,00", "6")]), // dois itens: sanduíche + simples
      pedido(1002, "01822", [item(3, 3, "3 X 6,00", "18")]),
    ],
    carregar
  );
  return { db, repo, relogio, servico: new ProgramacaoService(repo, () => relogio.atual) };
}

type L = Record<string, string | number>;
const CAB: L = { A: "PEDIDO", F: "Programação de Produção", H: "SITUAÇÃO", I: "PRODUTO", BT: "Data de Liberação Produção", BU: "Data Produzida", BV: "Data de Entrega (Gferr)", BX: "Prazo de negociação", BY: "Observação" };
const abaBase = (linhas: L[]): Folha => {
  const f: Folha = { 1: { A: "título" }, 3: CAB };
  linhas.forEach((l, i) => (f[4 + i] = l));
  return f;
};
const baseDe = (linhas: L[], rotas?: Folha) => {
  const p = lerXlsx(montarXlsx({ Base: abaBase(linhas), ...(rotas ? { Rotas: rotas } : {}) }));
  return { base: p.aba("Base")!, rotas: p.aba("Rotas") };
};
const contar = (db: ReturnType<typeof openDatabase>, tabela: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get() as { n: number }).n;

test("dry-run relata tudo e NÃO grava nada; a importação real grava situação, datas, prazo negociado, observação e rota", async () => {
  const { repo, db } = await montar();
  const { base } = baseDe([
    { A: 648, F: 46310, H: "Programado", I: "Sanduiche Amadeirado", BT: 46304, BX: "30/11/2026", BY: "Cliente retira", G: "ROTA 3" },
    { A: 648, H: "Programar", I: "Telha Simples" },
  ]);
  const antesEventos = contar(db, "pcp_evento");

  const seco = importarPlanilha({ repo, base, gravar: false });
  assert.equal(seco.gravou, false);
  assert.equal(seco.resumo.importada, 1);
  assert.equal(seco.resumo.sem_mudanca, 1);
  assert.equal(repo.buscarItemPorNomus(1)!.situacao, "PROGRAMAR", "dry-run não grava");
  assert.equal(repo.buscarPedidoPorNomus(1001)!.observacao, "");
  assert.equal(contar(db, "pcp_evento"), antesEventos);

  const real = importarPlanilha({ repo, base, gravar: true });
  assert.equal(real.resumo.importada, 1);
  const sand = repo.buscarItemPorNomus(1)!;
  assert.equal(sand.situacao, "PROGRAMADO");
  assert.equal(sand.dataProgramacao, "2026-10-15");
  assert.equal(sand.dataLiberacaoProducao, "2026-10-09");
  const ped = repo.buscarPedidoPorNomus(1001)!;
  assert.equal(ped.dataEntregaNegociada, "2026-11-30");
  assert.equal(ped.observacao, "Cliente retira");
  assert.equal(ped.rotaId, 3);
  assert.equal(ped.rotaManual, true);
  assert.equal(ped.dataEntregaOriginal, "2026-10-20", "o prazo original não é tocado");
  assert.ok(repo.eventosDoPedido(ped.id).some((e) => e.origem === "importacao" && e.campo === "situacao_pcp"));
});

test("importar duas vezes é idempotente: a segunda não muda nada nem cria eventos", async () => {
  const { repo, db } = await montar();
  const { base } = baseDe([{ A: 648, H: "Programado", I: "Sanduiche", F: 46310, BY: "obs" }, { A: 648, H: "Cola", I: "Simples" }]);
  importarPlanilha({ repo, base, gravar: true });
  const eventos = contar(db, "pcp_evento");
  const atualizado = (db.prepare("SELECT MAX(updated_at) AS m FROM pcp_pedido_item").get() as { m: string }).m;

  const deNovo = importarPlanilha({ repo, base, gravar: true });
  assert.equal(deNovo.resumo.sem_mudanca, 2);
  assert.equal(deNovo.resumo.importada, 0);
  assert.equal(contar(db, "pcp_evento"), eventos);
  assert.equal((db.prepare("SELECT MAX(updated_at) AS m FROM pcp_pedido_item").get() as { m: string }).m, atualizado);
});

test("datas inválidas viram nulas e entram no relatório de rejeição, sem travar a linha", async () => {
  const { repo } = await montar();
  const { base } = baseDe([{ A: 1822, H: "Programado", I: "Sanduiche", F: "xxx", BT: "22/01 e 23/01", BU: "10/10/2024" }]);
  const r = importarPlanilha({ repo, base, gravar: true });
  assert.equal(r.resumo.ajustada, 1);
  const detalhes = r.relatorio[0].detalhes.join(" | ");
  assert.match(detalhes, /programação rejeitada/);
  assert.match(detalhes, /liberação rejeitada/);
  assert.match(detalhes, /produzida rejeitada/);
  const it = repo.buscarItemPorNomus(3)!;
  assert.equal(it.situacao, "PROGRAMADO", "o que é válido na linha foi importado");
  assert.deepEqual([it.dataProgramacao, it.dataLiberacaoProducao, it.dataProduzida], [null, null, null]);
});

test("cronologia quebrada e situação sem a data exigida são rejeitadas (o sistema recusaria depois)", async () => {
  const { repo } = await montar();
  const { base } = baseDe([{ A: 1822, H: "Produzido", I: "Sanduiche", BT: "10/10/2026", BU: "05/10/2026" }]); // produzida antes de liberar
  const r = importarPlanilha({ repo, base, gravar: true });
  const d = r.relatorio[0].detalhes.join(" | ");
  assert.match(d, /anterior à liberação/);
  assert.match(d, /situação "Produzido" rejeitada/);
  const it = repo.buscarItemPorNomus(3)!;
  assert.equal(it.situacao, "PROGRAMAR");
  assert.equal(it.dataProduzida, null);
  assert.equal(it.dataLiberacaoProducao, "2026-10-10");
});

test("situação desconhecida ('xxx') é relatada e a atual é mantida", async () => {
  const { repo } = await montar();
  const { base } = baseDe([{ A: 1822, H: "xxx", I: "Sanduiche" }]);
  const r = importarPlanilha({ repo, base, gravar: true });
  assert.equal(r.resumo.ajustada, 1);
  assert.match(r.relatorio[0].detalhes.join(), /desconhecida/);
  assert.equal(repo.buscarItemPorNomus(3)!.situacao, "PROGRAMAR");
});

test("pedido de várias linhas casa por categoria e na ordem; sobra e pedido desconhecido vão para revisão", async () => {
  const { repo } = await montar();
  const { base } = baseDe([
    { A: 648, H: "Programado", I: "Telha Simples" }, // vem ANTES na planilha, mas é o item 2 na Nomus
    { A: 648, H: "Cola", I: "Sanduiche Amadeirado" },
    { A: 648, H: "Pintura", I: "Forro PVC" }, // sobra: o pedido só tem 2 itens
    { A: 99999, H: "Programado", I: "Sanduiche" }, // pedido que não veio da Nomus
    { A: 1000 }, // reservada, vazia
  ]);
  const r = importarPlanilha({ repo, base, gravar: true });
  assert.equal(repo.buscarItemPorNomus(2)!.situacao, "PROGRAMADO", "simples casou com o simples");
  assert.equal(repo.buscarItemPorNomus(1)!.situacao, "COLA", "sanduíche casou com o sanduíche");
  assert.equal(r.resumo.rejeitada, 2);
  assert.equal(r.resumo.ignorada, 1);
  assert.match(r.relatorio.find((l) => l.pedido === 99999)!.detalhes[0], /não está na Programação/);
  assert.match(r.relatorio.find((l) => l.produto === "Forro PVC")!.detalhes[0], /sobrou esta/);
});

test("o que foi editado no sistema depois da carga não é sobrescrito (a menos que --forcar)", async () => {
  const { repo, servico } = await montar();
  servico.editarItem(repo.buscarItemPorNomus(3)!.id, { situacao: "VERIFICAR" }, "Ana");
  const { base } = baseDe([{ A: 1822, H: "Programado", I: "Sanduiche" }]);

  const r = importarPlanilha({ repo, base, gravar: true });
  assert.equal(r.resumo.rejeitada, 1);
  assert.match(r.relatorio[0].detalhes[0], /editado no sistema por Ana/);
  assert.equal(repo.buscarItemPorNomus(3)!.situacao, "VERIFICAR");

  importarPlanilha({ repo, base, gravar: true, forcar: true });
  assert.equal(repo.buscarItemPorNomus(3)!.situacao, "PROGRAMADO");
});

test("aba Rotas: cabeçalhos 'Cidade' repetidos são ignorados, o mapa é gravado e aplicado aos pedidos existentes", async () => {
  const { repo } = await montar();
  const rotas: Folha = {
    1: { A: "Cidade", B: "Rota" },
    2: { A: "Ibiúna-SP", B: "ROTA 5" },
    3: { A: "Cidade", B: "Rota" },
    4: { A: "Sorocaba-SP", B: "ROTA 9" }, // diverge do que já está mapeado (1)
    5: { A: "Cotia-SP", B: "ROTA 99" }, // rota inexistente
  };
  const { base, rotas: abaRotas } = baseDe([], rotas);
  const r = importarPlanilha({ repo, base, rotas: abaRotas, gravar: true });
  assert.equal(r.resumo.rotasNovas, 1);
  assert.equal(r.resumo.rotasDivergentes, 1);
  assert.equal(r.rotas.filter((l) => l.status === "rejeitada").length, 1);
  assert.equal(repo.rotaDaCidade("ibiuna-sp"), 5);
  assert.equal(repo.rotaDaCidade("sorocaba-sp"), 1, "o mapa existente não é sobrescrito");
  assert.equal(repo.buscarPedidoPorNomus(1001)!.rotaId, 5, "pedidos da cidade já recebem a rota");
});

test("relatório CSV: uma linha por linha da planilha, com motivo e número da linha", async () => {
  const { repo } = await montar();
  const { base } = baseDe([{ A: 99999, H: "Programado", I: "Sanduiche" }]);
  const csv = relatorioCsv(importarPlanilha({ repo, base, gravar: false }));
  assert.ok(csv.startsWith("﻿aba;linha_planilha;pedido;"));
  assert.match(csv, /Base;4;99999;Sanduiche;rejeitada;;pedido não está na Programação/);
});

// ------------------------------------------------------------------ upload pela tela / API

test("API: upload do .xlsx simula, depois grava com backup; perfil de consulta não importa", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pcp-imp-"));
  try {
    const { repo, db, relogio, servico } = await montar();
    const pcpRepo = new PcpRepository(db);
    const sync = new SyncService(new NomusFalso(), pcpRepo, { statusLiberado: 2 });
    const app = await buildApp({
      repo: pcpRepo, sync, programacao: servico, accessToken: "codigo-completo", accessTokenConsulta: "codigo-consulta", agora: () => relogio.atual,
      importarPlanilhaProgramacao: (arquivo, o) => importarDeArquivo(arquivo, { db, repo, gravar: o.gravar, forcar: o.forcar, pastaBackup: dir, agora: () => relogio.atual }),
    });
    const xlsx = montarXlsx({ Base: abaBase([{ A: 1822, H: "Programado", I: "Sanduiche", F: 46310 }]) });
    const headers = { "x-pcp-token": "codigo-completo", "content-type": "application/octet-stream" };

    const seco = await app.inject({ method: "POST", url: "/api/programacao/importar", headers, payload: xlsx });
    assert.equal(seco.statusCode, 200);
    assert.equal(seco.json().gravou, false);
    assert.equal(seco.json().backup, null);
    assert.equal(repo.buscarItemPorNomus(3)!.situacao, "PROGRAMAR");
    assert.equal(readdirSync(dir).length, 0, "simulação não gera backup");

    const real = await app.inject({ method: "POST", url: "/api/programacao/importar?gravar=1", headers, payload: xlsx });
    assert.equal(real.statusCode, 200);
    assert.equal(real.json().gravou, true);
    assert.match(real.json().backup, /backup-antes-de-importar-planilha-\d{14}\.sqlite$/);
    assert.equal(readdirSync(dir).length, 1, "backup criado antes de gravar");
    assert.equal(repo.buscarItemPorNomus(3)!.situacao, "PROGRAMADO");
    assert.match(real.json().csv, /importada/);

    const consulta = await app.inject({ method: "POST", url: "/api/programacao/importar?gravar=1", headers: { ...headers, "x-pcp-token": "codigo-consulta" }, payload: xlsx });
    assert.equal(consulta.statusCode, 403);
    const ruim = await app.inject({ method: "POST", url: "/api/programacao/importar", headers, payload: Buffer.from("não é planilha") });
    assert.equal(ruim.statusCode, 400);
    assert.match(ruim.json().erro, /inválido/i);
    const semAba = await app.inject({ method: "POST", url: "/api/programacao/importar", headers, payload: montarXlsx({ Outra: { 1: { A: "x" } } }) });
    assert.match(semAba.json().erro, /aba "Base"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
