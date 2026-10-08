import { createHash, timingSafeEqual } from "node:crypto";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { montarPedido, montarResumo, separarMuitoAtrasados } from "./apresentacao";
import { ACAO_STATUS, ATENDIMENTO_OPCOES, STATUS_PCP, STATUS_PCP_FINAIS } from "./constants";
import { LimitadorPorJanela } from "./limite";
import { paginaInicial } from "./pagina";
import { registrarProgramacao } from "./programacao/http";
import type { ProgramacaoService } from "./programacao/service";
import type { PlanejamentoService } from "./planejamento";
import { hojeEmSaoPaulo } from "./prazo";
import { consultarPedidoPublico } from "./publico";
import type { PcpRepository } from "./repository";
import type { SyncService } from "./sync";
import { validarPatch } from "./validation";

export interface AppDeps {
  repo: PcpRepository;
  sync: SyncService;
  /** Leitura da programação da produção (Planejamento do apontamento). Opcional: sem ele a coluna fica "não programado". */
  planejamento?: PlanejamentoService;
  /** Módulo Programação de Produção (opcional). */
  programacao?: ProgramacaoService;
  /** "Sincronizar este pedido" na gaveta da Programação: busca o pedido na Nomus e atualiza só ele. */
  sincronizarPedidoProgramacao?: (nomusPedidoId: number) => Promise<unknown>;
  /** Importação do histórico da planilha (upload do .xlsx na tela de configurações). */
  importarPlanilhaProgramacao?: (arquivo: Buffer, opcoes: { gravar: boolean; forcar: boolean }) => unknown;
  /** Agenda, painel, compras de terceiros, parafusos e calculadora (módulo Programação). */
  extrasProgramacao?: import("./programacao/extras").ExtrasService;
  /** Vazio = sem autenticação (uso local). */
  accessToken: string;
  /** Segundo código, de perfil "consulta": só lê a Programação, sem telefone de clientes e sem editar. Vazio = não existe. */
  accessTokenConsulta?: string;
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
  /**
   * Quantos proxies confiáveis ficam na frente do app (0 = nenhum). Só o IP anotado por eles vale para o limite de
   * consultas; o que o visitante escreve em X-Forwarded-For é ignorado (ele pode inventar esse valor).
   */
  trustProxyHops?: number;
}

/**
 * Confia nos primeiros `hops` servidores da cadeia (o que está colado no app é o de índice 0): o IP do visitante é o
 * primeiro endereço que NÃO é de um proxy confiável, ou seja, o que o último proxy confiável anotou. Endereços que o
 * visitante escreve em X-Forwarded-For ficam para trás e nunca são usados.
 */
const confiarNosProxies = (hops: number) => (hops > 0 ? (_endereco: string, indice: number) => indice < hops : false);

const hash = (valor: string) => createHash("sha256").update(valor).digest();

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { repo, sync, planejamento, accessToken } = deps;
  const agora = deps.agora ?? (() => new Date());
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: confiarNosProxies(deps.trustProxyHops ?? 0) });

  // Os dados têm nome e telefone de clientes: com ACCESS_TOKEN definido, toda a API (menos o health) exige o token.
  // Um segundo código (ACCESS_TOKEN_CONSULTA) dá o perfil "consulta": só lê a Programação, sem telefone e sem editar.
  if (accessToken) {
    const esperado = hash(accessToken);
    const esperadoConsulta = deps.accessTokenConsulta ? hash(deps.accessTokenConsulta) : null;
    app.addHook("onRequest", async (request, reply) => {
      const caminho = request.url.split("?")[0];
      // A consulta pública fica fora da senha de propósito: é o que o site dos clientes chama.
      if (!caminho.startsWith("/api/") || caminho === "/api/health" || caminho.startsWith("/api/publico/")) return;

      const recebido = request.headers["x-pcp-token"];
      if (typeof recebido === "string" && timingSafeEqual(hash(recebido), esperado)) return;

      if (esperadoConsulta && typeof recebido === "string" && timingSafeEqual(hash(recebido), esperadoConsulta)) {
        request.perfil = "consulta";
        if (request.method !== "GET" || !caminho.startsWith("/api/programacao")) {
          return reply.code(403).send({ erro: "Seu acesso é somente leitura (Programação)." });
        }
        return;
      }
      return reply.code(401).send({ erro: "Não autorizado." });
    });
  }

  if (deps.programacao) registrarProgramacao(app, deps.programacao, deps.sincronizarPedidoProgramacao, deps.importarPlanilhaProgramacao, deps.extrasProgramacao);
  else app.decorateRequest("perfil", "completo");

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
    const { finalizados, antigos } = request.query as { finalizados?: string; antigos?: string };
    const hoje = hojeEmSaoPaulo(agora());
    const todos = repo.listar({ incluirFinalizados: finalizados === "1" }).map((row) => montarPedido(row, hoje));

    // Por padrão, pedido muito atrasado (90+ dias) some do painel: ?antigos=1 traz de volta pra quem precisar.
    const { visiveis, ocultos } = separarMuitoAtrasados(todos);
    const pedidos = antigos === "1" ? todos : visiveis;

    return {
      hoje,
      pedidos,
      ocultosMuitoAtrasados: ocultos.length,
      resumo: montarResumo(pedidos),
      opcoes: {
        statusPcp: STATUS_PCP,
        atendimento: ATENDIMENTO_OPCOES,
        acaoStatus: ACAO_STATUS,
        finais: STATUS_PCP_FINAIS,
      },
      sync: sync.status(),
      planejamento: planejamento?.status() ?? { configurado: false, ultimaTentativa: null, ultimoSucesso: null, erro: null, pedidosProgramados: 0 },
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
    void planejamento?.executar(); // roda em segundo plano (~13 s): o clique também atualiza as datas de produção
    return reply.code(202).send({ executando: true, jaEstavaExecutando: jaExecutando });
  });

  const pastaPublica = fileURLToPath(new URL("../public", import.meta.url));

  // A página inicial sai por aqui (não pelo servidor de arquivos) para pedir cada arquivo da tela com um código de
  // versão: ver pagina.ts. `no-cache` obriga o navegador a revalidar o HTML, então ele nunca fica preso a uma versão velha.
  const enviarPagina = async (_request: unknown, reply: import("fastify").FastifyReply) =>
    reply.header("Cache-Control", "no-cache").type("text/html; charset=utf-8").send(paginaInicial(pastaPublica));
  app.get("/", enviarPagina);
  app.get("/index.html", enviarPagina);

  await app.register(fastifyStatic, { root: pastaPublica, index: false });

  return app;
}
