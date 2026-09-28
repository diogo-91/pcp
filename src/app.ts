import { createHash, timingSafeEqual } from "node:crypto";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { montarPedido, montarResumo } from "./apresentacao";
import { ACAO_STATUS, ATENDIMENTO_OPCOES, STATUS_PCP, STATUS_PCP_FINAIS } from "./constants";
import { LimitadorPorJanela } from "./limite";
import { hojeEmSaoPaulo } from "./prazo";
import { consultarPedidoPublico } from "./publico";
import type { PcpRepository } from "./repository";
import type { SyncService } from "./sync";
import { validarPatch } from "./validation";

export interface AppDeps {
  repo: PcpRepository;
  sync: SyncService;
  /** Vazio = sem autenticação (uso local). */
  accessToken: string;
  logger?: boolean;
  /** Relógio injetável para os testes. */
  agora?: () => Date;
  /** Consulta pública (site dos clientes). */
  publico?: {
    /** Origens autorizadas a chamar do navegador (CORS). Vazio = qualquer origem (o dado é público e sem credenciais). */
    origens?: string[];
    /** Consultas por visitante numa janela (padrão: 60 por minuto). */
    limite?: { maximo: number; janelaMs: number };
  };
  /** Atrás de proxy (EasyPanel): usa o IP real do visitante, necessário para o limite de consultas. */
  trustProxy?: boolean;
}

const hash = (valor: string) => createHash("sha256").update(valor).digest();

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { repo, sync, accessToken } = deps;
  const agora = deps.agora ?? (() => new Date());
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: deps.trustProxy ?? false });

  // Os dados têm nome e telefone de clientes: com ACCESS_TOKEN definido, toda a API (menos o health) exige o token.
  if (accessToken) {
    const esperado = hash(accessToken);
    app.addHook("onRequest", async (request, reply) => {
      const caminho = request.url.split("?")[0];
      // A consulta pública fica fora da senha de propósito: é o que o site dos clientes chama.
      if (!caminho.startsWith("/api/") || caminho === "/api/health" || caminho.startsWith("/api/publico/")) return;

      const recebido = request.headers["x-pcp-token"];
      const ok = typeof recebido === "string" && timingSafeEqual(hash(recebido), esperado);
      if (!ok) return reply.code(401).send({ erro: "Não autorizado." });
    });
  }

  app.get("/api/health", async () => ({ ok: true }));

  // ---- Consulta pública: o site dos clientes chama esta rota (no lugar do Google Apps Script) ----
  const origensPublicas = deps.publico?.origens ?? [];
  const limitador = new LimitadorPorJanela(
    deps.publico?.limite?.maximo ?? 60,
    deps.publico?.limite?.janelaMs ?? 60_000,
    () => agora().getTime()
  );

  const permitirOrigem = (origem: string | undefined): string | null => {
    if (origensPublicas.length === 0) return "*";
    return origem && origensPublicas.includes(origem) ? origem : null;
  };

  app.options("/api/publico/pedido", async (request, reply) => {
    const origem = permitirOrigem(request.headers.origin);
    if (origem) {
      reply.header("Access-Control-Allow-Origin", origem).header("Access-Control-Allow-Methods", "GET, OPTIONS").header("Vary", "Origin");
    }
    return reply.code(204).send();
  });

  app.get("/api/publico/pedido", async (request, reply) => {
    const origem = permitirOrigem(request.headers.origin);
    if (origem) reply.header("Access-Control-Allow-Origin", origem).header("Vary", "Origin");

    if (!limitador.permitir(request.ip)) {
      return reply
        .code(429)
        .header("Retry-After", "60")
        .send({ success: false, message: "Muitas consultas seguidas. Tente novamente em instantes." });
    }

    // Resultado lógico (encontrou ou não) sempre com HTTP 200, como o script antigo: o site decide a mensagem pelo `success`.
    const { pedido } = request.query as { pedido?: string };
    reply.header("Cache-Control", "no-store");
    return consultarPedidoPublico(repo, pedido);
  });

  app.get("/api/pedidos", async (request) => {
    const { finalizados } = request.query as { finalizados?: string };
    const hoje = hojeEmSaoPaulo(agora());
    const pedidos = repo.listar({ incluirFinalizados: finalizados === "1" }).map((row) => montarPedido(row, hoje));

    return {
      hoje,
      pedidos,
      resumo: montarResumo(pedidos),
      opcoes: {
        statusPcp: STATUS_PCP,
        atendimento: ATENDIMENTO_OPCOES,
        acaoStatus: ACAO_STATUS,
        finais: STATUS_PCP_FINAIS,
      },
      sync: sync.status(),
    };
  });

  app.patch("/api/pedidos/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ erro: "Id inválido." });

    const validacao = validarPatch(request.body);
    if (!validacao.ok) return reply.code(400).send({ erro: validacao.erro });

    const atualizado = repo.atualizarTratativa(id, validacao.patch, agora().toISOString());
    if (!atualizado) return reply.code(404).send({ erro: "Pedido não encontrado." });

    return montarPedido(atualizado, hojeEmSaoPaulo(agora()));
  });

  app.get("/api/sync", async () => sync.status());

  // Dispara a sincronização em segundo plano (pode levar minutos por causa do rate limit da Nomus).
  app.post("/api/sync", async (_request, reply) => {
    const jaExecutando = sync.executando();
    if (!jaExecutando) void sync.executar("manual");
    return reply.code(202).send({ executando: true, jaEstavaExecutando: jaExecutando });
  });

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL("../public", import.meta.url)),
  });

  return app;
}
