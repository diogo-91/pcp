import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErroProblematicos, TIPOS_PROBLEMATICOS, type ProblematicosService, type TipoProblematico } from "./problematicos";

const CAMPOS: Record<TipoProblematico, string[]> = {
  urgentes: ["numeroPedido", "cliente", "telefone", "dataEntregaCombinada", "status"],
  devolucoes: ["numeroPedido", "cliente", "telefone", "formaPagamento", "valor", "status"],
  defeitos: ["numeroPedido", "cliente", "telefone", "causa", "motorista", "acao", "prazoAcao", "status"],
};

/** Copia só os campos permitidos do corpo (vem do navegador). */
function escolher(corpo: unknown, campos: string[]): Record<string, unknown> {
  if (corpo === null || typeof corpo !== "object" || Array.isArray(corpo)) throw new ErroProblematicos("Corpo da requisição inválido.");
  const origem = corpo as Record<string, unknown>;
  const saida: Record<string, unknown> = {};
  for (const c of campos) if (Object.prototype.hasOwnProperty.call(origem, c)) saida[c] = origem[c];
  return saida;
}

const idDe = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ErroProblematicos("Id inválido.");
  return n;
};

const tipoDe = (v: string): TipoProblematico => {
  if (!(TIPOS_PROBLEMATICOS as readonly string[]).includes(v)) throw new ErroProblematicos("Tabela desconhecida.", 404);
  return v as TipoProblematico;
};

/** Rotas do botão "Pedidos Problemáticos". Ficam sob /api/problematicos: o perfil de consulta não chega aqui. */
export function registrarProblematicos(app: FastifyInstance, servico: ProblematicosService, automacaoToken = ""): void {
  const usuarioDe = (request: FastifyRequest) => {
    const h = request.headers["x-pcp-usuario"];
    let nome = "PCP";
    if (typeof h === "string") {
      try { nome = decodeURIComponent(h); } catch { nome = h; }
    }
    return nome.replace(/[\r\n\t]/g, " ").trim().slice(0, 60) || "PCP";
  };

  const tratar = async (reply: FastifyReply, fn: () => unknown) => {
    try {
      return await fn();
    } catch (erro) {
      if (erro instanceof ErroProblematicos) return reply.code(erro.codigo).send({ erro: erro.message });
      throw erro;
    }
  };

  app.get("/api/problematicos", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return servico.listar();
  });

  app.get("/api/problematicos/pedidos", async (request, reply) =>
    tratar(reply, () => servico.buscarPedidos(String((request.query as { q?: string }).q ?? "")))
  );

  app.get("/api/problematicos/pedidos/:numero", async (request, reply) =>
    tratar(reply, () => servico.detalhe(Number((request.params as { numero: string }).numero)))
  );

  // ---- Automação (n8n): avisos de "cliente quer cancelar" para o financeiro. Código próprio (AUTOMACAO_TOKEN), nunca aberto.
  const hashDe = (v: string) => createHash("sha256").update(v).digest();
  const automacaoOk = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!automacaoToken) {
      reply.code(503).send({ erro: "Automação desativada: defina AUTOMACAO_TOKEN no servidor." });
      return false;
    }
    const h = request.headers["x-automacao-token"];
    const recebido = typeof h === "string" ? h : String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!recebido || !timingSafeEqual(hashDe(recebido), hashDe(automacaoToken))) {
      reply.code(401).send({ erro: "Código da automação inválido." });
      return false;
    }
    return true;
  };

  app.get("/api/problematicos/automacao/cancelamentos", async (request, reply) => {
    if (!automacaoOk(request, reply)) return reply;
    reply.header("Cache-Control", "no-store");
    return { itens: servico.avisosDeCancelamento() };
  });

  app.post("/api/problematicos/automacao/cancelamentos/:id/avisado", async (request, reply) => {
    if (!automacaoOk(request, reply)) return reply;
    return tratar(reply, () => {
      servico.acoes.marcarAvisoCancelamento(idDe((request.params as { id: string }).id));
      return { ok: true };
    });
  });

  // ---- Devoluções > Ações (etapas do atendimento e prints)
  const acoes = servico.acoes;
  const PRINT_LIMITE = 7 * 1024 * 1024; // imagem de até 4 MB em base64 cabe aqui

  app.get("/api/problematicos/devolucoes/:id/acoes", async (request, reply) =>
    tratar(reply, () => {
      reply.header("Cache-Control", "no-store");
      return acoes.obter(idDe((request.params as { id: string }).id));
    })
  );

  app.put("/api/problematicos/devolucoes/:id/acoes", async (request, reply) =>
    tratar(reply, () =>
      acoes.salvar(
        idDe((request.params as { id: string }).id),
        escolher(request.body, ["sacQuem", "sacConversa", "veraConversa", "dirceuConversa", "decisao", "finRealizada", "finData"]),
        usuarioDe(request)
      )
    )
  );

  app.post("/api/problematicos/devolucoes/:id/acoes/prints", { bodyLimit: PRINT_LIMITE }, async (request, reply) =>
    tratar(reply, () => {
      const c = escolher(request.body, ["etapa", "nome", "tipo", "dados"]);
      return acoes.adicionarPrint(idDe((request.params as { id: string }).id), String(c.etapa ?? ""), c.nome, c.tipo, c.dados, usuarioDe(request));
    })
  );

  app.get("/api/problematicos/prints/:id", async (request, reply) =>
    tratar(reply, () => {
      const p = acoes.lerPrint(idDe((request.params as { id: string }).id));
      return reply
        .header("Content-Type", p.mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cache-Control", "private, max-age=3600")
        .send(p.dados);
    })
  );

  app.delete("/api/problematicos/prints/:id", async (request, reply) =>
    tratar(reply, () => acoes.removerPrint(idDe((request.params as { id: string }).id)))
  );

  // ---- Clientes / Defeitos > anexos (imagem ou PDF)
  const anexos = servico.anexos;
  app.post("/api/problematicos/defeitos/:id/anexos", { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) =>
    tratar(reply, () => {
      const c = escolher(request.body, ["nome", "tipo", "dados"]);
      anexos.adicionar(idDe((request.params as { id: string }).id), c.nome, c.tipo, c.dados, usuarioDe(request));
      return servico.listar();
    })
  );

  app.get("/api/problematicos/anexos/:id", async (request, reply) =>
    tratar(reply, () => {
      const a = anexos.ler(idDe((request.params as { id: string }).id));
      return reply
        .header("Content-Type", a.mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cache-Control", "private, max-age=3600")
        .send(a.dados);
    })
  );

  app.delete("/api/problematicos/anexos/:id", async (request, reply) =>
    tratar(reply, () => {
      anexos.remover(idDe((request.params as { id: string }).id));
      return servico.listar();
    })
  );

  app.post("/api/problematicos/:tipo", async (request, reply) =>
    tratar(reply, async () => {
      const tipo = tipoDe((request.params as { tipo: string }).tipo);
      const id = await servico.criar(tipo, escolher(request.body, CAMPOS[tipo]), usuarioDe(request));
      return reply.code(201).send({ id, ...servico.listar() });
    })
  );

  app.patch("/api/problematicos/:tipo/:id", async (request, reply) =>
    tratar(reply, () => {
      const { tipo: t, id } = request.params as { tipo: string; id: string };
      const tipo = tipoDe(t);
      servico.editar(tipo, idDe(id), escolher(request.body, CAMPOS[tipo]), usuarioDe(request));
      return servico.listar();
    })
  );

  app.delete("/api/problematicos/:tipo/:id", async (request, reply) =>
    tratar(reply, () => {
      const { tipo, id } = request.params as { tipo: string; id: string };
      servico.remover(tipoDe(tipo), idDe(id));
      return servico.listar();
    })
  );
}
