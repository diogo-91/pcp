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
          itensPedido: [{ dataEntrega: "08/10/2026 00:00:00" }], parcelas: [{ idFormaPagamento: 13, observacao: "entrada ", valorParcela: "726" }, { idFormaPagamento: 3, observacao: "entrega", valorParcela: "4.861,20" }] }] as T;
      }
      if (q.includes("PD 00500")) return [{ id: 900, codigoPedido: "PD 00500", idPessoaCliente: 1, idFormaPagamento: 3, valorTotal: "100,00", parcelas: [{ idFormaPagamento: 3, observacao: "", valorParcela: "100" }] }] as T;
      return [] as T;
    }
    if (caminho.startsWith("/pessoas/")) return { nome: caminho.endsWith("/7994") ? "Paulo de Lima Costa" : "Cliente Antigo" } as T;
    throw new Error(`inesperado: ${caminho}`);
  }
}

async function montar(accessToken = "", consulta = "", tempoLimiteMs = 25_000) {
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
  const servico = new ProblematicosService(db, nomus, () => AGORA, tempoLimiteMs);
  const sync = new SyncService({ get: async () => [] as never }, repo, { statusLiberado: 2 });
  const app = await buildApp({ repo, sync, accessToken, accessTokenConsulta: consulta, problematicos: servico, agora: () => AGORA });
  return { app, nomus, servico, db };
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
  assert.equal(d.valor, 726, "o valor é o da entrada");
  assert.equal(d.valorTotal, 5587.2, "o total do pedido vem à parte");
  assert.equal(d.formaPagamento, "Entrada: Pix R$ 726,00 + Entrega: Cartão de Crédito R$ 4.861,20", "entrada e entrega, cada uma com a forma e o valor");
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
  assert.equal(d.formaPagamento, "Entrada: Pix R$ 726,00 + Entrega: Cartão de Crédito R$ 4.861,20");
  assert.equal(d.valor, 726, "devolução: valor = entrada");
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

test("Nomus lenta: não trava; usa a última cópia (ou o valor do PCP) e avisa; a consulta lenta alimenta a cópia", async () => {
  const { app, nomus, servico } = await montar("", "", 50);
  const original = nomus.get.bind(nomus);
  let liberar!: () => void;
  const trava = new Promise<void>((r) => (liberar = r));
  nomus.get = async <T,>(c: string): Promise<T> => {
    if (c.startsWith("/pedidos?query=") || c === "/formasPagamento") await trava; // a Nomus "demora"
    return original<T>(c);
  };

  const lento = (await app.inject({ method: "GET", url: "/api/problematicos/pedidos/1744" })).json() as Record<string, unknown>;
  assert.match(String(lento.aviso), /Nomus não respondeu/);
  assert.equal(lento.cliente, "Paulo de Lima Costa", "o cliente vem do PCP");
  assert.equal(lento.formaPagamento, "");
  assert.equal(lento.valor, null);

  liberar(); // a consulta que estourou o tempo termina em segundo plano e grava a cópia
  await new Promise((r) => setTimeout(r, 100));

  // agora a Nomus cai de vez: a tela ainda recebe o último valor e a forma de pagamento
  nomus.get = async () => { throw new Error("Nomus fora do ar"); };
  const copia = (await app.inject({ method: "GET", url: "/api/problematicos/pedidos/1744" })).json() as Record<string, unknown>;
  assert.equal(copia.valor, 726);
  assert.equal(copia.formaPagamento, "Entrada: Pix R$ 726,00 + Entrega: Cartão de Crédito R$ 4.861,20");
  assert.match(String(copia.aviso), /última consulta/);
  assert.ok(servico);
});

test("forma de pagamento: uma parcela só mostra o nome; várias mostram entrada/entrega com valores; rótulo livre vira título", async () => {
  const { app, nomus } = await montar();
  const unica = (await app.inject({ method: "GET", url: "/api/problematicos/pedidos/500" })).json() as Record<string, unknown>;
  assert.equal(unica.formaPagamento, "Cartão de Crédito", "uma parcela: só o nome da forma");
  assert.equal(unica.valor, 100, "pagamento único: o valor é o total");

  const original = nomus.get.bind(nomus);
  nomus.get = async <T,>(c: string): Promise<T> => {
    if (c.startsWith("/pedidos?query=") && decodeURIComponent(c).includes("PD 01750")) {
      return [{ id: 1760, codigoPedido: "PD 01750", idPessoaCliente: 1, idFormaPagamento: 13, valorTotal: "3.000,00",
        parcelas: [{ idFormaPagamento: 13, observacao: "Sinal 30%", valorParcela: "900" }, { idFormaPagamento: 13, observacao: "", valorParcela: "" }] }] as T;
    }
    return original<T>(c);
  };
  const livre = (await app.inject({ method: "GET", url: "/api/problematicos/pedidos/1750" })).json() as Record<string, unknown>;
  assert.equal(livre.formaPagamento, "Sinal 30%: Pix R$ 900,00 + Parcela 2: Pix");

  // texto longo (várias parcelas) cabe no registro da devolução
  const longa = "Entrada: Pix R$ 726,00 + Entrega: Cartão de Crédito R$ 4.861,20 + Parcela 3: Boleto Bancário R$ 1.000,00 + Parcela 4: Cheque R$ 500,00";
  const r = await app.inject({ method: "POST", url: "/api/problematicos/devolucoes", payload: { numeroPedido: 1744, formaPagamento: longa, valor: 10 } });
  assert.equal(r.statusCode, 201);
});

test("valores da Nomus com ponto de milhar e sem decimais ('1.320') não viram R$ 1,32", async () => {
  const { app, nomus } = await montar();
  const original = nomus.get.bind(nomus);
  nomus.get = async <T,>(c: string): Promise<T> => {
    if (c.startsWith("/pedidos?query=") && decodeURIComponent(c).includes("PD 02262")) {
      return [{ id: 2300, codigoPedido: "PD 02262", idPessoaCliente: 1, idFormaPagamento: 13, valorTotal: "4.400,00",
        parcelas: [{ idFormaPagamento: 13, observacao: "ENTRADA ", valorParcela: "1.320" }, { idFormaPagamento: 13, observacao: "ENTREGA", valorParcela: "3.080" }] }] as T;
    }
    return original<T>(c);
  };
  const d = (await app.inject({ method: "GET", url: "/api/problematicos/pedidos/2262" })).json() as Record<string, unknown>;
  assert.equal(d.formaPagamento, "Entrada: Pix R$ 1.320,00 + Entrega: Pix R$ 3.080,00");
  assert.equal(d.valor, 1320, "valor = entrada");
  assert.equal(d.valorTotal, 4400);
});

test("status: todo registro nasce NAO_REALIZADA; dá para marcar REALIZADA e voltar; valor inválido é recusado", async () => {
  const { app } = await montar();
  for (const [tipo, corpo] of [
    ["urgentes", { numeroPedido: 1744, dataEntregaCombinada: "2026-11-20" }],
    ["devolucoes", { numeroPedido: 1744, formaPagamento: "Pix", valor: 10 }],
    ["defeitos", { numeroPedido: 1744, causa: "Amassada" }],
  ] as const) {
    const criado = await app.inject({ method: "POST", url: `/api/problematicos/${tipo}`, payload: corpo });
    const lista = (criado.json() as Record<string, Array<{ id: number; status: string }>>)[tipo];
    assert.equal(lista[0].status, "NAO_REALIZADA", `${tipo}: nasce não realizada`);

    const feito = await app.inject({ method: "PATCH", url: `/api/problematicos/${tipo}/${lista[0].id}`, payload: { status: "REALIZADA" } });
    assert.equal((feito.json() as Record<string, Array<{ status: string }>>)[tipo][0].status, "REALIZADA", `${tipo}: marcada como realizada`);
    const volta = await app.inject({ method: "PATCH", url: `/api/problematicos/${tipo}/${lista[0].id}`, payload: { status: "NAO_REALIZADA" } });
    assert.equal((volta.json() as Record<string, Array<{ status: string }>>)[tipo][0].status, "NAO_REALIZADA");
    assert.equal((await app.inject({ method: "PATCH", url: `/api/problematicos/${tipo}/${lista[0].id}`, payload: { status: "TALVEZ" } })).statusCode, 400);
  }
  // pode nascer já realizada
  const ja = await app.inject({ method: "POST", url: "/api/problematicos/defeitos", payload: { numeroPedido: 1750, causa: "X", status: "REALIZADA" } });
  assert.equal((ja.json() as { defeitos: Array<{ status: string }> }).defeitos[0].status, "REALIZADA");
});

test("clientes/defeitos: ação (texto) e prazo da ação (data opcional, pode ser limpo)", async () => {
  const { app } = await montar();
  const r = await app.inject({ method: "POST", url: "/api/problematicos/defeitos", payload: { numeroPedido: 1750, causa: "Amassada", motorista: "João", acao: "Trocar 3 telhas", prazoAcao: "2026-12-05" } });
  assert.equal(r.statusCode, 201);
  const d = (r.json() as { defeitos: Array<Record<string, unknown>> }).defeitos[0];
  assert.deepEqual([d.acao, d.prazoAcao, d.status], ["Trocar 3 telhas", "2026-12-05", "NAO_REALIZADA"]);

  const sem = (await app.inject({ method: "POST", url: "/api/problematicos/defeitos", payload: { numeroPedido: 1750, causa: "Risco" } })).json() as { defeitos: Array<Record<string, unknown>> };
  assert.deepEqual([sem.defeitos[0].acao, sem.defeitos[0].prazoAcao], ["", null], "ação e prazo são opcionais");

  const id = d.id as number;
  const limpo = (await app.inject({ method: "PATCH", url: `/api/problematicos/defeitos/${id}`, payload: { prazoAcao: null, acao: "Reagendar" } })).json() as { defeitos: Array<Record<string, unknown>> };
  const atual = limpo.defeitos.find((x) => x.id === id)!;
  assert.deepEqual([atual.acao, atual.prazoAcao], ["Reagendar", null], "o prazo pode ser apagado");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/problematicos/defeitos/${id}`, payload: { prazoAcao: "xx" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/problematicos/defeitos/${id}`, payload: { acao: "x".repeat(501) } })).statusCode, 400);
});

test("indicadores do cartão: pendentes, últimos 7 dias contra os 7 anteriores e série dos 14 dias", async () => {
  const { db } = await montar();
  const relogio = { atual: new Date("2026-11-12T15:00:00Z") };
  const servico = new ProblematicosService(db, null, () => relogio.atual);
  const dia = (iso: string) => { relogio.atual = new Date(`${iso}T15:00:00Z`); };

  dia("2026-10-25"); await servico.criar("defeitos", { numeroPedido: 1744, causa: "fora da janela de 14 dias" }, "t");
  dia("2026-11-01"); await servico.criar("defeitos", { numeroPedido: 1744, causa: "semana anterior A" }, "t");
  dia("2026-11-04"); await servico.criar("defeitos", { numeroPedido: 1744, causa: "semana anterior B" }, "t");
  dia("2026-11-06"); await servico.criar("defeitos", { numeroPedido: 1744, causa: "últimos 7 dias A" }, "t");
  dia("2026-11-12"); const ultimo = await servico.criar("defeitos", { numeroPedido: 1744, causa: "hoje" }, "t");
  dia("2026-11-12");
  servico.editar("defeitos", ultimo, { status: "REALIZADA" }, "t"); // realizada não conta como pendente

  const r = servico.listar();
  assert.equal(r.hoje, "2026-11-12");
  const d = r.resumo.defeitos;
  assert.equal(d.pendentes, 4);
  assert.equal(d.ultimos7, 2, "06/11 e 12/11");
  assert.equal(d.anteriores7, 2, "01/11 e 04/11");
  assert.equal(d.serie.length, 14);
  assert.equal(d.serie[13], 1, "hoje");
  assert.equal(d.serie[7], 1, "06/11");
  assert.equal(d.serie.reduce((a, b) => a + b, 0), 4, "o de 25/10 está fora dos 14 dias");
  assert.deepEqual(r.resumo.urgentes, { pendentes: 0, ultimos7: 0, anteriores7: 0, serie: new Array(14).fill(0) });
});

// ---------------------------------------------------------------- Devoluções > Ações

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");

async function novaDevolucao(app: Awaited<ReturnType<typeof montar>>["app"]) {
  const r = await app.inject({ method: "POST", url: "/api/problematicos/devolucoes", payload: { numeroPedido: 1750, formaPagamento: "Pix", valor: 100 } });
  return (r.json() as { id: number }).id;
}

test("ações da devolução: etapas salvas aos poucos, contador de etapas e decisão/financeiro validados", async () => {
  const { app } = await montar();
  const id = await novaDevolucao(app);
  const url = `/api/problematicos/devolucoes/${id}/acoes`;

  const vazio = (await app.inject({ method: "GET", url })).json() as { feitas: number; decisao: string };
  assert.equal(vazio.feitas, 0);

  const p1 = (await app.inject({ method: "PUT", url, payload: { sacQuem: "Ana", sacConversa: "Cliente reclamou do prazo" } })).json() as { feitas: number; sac: { quem: string } };
  assert.equal(p1.sac.quem, "Ana");
  assert.equal(p1.feitas, 1);

  // Salvar só uma etapa não apaga as outras.
  const p2 = (await app.inject({ method: "PUT", url, payload: { veraConversa: "Vera ligou de volta", decisao: "MANTEM" } })).json() as { feitas: number; sac: { conversa: string } };
  assert.equal(p2.sac.conversa, "Cliente reclamou do prazo");
  assert.equal(p2.feitas, 3);

  assert.equal((await app.inject({ method: "PUT", url, payload: { decisao: "TALVEZ" } })).statusCode, 400);
  // A data só vale quando a devolução foi realizada.
  assert.equal((await app.inject({ method: "PUT", url, payload: { finData: "2026-11-10" } })).statusCode, 400);
  const fin = (await app.inject({ method: "PUT", url, payload: { finRealizada: "SIM", finData: "2026-11-10" } })).json() as { financeiro: { realizada: string; data: string }; feitas: number };
  assert.deepEqual(fin.financeiro, { realizada: "SIM", data: "2026-11-10" });
  assert.equal(fin.feitas, 4);
  const nao = (await app.inject({ method: "PUT", url, payload: { finRealizada: "NAO" } })).json() as { financeiro: { data: string | null } };
  assert.equal(nao.financeiro.data, null, "ao voltar para Não, a data é limpa");

  assert.equal((await app.inject({ method: "PUT", url, payload: { sacConversa: "x".repeat(3001) } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: "/api/problematicos/devolucoes/9999/acoes", payload: { decisao: "MANTEM" } })).statusCode, 404);

  const lista = (await app.inject({ method: "GET", url: "/api/problematicos" })).json() as { devolucoes: Array<{ id: number; etapasFeitas: number; etapas: Array<{ chave: string; feita: boolean; detalhe: string }> }> };
  assert.equal(lista.devolucoes.find((d) => d.id === id)!.etapasFeitas, 4);
  const etapas = lista.devolucoes.find((d) => d.id === id)!.etapas;
  assert.deepEqual(etapas.map((e) => e.chave), ["sac", "vera", "dirceu", "decisao", "financeiro"]);
  assert.deepEqual(etapas.map((e) => e.feita), [true, true, false, true, true]);
  assert.equal(etapas[3].detalhe, "Mantém o pedido");
  assert.equal(etapas[4].detalhe, "Devolução ainda não realizada");
});

test("prints das ações: anexa imagem, serve de volta, recusa o que não é imagem e some junto com a devolução", async () => {
  const { app, db } = await montar();
  const id = await novaDevolucao(app);
  const base = `/api/problematicos/devolucoes/${id}/acoes`;

  const ok = (await app.inject({ method: "POST", url: `${base}/prints`, payload: { etapa: "sac", nome: "conversa.png", tipo: "image/png", dados: PNG } })).json() as { sac: { prints: Array<{ id: number; nome: string }> }; feitas: number };
  assert.equal(ok.sac.prints.length, 1);
  assert.equal(ok.feitas, 1, "só o print já conta como etapa feita");

  const img = await app.inject({ method: "GET", url: `/api/problematicos/prints/${ok.sac.prints[0].id}` });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers["content-type"], "image/png");
  assert.equal(img.headers["x-content-type-options"], "nosniff");
  assert.equal(img.rawPayload.length, 12);

  const ruim = (payload: object) => app.inject({ method: "POST", url: `${base}/prints`, payload });
  assert.equal((await ruim({ etapa: "sac", nome: "a.svg", tipo: "image/svg+xml", dados: PNG })).statusCode, 400, "SVG não");
  assert.equal((await ruim({ etapa: "sac", nome: "a.png", tipo: "image/png", dados: Buffer.from("isto não é imagem").toString("base64") })).statusCode, 400, "confere os bytes");
  assert.equal((await ruim({ etapa: "decisao", nome: "a.png", tipo: "image/png", dados: PNG })).statusCode, 400, "só SAC, Vera e Dirceu têm print");
  assert.equal((await ruim({ etapa: "vera", nome: "a.png", tipo: "image/png", dados: Buffer.alloc(4 * 1024 * 1024 + 10, 1).toString("base64") })).statusCode, 400, "passa de 4 MB");

  const sem = (await app.inject({ method: "DELETE", url: `/api/problematicos/prints/${ok.sac.prints[0].id}` })).json() as { sac: { prints: unknown[] } };
  assert.equal(sem.sac.prints.length, 0);

  await ruim({ etapa: "dirceu", nome: "b.png", tipo: "image/png", dados: PNG });
  await app.inject({ method: "PUT", url: base, payload: { dirceuConversa: "ok" } });
  await app.inject({ method: "DELETE", url: `/api/problematicos/devolucoes/${id}` });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pcp_devolucao_print").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pcp_devolucao_acao").get() as { n: number }).n, 0);
});

test("ações da devolução ficam fora do alcance do perfil de consulta", async () => {
  const { app } = await montar("segredo", "so-leitura");
  const r = await app.inject({ method: "GET", url: "/api/problematicos/devolucoes/1/acoes", headers: { "x-pcp-token": "so-leitura" } });
  assert.equal(r.statusCode, 403);
});
