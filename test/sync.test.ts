import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/db";
import { PcpRepository } from "../src/repository";
import { SyncService, type NomusLeitor } from "../src/sync";

type Resposta = unknown;

/** Nomus de mentira: `responder` devolve o corpo (ou um Error para simular falha) de cada caminho chamado. */
class NomusFalso implements NomusLeitor {
  chamadas: string[] = [];
  constructor(private responder: (caminho: string) => Resposta) {}

  async get<T>(caminho: string): Promise<T> {
    this.chamadas.push(caminho);
    const r = this.responder(caminho);
    if (r instanceof Error) throw r;
    return r as T;
  }

  contar(trecho: string) {
    return this.chamadas.filter((c) => c.includes(trecho)).length;
  }
}

const item = (status: number, dataEntrega = "10/10/2026 00:00:00") => ({ status, dataEntrega });
const ped = (id: number, cliente: number, itens = [item(2)], codigo = `PD ${String(id - 31).padStart(5, "0")}`) => ({
  id,
  codigoPedido: codigo,
  idPessoaCliente: cliente,
  itensPedido: itens,
});
const pessoa = (id: number, nome: string, telefone: string) => ({ id, nome, telefone });

const semEspera = { sleep: async () => {} };

const preparar = (responder: (c: string) => Resposta) => {
  const repo = new PcpRepository(openDatabase(":memory:"));
  const nomus = new NomusFalso(responder);
  const relogio = { atual: new Date("2026-09-28T13:00:00Z") };
  const sync = new SyncService(nomus, repo, { statusLiberado: 2, agora: () => relogio.atual, ...semEspera });
  return { repo, nomus, sync, relogio };
};

const clientes: Record<number, ReturnType<typeof pessoa>> = {
  501: pessoa(501, "  Maria   da Silva ", "15 99850-7812"),
  502: pessoa(502, "Metalúrgica Foco", "11 4002-8922"),
};

const respostaPadrao = (lista: unknown[]) => (c: string) => {
  if (c.startsWith("/pedidos?")) return lista;
  if (c.startsWith("/pessoas?query=")) {
    // Lote em RSQL da Nomus: "id=501,id=502" (OR).
    const ids = c.replace("/pessoas?query=", "").split(",").map((parte) => Number(parte.replace("id=", "")));
    return ids.map((id) => clientes[id]).filter(Boolean);
  }
  return new Error("caminho inesperado: " + c);
};

test("inclui só nome, nº do pedido, telefone e prazo; deduplica o join; limpa espaços", async () => {
  const { repo, sync, nomus } = preparar(
    respostaPadrao([
      ped(2001, 501, [item(2, "20/10/2026 00:00:00"), item(2, "12/10/2026 00:00:00")]),
      ped(2001, 501, [item(2, "20/10/2026 00:00:00"), item(2, "12/10/2026 00:00:00")]), // duplicado do join
      ped(2002, 502, [item(2, "05/11/2026 00:00:00")]),
    ])
  );

  const run = await sync.executar("teste");
  assert.equal(run.status, "ok");
  assert.equal(run.pedidosLidos, 2);
  assert.equal(run.novos, 2);
  assert.match(nomus.chamadas[0], /itensPedido\.status=2/, "filtra pelo status liberado na Nomus");

  const p1 = repo.buscar(2001)!;
  assert.equal(p1.numero, 1970);
  assert.equal(p1.codigoPedido, "PD 01970");
  assert.equal(p1.clienteNome, "Maria da Silva");
  assert.equal(p1.telefone, "15 99850-7812");
  assert.equal(p1.prazoEntrega, "2026-10-12", "usa a data de entrega mais próxima entre os itens");
  assert.equal(repo.buscar(2002)!.prazoEntrega, "2026-11-05");
});

test("ignora pedido que a Nomus devolveu sem item liberado (filtro ignorado não vira 'tudo liberado')", async () => {
  const { repo, sync } = preparar(respostaPadrao([ped(2001, 501, [item(2)]), ped(2002, 502, [item(1)]), ped(2003, 502, [item(4)])]));

  const run = await sync.executar("teste");
  assert.equal(run.pedidosLidos, 1);
  assert.deepEqual(repo.listar().map((p) => p.nomusId), [2001]);
});

test("pedido sem data de entrega entra sem prazo; código sem número é descartado", async () => {
  const semData = { status: 2 };
  const { repo, sync } = preparar(respostaPadrao([ped(2001, 501, [semData as never]), ped(2002, 502, [item(2)], "SEM NUMERO")]));

  const run = await sync.executar("teste");
  assert.equal(run.novos, 1);
  assert.equal(repo.buscar(2001)!.prazoEntrega, null);
  assert.equal(repo.buscar(2002), null);
});

// ---------------------------------------------------------------- só inclusão: o que já existe não é tocado

test("pedido que já está no banco não é alterado nem gera consulta ao cadastro do cliente", async () => {
  let lista = [ped(2001, 501, [item(2, "10/10/2026 00:00:00")])];
  const { repo, sync, nomus, relogio } = preparar((c) => respostaPadrao(lista)(c));

  await sync.executar("teste");
  repo.atualizarTratativa(2001, { prazoEntrega: "2026-10-25", statusPcp: "EM PRODUÇÃO", responsavel: "Carlos" }, "2026-09-28T13:00:00Z");
  const consultasAntes = nomus.contar("/pessoas");

  // Passam 8 dias: o cache do cliente (7 dias) venceu. Se o pedido conhecido fosse reprocessado, o cliente
  // seria consultado de novo; como ele é pulado por inteiro, nenhuma chamada é feita.
  relogio.atual = new Date("2026-10-07T13:00:00Z");
  // A Nomus muda o prazo e o cliente muda de nome: nada disso pode chegar ao pedido já existente.
  lista = [ped(2001, 501, [item(2, "30/11/2026 00:00:00")])];
  clientes[501] = pessoa(501, "Nome Novo", "11 00000-0000");
  try {
    const run = await sync.executar("teste");
    assert.equal(run.novos, 0);
    assert.equal(run.pedidosLidos, 1);
  } finally {
    clientes[501] = pessoa(501, "  Maria   da Silva ", "15 99850-7812");
  }

  const p = repo.buscar(2001)!;
  assert.equal(p.prazoEntrega, "2026-10-25", "o prazo editado pelo PCP fica");
  assert.equal(p.clienteNome, "Maria da Silva");
  assert.equal(p.statusPcp, "EM PRODUÇÃO");
  assert.equal(p.responsavel, "Carlos");
  assert.equal(nomus.contar("/pessoas"), consultasAntes, "pedido conhecido não consulta o cliente de novo");
});

test("numa rodada seguinte entram só os pedidos novos, sem mexer nos antigos", async () => {
  let lista = [ped(2001, 501)];
  const { repo, sync } = preparar((c) => respostaPadrao(lista)(c));
  await sync.executar("teste");
  repo.atualizarTratativa(2001, { acao: "Cobrar fornecedor" }, "2026-09-28T13:00:00Z");

  lista = [ped(2001, 501), ped(2002, 502)];
  const run = await sync.executar("teste");
  assert.equal(run.novos, 1);
  assert.deepEqual(repo.listar().map((p) => p.nomusId).sort(), [2001, 2002]);
  assert.equal(repo.buscar(2001)!.acao, "Cobrar fornecedor");
});

test("pedido que a Nomus deixa de listar como liberado continua na tabela", async () => {
  let lista = [ped(2001, 501), ped(2002, 502)];
  const { repo, sync } = preparar((c) => respostaPadrao(lista)(c));
  await sync.executar("teste");

  lista = [ped(2001, 501)];
  await sync.executar("teste");
  assert.deepEqual(repo.listar().map((p) => p.nomusId).sort(), [2001, 2002]);
});

test("a Nomus devolvendo 0 liberados é uma rodada normal e não apaga nada", async () => {
  let lista = [ped(2001, 501), ped(2002, 502)];
  const { repo, sync } = preparar((c) => respostaPadrao(lista)(c));
  await sync.executar("teste");

  lista = [];
  const run = await sync.executar("teste");
  assert.equal(run.status, "ok");
  assert.equal(run.pedidosLidos, 0);
  assert.equal(repo.listar().length, 2);
});

test("falha da Nomus não altera a base e é registrada como erro", async () => {
  let falhar = false;
  const { repo, sync } = preparar((c) => (falhar ? new Error("Nomus respondeu 500") : respostaPadrao([ped(2001, 501)])(c)));
  await sync.executar("teste");

  falhar = true;
  const run = await sync.executar("teste");
  assert.equal(run.status, "erro");
  assert.match(run.erro!, /500/);
  assert.equal(repo.listar().length, 1);
  assert.equal(sync.status().ultimaComSucesso!.status, "ok", "última rodada boa continua registrada");
});

// ---------------------------------------------------------------- clientes (nome e telefone)

test("cliente indisponível: o pedido NÃO entra em branco; fica de fora e entra na rodada seguinte", async () => {
  let cliente502Falha = true;
  let loteFalha = true;
  const { repo, sync, nomus } = preparar((c) => {
    if (c.startsWith("/pedidos?")) return [ped(2001, 501), ped(2002, 502)];
    if (c.startsWith("/pessoas?query=")) return loteFalha ? new Error("400 lote não suportado") : [clientes[501], clientes[502]];
    if (c === "/pessoas/501") return clientes[501];
    if (c === "/pessoas/502") return cliente502Falha ? new Error("429") : clientes[502];
    return new Error("inesperado " + c);
  });

  // Rodada 1: o lote falha, 501 vem pela consulta individual, 502 falha.
  const r1 = await sync.executar("teste");
  assert.equal(r1.status, "ok", "um cliente indisponível não derruba a rodada");
  assert.equal(r1.novos, 1);
  assert.equal(repo.buscar(2001)!.clienteNome, "Maria da Silva");
  assert.equal(repo.buscar(2002), null, "sem os dados do cliente o pedido não é gravado (não ficaria em branco para sempre)");

  // Rodada 2: 502 volta a responder e o pedido entra completo. 501 já existe e não é consultado.
  cliente502Falha = false;
  const consultas501 = nomus.contar("/pessoas/501");
  const r2 = await sync.executar("teste");
  assert.equal(r2.novos, 1);
  assert.equal(repo.buscar(2002)!.clienteNome, "Metalúrgica Foco");
  assert.equal(repo.buscar(2002)!.telefone, "11 4002-8922");
  assert.equal(nomus.contar("/pessoas/501"), consultas501);
});

test("cliente cadastrado sem telefone entra com telefone em branco", async () => {
  clientes[503] = { id: 503, nome: "Sem Fone Ltda" } as never;
  try {
    const { repo, sync } = preparar(respostaPadrao([ped(2001, 503)]));
    await sync.executar("teste");
    assert.equal(repo.buscar(2001)!.clienteNome, "Sem Fone Ltda");
    assert.equal(repo.buscar(2001)!.telefone, "");
  } finally {
    delete clientes[503];
  }
});

test("cliente em cache válido não gera nova consulta à Nomus", async () => {
  let lista = [ped(2001, 501)];
  const { sync, nomus } = preparar((c) => respostaPadrao(lista)(c));
  await sync.executar("teste");
  const primeira = nomus.contar("/pessoas");

  lista = [ped(2001, 501), ped(2002, 501)]; // pedido novo do mesmo cliente
  await sync.executar("teste");
  assert.equal(nomus.contar("/pessoas"), primeira);
});

test("uma sincronização por vez: chamadas simultâneas compartilham a mesma rodada", async () => {
  const { sync, nomus } = preparar(respostaPadrao([ped(2001, 501)]));
  const [a, b] = await Promise.all([sync.executar("manual"), sync.executar("agendada")]);
  assert.equal(a.id, b.id);
  assert.equal(nomus.contar("/pedidos?"), 1);
  assert.equal(sync.executando(), false);
});

// ---------------------------------------------------------------- paginação e gravação parcial

const numeroDaPagina = (caminho: string) => Number(/pagina=(\d+)/.exec(caminho)![1]);

/** `total` pedidos liberados (ids 3001...), servidos em páginas de 50 como a Nomus faz. */
const paginasDe = (total: number, cliente = 501) => (c: string) => {
  if (c.startsWith("/pedidos?")) {
    const pagina = numeroDaPagina(c);
    const todos = Array.from({ length: total }, (_, i) => ped(3001 + i, cliente));
    return todos.slice((pagina - 1) * 50, pagina * 50);
  }
  return respostaPadrao([])(c);
};

test("percorre todas as páginas (50 por vez) até vir uma incompleta", async () => {
  const { repo, sync, nomus } = preparar(paginasDe(120));

  const run = await sync.executar("teste");
  assert.equal(run.status, "ok");
  assert.equal(run.pedidosLidos, 120);
  assert.equal(repo.listar().length, 120);
  assert.equal(nomus.contar("/pedidos?"), 3, "3 páginas: 50 + 50 + 20");
});

test("uma página exatamente cheia obriga a pedir a seguinte (que vem vazia) antes de parar", async () => {
  const { sync, nomus } = preparar(paginasDe(100));
  const run = await sync.executar("teste");
  assert.equal(run.pedidosLidos, 100);
  assert.equal(nomus.contar("/pedidos?"), 3);
});

test("cada página é gravada assim que chega (a tabela enche durante a leitura)", async () => {
  const repo = new PcpRepository(openDatabase(":memory:"));
  const vistoNaPagina2: { gravados: number; progresso: number } = { gravados: -1, progresso: -1 };

  const nomus = new NomusFalso((c) => {
    if (c.startsWith("/pedidos?")) {
      if (numeroDaPagina(c) === 2) {
        // Ao pedir a página 2, a página 1 já tem que estar no banco e o progresso registrado.
        vistoNaPagina2.gravados = repo.listar().length;
        vistoNaPagina2.progresso = repo.ultimaSync()!.pedidosLidos;
      }
      return paginasDe(70)(c);
    }
    return respostaPadrao([])(c);
  });

  await new SyncService(nomus, repo, { statusLiberado: 2, ...semEspera }).executar("teste");
  assert.equal(vistoNaPagina2.gravados, 50);
  assert.equal(vistoNaPagina2.progresso, 50);
  assert.equal(repo.listar().length, 70);
});

test("falha no meio da leitura: o que já entrou fica salvo e a rodada vira erro com o parcial", async () => {
  const repo = new PcpRepository(openDatabase(":memory:"));
  repo.inserirNovos(
    [{ nomusId: 9001, numero: 9001, codigoPedido: "PD 09001", clienteId: 1, clienteNome: "Já existia", telefone: "", prazoEntrega: null }],
    "2026-09-28T10:00:00.000Z"
  );

  const nomus = new NomusFalso((c) => (c.startsWith("/pedidos?") && numeroDaPagina(c) === 3 ? new Error("Nomus respondeu 500") : paginasDe(120)(c)));
  const run = await new SyncService(nomus, repo, { statusLiberado: 2, ...semEspera }).executar("teste");

  assert.equal(run.status, "erro");
  assert.match(run.erro!, /500/);
  assert.equal(run.pedidosLidos, 100, "registra o que chegou antes da falha");
  assert.equal(run.novos, 100);
  assert.equal(repo.listar().length, 101, "as 100 já lidas ficaram salvas, mais a que já existia");
});

test("pedido que aparece repetido entre duas páginas (join por item) conta uma vez só", async () => {
  const repo = new PcpRepository(openDatabase(":memory:"));
  const pagina1 = Array.from({ length: 50 }, (_, i) => ped(4001 + i, 501));
  const pagina2 = [pagina1[49], ped(4051, 502)]; // o último da página 1 reaparece na 2 (segundo item do mesmo pedido)

  const nomus = new NomusFalso((c) => (c.startsWith("/pedidos?") ? (numeroDaPagina(c) === 1 ? pagina1 : pagina2) : respostaPadrao([])(c)));
  const run = await new SyncService(nomus, repo, { statusLiberado: 2, ...semEspera }).executar("teste");

  assert.equal(run.pedidosLidos, 51);
  assert.equal(run.novos, 51);
  assert.equal(repo.listar().length, 51);
});

// ---------------------------------------------------------------- margem de dias no prazo de entrega de pedido NOVO

const prepararComMargem = (responder: (c: string) => Resposta, diasExtraEntrega?: number) => {
  const repo = new PcpRepository(openDatabase(":memory:"));
  const nomus = new NomusFalso(responder);
  const sync = new SyncService(nomus, repo, { statusLiberado: 2, diasExtraEntrega, ...semEspera });
  return { repo, nomus, sync };
};

test("pedido NOVO entra com o prazo da Nomus + 20 dias; vira o mês e o ano certo", async () => {
  const { repo, sync } = prepararComMargem(
    respostaPadrao([
      ped(2001, 501, [item(2, "10/10/2026 00:00:00")]),
      ped(2002, 502, [item(2, "20/12/2026 00:00:00")]), // 20/12 + 20 = 09/01 do ano seguinte
      ped(2003, 501, [item(2, "20/02/2028 00:00:00")]), // 2028 é bissexto: 20/02 + 20 = 11/03
    ]),
    20
  );
  await sync.executar("teste");

  assert.equal(repo.buscar(2001)!.prazoEntrega, "2026-10-30");
  assert.equal(repo.buscar(2002)!.prazoEntrega, "2027-01-09");
  assert.equal(repo.buscar(2003)!.prazoEntrega, "2028-03-11");
});

test("a margem soma ao prazo MAIS PRÓXIMO entre os itens liberados (uma vez só, não por item)", async () => {
  const { repo, sync } = prepararComMargem(
    respostaPadrao([ped(2001, 501, [item(2, "20/10/2026 00:00:00"), item(2, "12/10/2026 00:00:00"), item(1, "01/10/2026 00:00:00")])]),
    20
  );
  await sync.executar("teste");
  assert.equal(repo.buscar(2001)!.prazoEntrega, "2026-11-01", "12/10 (o item não liberado é ignorado) + 20");
});

test("pedido sem data de entrega na Nomus continua SEM prazo (não inventa data)", async () => {
  const { repo, sync } = prepararComMargem(respostaPadrao([ped(2001, 501, [{ status: 2 } as never])]), 20);
  await sync.executar("teste");
  assert.equal(repo.buscar(2001)!.prazoEntrega, null);
});

test("a margem só vale na ENTRADA: pedido que já está no banco nunca é alterado, nem ganha +20 de novo", async () => {
  const lista = [ped(2001, 501, [item(2, "10/10/2026 00:00:00")])];
  const { repo, sync } = prepararComMargem((c) => respostaPadrao(lista)(c), 20);
  await sync.executar("teste");
  assert.equal(repo.buscar(2001)!.prazoEntrega, "2026-10-30");

  repo.atualizarTratativa(2001, { prazoEntrega: "2026-11-15" }, "2026-10-06T10:00:00.000Z"); // o PCP ajustou
  await sync.executar("teste");
  await sync.executar("teste");
  assert.equal(repo.buscar(2001)!.prazoEntrega, "2026-11-15", "a edição do PCP fica; sincronizar de novo não soma mais 20");
});

test("sem a opção (ou com 0) o prazo entra exatamente como veio da Nomus", async () => {
  for (const extra of [undefined, 0]) {
    const { repo, sync } = prepararComMargem(respostaPadrao([ped(2001, 501, [item(2, "10/10/2026 00:00:00")])]), extra);
    await sync.executar("teste");
    assert.equal(repo.buscar(2001)!.prazoEntrega, "2026-10-10", String(extra));
  }
});
