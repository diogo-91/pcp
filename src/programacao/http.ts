import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { calcularBobina, type EdicaoCompra, type ExtrasService } from "./extras";
import { ErroDeValidacao, filtrosDaQuery, type EdicaoItem, type EdicaoPedido, type Perfil, type ProgramacaoService } from "./service";

declare module "fastify" {
  interface FastifyRequest {
    /** completo = ACCESS_TOKEN (ou sem autenticação local); consulta = ACCESS_TOKEN_CONSULTA (só leitura, sem telefone). */
    perfil: Perfil;
  }
}

const CAMPOS_ITEM = [
  "situacao", "dataProgramacao", "dataLiberacaoProducao", "dataProduzida", "dataEntregaRealizada", "fornecedorTerceiro",
  "dataEntregaTerceiro", "categoria", "tipoPintura", "corId", "facesPintura", "trapezio", "medidas", "metrosChapa", "resetar",
  "reconhecerAlteracaoErp",
] as const;
const CAMPOS_PEDIDO = ["dataEntregaNegociada", "observacao", "rotaId", "lembrarCidade"] as const;

/** Copia só os campos permitidos (o corpo vem do navegador: nada além da lista entra). */
function escolher<T extends string>(corpo: unknown, campos: readonly T[]): Record<string, unknown> {
  if (corpo === null || typeof corpo !== "object" || Array.isArray(corpo)) throw new ErroDeValidacao("Corpo da requisição inválido.");
  const origem = corpo as Record<string, unknown>;
  const saida: Record<string, unknown> = {};
  for (const c of campos) if (Object.prototype.hasOwnProperty.call(origem, c)) saida[c] = origem[c];
  return saida;
}

const idDe = (valor: string): number => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw new ErroDeValidacao("Id inválido.");
  return n;
};

export function registrarProgramacao(
  app: FastifyInstance,
  servico: ProgramacaoService,
  /** Busca um pedido na Nomus e atualiza a Programação dele (opcional: sem Nomus configurada o botão responde 503). */
  sincronizarPedido?: (nomusPedidoId: number) => Promise<unknown>,
  /** Importação do histórico da planilha (.xlsx enviado pela tela). Opcional. */
  importarPlanilha?: (arquivo: Buffer, opcoes: { gravar: boolean; forcar: boolean }) => unknown,
  /** Agenda, painel, compras de terceiros, parafusos, feriados e calculadora. */
  extras?: ExtrasService
): void {
  app.decorateRequest("perfil", "completo");

  const usuarioDe = (request: FastifyRequest) => {
    const h = request.headers["x-pcp-usuario"];
    if (typeof h !== "string") return undefined;
    try {
      return decodeURIComponent(h);
    } catch {
      return h;
    }
  };

  /** Executa e traduz ErroDeValidacao em resposta HTTP. */
  const tratar = async (reply: FastifyReply, fn: () => unknown) => {
    try {
      return await fn();
    } catch (erro) {
      if (erro instanceof ErroDeValidacao) return reply.code(erro.codigo).send({ erro: erro.message });
      throw erro;
    }
  };

  const exigirCompleto = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (request.perfil === "completo") return true;
    void reply.code(403).send({ erro: "Seu acesso é somente leitura." });
    return false;
  };

  const queryTexto = (q: unknown) =>
    Object.fromEntries(Object.entries((q ?? {}) as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));

  app.get("/api/programacao", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return servico.listar(filtrosDaQuery(queryTexto(request.query)), request.perfil);
  });

  app.get("/api/programacao/exportar.csv", async (request, reply) => {
    const csv = servico.exportarCsv(filtrosDaQuery(queryTexto(request.query)), request.perfil);
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="programacao-${servico.hoje()}.csv"`)
      .header("Cache-Control", "no-store")
      .send(csv);
  });

  app.get("/api/programacao/pedidos/:id", async (request, reply) =>
    tratar(reply, () => {
      const d = servico.detalhe(idDe((request.params as { id: string }).id), request.perfil);
      if (!d) throw new ErroDeValidacao("Pedido não encontrado.", 404);
      reply.header("Cache-Control", "no-store");
      return d;
    })
  );

  app.patch("/api/programacao/itens/:id", async (request, reply) => {
    if (!exigirCompleto(request, reply)) return;
    return tratar(reply, () => {
      const id = idDe((request.params as { id: string }).id);
      servico.editarItem(id, escolher(request.body, CAMPOS_ITEM) as EdicaoItem, usuarioDe(request));
      return servico.linha(id, request.perfil) ?? { ok: true };
    });
  });

  app.patch("/api/programacao/pedidos/:id", async (request, reply) => {
    if (!exigirCompleto(request, reply)) return;
    return tratar(reply, () => {
      const id = idDe((request.params as { id: string }).id);
      servico.editarPedido(id, escolher(request.body, CAMPOS_PEDIDO) as EdicaoPedido, usuarioDe(request));
      return servico.detalhe(id, request.perfil)?.pedido ?? { ok: true };
    });
  });

  app.post("/api/programacao/pedidos/:id/sincronizar", async (request, reply) => {
    if (!exigirCompleto(request, reply)) return;
    return tratar(reply, async () => {
      if (!sincronizarPedido) throw new ErroDeValidacao("A sincronização com a Nomus não está disponível.", 503);
      const pedido = servico.pedido(idDe((request.params as { id: string }).id));
      if (!pedido) throw new ErroDeValidacao("Pedido não encontrado.", 404);
      try {
        await sincronizarPedido(pedido.nomusPedidoId);
      } catch (erro) {
        throw new ErroDeValidacao(erro instanceof Error ? erro.message : String(erro), 502);
      }
      return servico.detalhe(pedido.id, request.perfil)?.pedido ?? { ok: true };
    });
  });

  // O arquivo .xlsx chega cru no corpo (application/octet-stream), sem multipart.
  if (importarPlanilha) {
    app.addContentTypeParser(["application/octet-stream", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], { parseAs: "buffer", bodyLimit: 30 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    app.post("/api/programacao/importar", async (request, reply) => {
      if (!exigirCompleto(request, reply)) return;
      return tratar(reply, () => {
        const { gravar, forcar } = queryTexto(request.query) as { gravar?: string; forcar?: string };
        if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new ErroDeValidacao("Envie o arquivo .xlsx no corpo da requisição.");
        try {
          return importarPlanilha(request.body, { gravar: gravar === "1", forcar: forcar === "1" });
        } catch (erro) {
          throw new ErroDeValidacao(erro instanceof Error ? erro.message : "Não foi possível ler a planilha.");
        }
      });
    });
  }

  if (extras) registrarExtras();

  function registrarExtras() {
    const ex = extras as ExtrasService;
    const nomeUsuario = (request: FastifyRequest) => (usuarioDe(request) ?? "PCP").replace(/[\r\n\t]/g, " ").trim().slice(0, 60) || "PCP";

    app.get("/api/programacao/agenda", async (request, reply) =>
      tratar(reply, () => {
        const q = queryTexto(request.query);
        reply.header("Cache-Control", "no-store");
        return ex.agenda(q.de, q.ate, request.perfil);
      })
    );
    app.get("/api/programacao/painel", async (request, reply) =>
      tratar(reply, () => {
        const q = queryTexto(request.query);
        reply.header("Cache-Control", "no-store");
        return ex.painel(q.de, q.ate, request.perfil);
      })
    );
    app.get("/api/programacao/parafusos", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return ex.parafusos(request.perfil);
    });
    app.put("/api/programacao/parafusos/:codigo/estoque", async (request, reply) => {
      if (!exigirCompleto(request, reply)) return;
      return tratar(reply, () => {
        const c = escolher(request.body, ["quantidade", "contadoEm"] as const);
        ex.definirEstoque((request.params as { codigo: string }).codigo, c.quantidade as number, (c.contadoEm as string | undefined) ?? undefined);
        return ex.parafusos(request.perfil);
      });
    });

    app.get("/api/programacao/calculadora", async (request, reply) =>
      tratar(reply, () => {
        const q = queryTexto(request.query);
        const n = (v?: string) => (v === undefined || v === "" ? undefined : Number(String(v).replace(",", ".")));
        return calcularBobina({ espessuraMm: n(q.espessura) as number, larguraM: n(q.largura) as number, densidade: n(q.densidade), pesoKg: n(q.peso), comprimentoM: n(q.comprimento) });
      })
    );

    app.get("/api/programacao/feriados", async () => ex.feriados());
    app.put("/api/programacao/feriados", async (request, reply) => {
      if (!exigirCompleto(request, reply)) return;
      return tratar(reply, () => {
        const c = escolher(request.body, ["data", "nome"] as const);
        ex.adicionarFeriado(String(c.data), String(c.nome));
        return ex.feriados();
      });
    });
    app.delete("/api/programacao/feriados/:data", async (request, reply) => {
      if (!exigirCompleto(request, reply)) return;
      ex.removerFeriado((request.params as { data: string }).data);
      return ex.feriados();
    });

    app.get("/api/programacao/compras", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const q = queryTexto(request.query);
      return ex.compras({ tipo: q.tipo, status: q.status, fornecedor: q.fornecedor, q: q.q }, request.perfil);
    });
    const CAMPOS_COMPRA = ["tipo", "numeroPedido", "pedidoId", "fornecedorId", "medidas", "totalMetros", "comprimentoPecaM", "material", "tr", "cotacao", "valor", "status", "compradoPor", "compradoEm", "observacao"] as const;
    app.post("/api/programacao/compras", async (request, reply) => {
      if (!exigirCompleto(request, reply)) return;
      return tratar(reply, () => ({ id: ex.criarCompra(escolher(request.body, CAMPOS_COMPRA) as EdicaoCompra, nomeUsuario(request)) }));
    });
    app.patch("/api/programacao/compras/:id", async (request, reply) => {
      if (!exigirCompleto(request, reply)) return;
      return tratar(reply, () => {
        ex.editarCompra(idDe((request.params as { id: string }).id), escolher(request.body, CAMPOS_COMPRA) as EdicaoCompra, nomeUsuario(request));
        return { ok: true };
      });
    });

    app.get("/api/programacao/fornecedores", async () => ex.fornecedores());
    app.post("/api/programacao/fornecedores", async (request, reply) => {
      if (!exigirCompleto(request, reply)) return;
      return tratar(reply, () => {
        ex.salvarFornecedor(escolher(request.body, ["nome", "fornece", "contato"] as const));
        return ex.fornecedores();
      });
    });
    app.patch("/api/programacao/fornecedores/:id", async (request, reply) => {
      if (!exigirCompleto(request, reply)) return;
      return tratar(reply, () => {
        ex.salvarFornecedor({ ...escolher(request.body, ["nome", "fornece", "contato", "ativo"] as const), id: idDe((request.params as { id: string }).id) });
        return ex.fornecedores();
      });
    });
    app.get("/api/programacao/fornecedores/:id/pagamentos", async (request, reply) =>
      tratar(reply, () => ex.pagamentos(idDe((request.params as { id: string }).id)))
    );
    app.post("/api/programacao/fornecedores/:id/pagamentos", async (request, reply) => {
      if (!exigirCompleto(request, reply)) return;
      return tratar(reply, () => {
        const c = escolher(request.body, ["data", "valor", "observacao"] as const);
        const fornecedorId = idDe((request.params as { id: string }).id);
        ex.registrarPagamento({ fornecedorId, data: c.data as string | undefined, valor: c.valor as number, observacao: c.observacao as string | undefined }, nomeUsuario(request));
        return ex.pagamentos(fornecedorId);
      });
    });
    app.delete("/api/programacao/pagamentos/:id", async (request, reply) => {
      if (!exigirCompleto(request, reply)) return;
      return tratar(reply, () => {
        ex.removerPagamento(idDe((request.params as { id: string }).id));
        return { ok: true };
      });
    });
  }

  app.post("/api/programacao/lote", async (request, reply) => {
    if (!exigirCompleto(request, reply)) return;
    return tratar(reply, () => {
      const corpo = escolher(request.body, ["ids", "situacao", "dataProgramacao", "rotaId"] as const);
      const { ids, ...edicao } = corpo;
      return servico.editarEmLote(ids as number[], edicao as EdicaoItem & { rotaId?: number | null }, usuarioDe(request));
    });
  });

  app.put("/api/programacao/itens/:id/consumos", async (request, reply) => {
    if (!exigirCompleto(request, reply)) return;
    return tratar(reply, () => {
      const c = escolher(request.body, ["material", "quantidade", "corId"] as const);
      servico.definirConsumoManual(
        idDe((request.params as { id: string }).id),
        String(c.material),
        c.quantidade as number,
        (c.corId as number | null) ?? null,
        usuarioDe(request)
      );
      return { ok: true };
    });
  });

  app.get("/api/programacao/parametros", async (request, reply) => {
    if (!exigirCompleto(request, reply)) return;
    return servico.parametros();
  });

  app.patch("/api/programacao/parametros", async (request, reply) => {
    if (!exigirCompleto(request, reply)) return;
    return tratar(reply, () => {
      const c = escolher(request.body, ["chave", "valor"] as const);
      return servico.alterarParametro(String(c.chave), c.valor as number, usuarioDe(request));
    });
  });

  app.get("/api/programacao/produtos", async (request, reply) => {
    if (!exigirCompleto(request, reply)) return;
    return servico.produtos();
  });

  app.patch("/api/programacao/produtos/:id", async (request, reply) => {
    if (!exigirCompleto(request, reply)) return;
    return tratar(reply, () => {
      const c = escolher(request.body, ["categoria"] as const);
      return servico.definirCategoriaDoProduto(idDe((request.params as { id: string }).id), String(c.categoria), usuarioDe(request));
    });
  });

  app.put("/api/programacao/cidades-rota", async (request, reply) => {
    if (!exigirCompleto(request, reply)) return;
    return tratar(reply, () => {
      const c = escolher(request.body, ["cidade", "rotaId"] as const);
      return servico.definirRotaDaCidade(String(c.cidade), c.rotaId as number);
    });
  });
}
