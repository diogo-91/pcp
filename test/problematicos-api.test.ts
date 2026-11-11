import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app";
import { openDatabase } from "../src/db";
import { ProblematicosService } from "../src/problematicos";
import { PcpRepository } from "../src/repository";
import { SyncService, type NomusLeitor } from "../src/sync";

const AGORA = new Date("2026-11-11T14:00:00Z");

class NomusFalso implements NomusLeitor {
  chamadas: string[] = [];
  falhar = false;
  async get<T>(caminho: string): Promise<T> {
    this.chamadas.push(caminho);
    if (this.falhar) throw new Error("Nomus fora do ar");
    if (caminho === "/formasPagamento") return [{ id: 13, nome: "Pix" }, { id: 3, nome: "Cartão de Crédito" }] as T;
    if (caminho.startsWith("/pedidos?query=")) {
      const q = decodeURIComponent(caminho);
      if (q.includes("PD 01744")) {
        return [{ id: 1756, codigoPedido: "PD 01744", idPessoaCliente: 7994, idFormaPagamento: 13, valorTotal: "5.587,20", dataEntregaPadrao: "25/09/2026 00:00:00",
          itensPedido: [{ dataEntrega: "08/10/2026 00:00:00" }], parcelas: [{ idFormaPagamento: 13 }, { idFormaPagamento: 3 }, { idFormaPagamento: 13 }] }] as T;
      }
      if (q.includes("PD 00500")) return [{ id: 900, codigoPedido: "PD 00500", idPessoaCliente: 1, idFormaPagamento: 3, valorTotal: "100,00" }] as T;
      return [] as T;
    }
    if (caminho.startsWith("/pessoas/")) return { nome: caminho.endsWith("/7994") ? "Paulo de Lima Costa" : "Cliente Antigo" } as T;
    throw new Error(`inesperado: ${caminho}`);
  }
}

async function montar(accessToken = "", consulta = "") {
  const db = openDatabase(":memory:");
  const repo = new PcpRepository(db);
  repo.inserirNovos(
    [
      { nomusId: 1756, numero: 1744, codigoPedido: "PD 01744", clienteId: 1, clienteNome: "Paulo de Lima Costa", telefone: "1", prazoEntrega: "2026-10-08" },
      { nomusId: 1760, numero: 1750, codigoPedido: "PD 01750", clienteId: 2, clienteNome: "Maria Souza", telefone: "2", prazoEntrega: "2026-10-09" },
    ],
    AGORA.toISOString()
  );
  const nomus = new NomusFalso();
  const servico = new ProblematicosService(db, nomus, () => AGORA);
  const sync = new SyncService({ get: async () => [] as never }, repo, { statusLiberado: 2 });
  const app = await buildApp({ repo, sync, accessToken, accessTokenConsulta: consulta, problematicos: servico, agora: () => AGORA });
  return { app, nomus, servico };
}

test("busca de pedido por número (começa com) e por nome do cliente", async () => {
  const { app } = await montar();
  const porNumero = (await app.inject({ method: "GET", url: "/api/problematicos/pedidos?q=17" })).json() as Array<{ numero: number; cliente: string }>;
  assert.deepEqual(porNumero.map((p) => p.numero).sort(), [1744, 1750]);
  const porNome = (await app.inject({ method: "GET", url: "/api/problematicos/pedidos?q=maria" })).json() as Array<{ numero: number }>;
  assert.deepEqual(porNome.map((p) => p.numero), [1750]);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/problematicos/pedidos?q=" })).json(), []);
});

test("número exato que o PCP não tem (pedido antigo) é achado na Nomus", async () => {
  const { app } = await montar();
  const r = (await app.inject({ method: "GET", url: "/api/problematicos/pedidos?q=500" })).json() as Array<{ numero: number; origem: string; cliente: string }>;
  assert.equal(r[0].numero, 500);
  assert.equal(r[0].origem, "nomus");
  assert.equal(r[0].cliente, "Cliente Antigo");
});

test("detalhe do pedido traz valor e forma(s) de pagamento do pedido de venda", async () => {
  const { app } = await montar();
  const d = (await app.inject({ method: "GET", url: "/api/problematicos/pedidos/1744" })).json() as Record<string, unknown>;
  assert.equal(d.valor, 5587.2);
  assert.equal(d.formaPagamento, "Pix + Cartão de Crédito", "formas das parcelas, sem repetir");
  assert.equal(d.cliente, "Paulo de Lima Costa");
  assert.equal(d.prazoEntrega, "2026-10-08");
  assert.equal((await app.inject({ method: "GET", url: "/api/problematicos/pedidos/99999" })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/problematicos/pedidos/abc" })).statusCode, 400);
});

test("se a Nomus estiver fora, o detalhe usa o que o PCP já tem e não inventa valor", async () => {
  const { app, nomus } = await montar();
  nomus.falhar = true;
  const d = (await app.inject({ method: "GET", url: "/api/problematicos/pedidos/1744" })).json() as Record<string, unknown>;
  assert.equal(d.cliente, "Paulo de Lima Costa");
  assert.equal(d.valor, null);
  assert.equal(d.formaPagamento, "");
  assert.equal((await app.inject({ method: "GET", url: "/api/problematicos/pedidos/99999" })).statusCode, 502);
});

test("tabela 1: pedido urgente com data de entrega combinada", async () => {
  const { app } = await montar();
  const ok = await app.inject({ method: "POST", url: "/api/problematicos/urgentes", payload: { numeroPedido: 1744, dataEntregaCombinada: "2026-11-20" }, headers: { "x-pcp-usuario": encodeURIComponent("Ana Souza") } });
  assert.equal(ok.statusCode, 201);
  const lista = ok.json() as { urgentes: Array<Record<string, unknown>> };
  assert.equal(lista.urgentes[0].numeroPedido, 1744);
  assert.equal(lista.urgentes[0].cliente, "Paulo de Lima Costa", "cliente vem do pedido");
  assert.equal(lista.urgentes[0].dataEntregaCombinada, "2026-11-20");
  assert.equal(lista.urgentes[0].atualizadoPor, "Ana Souza");

  assert.equal((await app.inject({ method: "POST", url: "/api/problematicos/urgentes", payload: { numeroPedido: 1744 } })).statusCode, 400, "data é obrigatória");
  assert.equal((await app.inject({ method: "POST", url: "/api/problematicos/urgentes", payload: { numeroPedido: 1744, dataEntregaCombinada: "xx" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/problematicos/urgentes", payload: { dataEntregaCombinada: "2026-11-20" } })).statusCode, 400, "sem número do pedido");
});

test("tabela 2: devolução se preenche sozinha (forma de pagamento e valor) ao escolher o pedido", async () => {
  const { app } = await montar();
  const r = await app.inject({ method: "POST", url: "/api/problematicos/devolucoes", payload: { numeroPedido: 1744 } });
  assert.equal(r.statusCode, 201);
  const d = (r.json() as { devolucoes: Array<Record<string, unknown>> }).devolucoes[0];
  assert.equal(d.formaPagamento, "Pix + Cartão de Crédito");
  assert.equal(d.valor, 5587.2);
  assert.equal(d.cliente, "Paulo de Lima Costa");

  // o que a pessoa digitar vale mais que o automático
  const r2 = await app.inject({ method: "POST", url: "/api/problematicos/devolucoes", payload: { numeroPedido: 1744, formaPagamento: "Dinheiro", valor: 1000 } });
  const d2 = (r2.json() as { devolucoes: Array<Record<string, unknown>> }).devolucoes[0];
  assert.deepEqual([d2.formaPagamento, d2.valor], ["Dinheiro", 1000]);
  assert.equal((await app.inject({ method: "POST", url: "/api/problematicos/devolucoes", payload: { numeroPedido: 1744, valor: -5 } })).statusCode, 400);
});

test("tabela 3: cliente/defeito com causa e motorista", async () => {
  const { app } = await montar();
  const r = await app.inject({ method: "POST", url: "/api/problematicos/defeitos", payload: { numeroPedido: 1750, causa: "Telha amassada no transporte", motorista: "João" } });
  assert.equal(r.statusCode, 201);
  const d = (r.json() as { defeitos: Array<Record<string, unknown>> }).defeitos[0];
  assert.deepEqual([d.causa, d.motorista, d.cliente], ["Telha amassada no transporte", "João", "Maria Souza"]);
  assert.equal((await app.inject({ method: "POST", url: "/api/problematicos/defeitos", payload: { numeroPedido: 1750, causa: "  " } })).statusCode, 400, "causa é obrigatória");
  assert.equal((await app.inject({ method: "POST", url: "/api/problematicos/defeitos", payload: { numeroPedido: 1750, causa: "x".repeat(501) } })).statusCode, 400);
});

test("editar, remover e tabela desconhecida", async () => {
  const { app } = await montar();
  const id = ((await app.inject({ method: "POST", url: "/api/problematicos/defeitos", payload: { numeroPedido: 1750, causa: "A" } })).json() as { id: number }).id;
  const e = await app.inject({ method: "PATCH", url: `/api/problematicos/defeitos/${id}`, payload: { causa: "B", motorista: "Zé", campoInventado: 1 } });
  assert.equal(e.statusCode, 200);
  const d = (e.json() as { defeitos: Array<Record<string, unknown>> }).defeitos[0];
  assert.deepEqual([d.causa, d.motorista], ["B", "Zé"]);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/problematicos/defeitos/9999", payload: { causa: "x" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/problematicos/defeitos/${id}`, payload: {} })).statusCode, 400);

  const del = await app.inject({ method: "DELETE", url: `/api/problematicos/defeitos/${id}` });
  assert.equal((del.json() as { defeitos: unknown[] }).defeitos.length, 0);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/problematicos/defeitos/${id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/problematicos/inexistente" })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/problematicos/inexistente", payload: {} })).statusCode, 404);
});

test("perfil de consulta não acessa os registros; sem código a API recusa", async () => {
  const { app } = await montar("codigo-completo", "codigo-consulta");
  assert.equal((await app.inject({ method: "GET", url: "/api/problematicos" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/problematicos", headers: { "x-pcp-token": "codigo-consulta" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/problematicos", headers: { "x-pcp-token": "codigo-completo" } })).statusCode, 200);
});
