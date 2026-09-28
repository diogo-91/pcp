import { ACAO_STATUS, LIMITES_TEXTO, STATUS_PCP } from "./constants";
import { isDataPlausivel } from "./prazo";
import type { PcpRepository } from "./repository";
import type { HistoricoRow, PedidoRow, TratativaPatch } from "./types";

/** Formato do backup em JSON (exportar/importar). Serve para mover os dados entre bancos, ex.: do local para a produção. */
export interface ArquivoMigracao {
  versao: 1;
  exportadoEm: string;
  pedidos: PedidoRow[];
  /** Pedidos antigos (só para a consulta pública). Opcional: arquivos antigos não têm. */
  historico?: HistoricoRow[];
}

export interface ResultadoImportacao {
  inseridos: number;
  atualizados: number;
  jaExistiam: number;
  /** Pedidos do histórico inseridos (os que já existiam são ignorados). */
  historico: number;
}

export function exportar(repo: PcpRepository, agora: string): ArquivoMigracao {
  return { versao: 1, exportadoEm: agora, pedidos: repo.listar({ incluirFinalizados: true }), historico: repo.listarHistorico() };
}

const texto = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const dataOuNula = (v: unknown) => v === null || (typeof v === "string" && isDataPlausivel(v));

/** Devolve o motivo se o pedido do arquivo é inválido, ou null se está tudo certo. */
function motivoInvalido(p: unknown): string | null {
  if (typeof p !== "object" || p === null) return "não é um objeto";
  const x = p as Record<string, unknown>;

  if (!Number.isInteger(x.nomusId)) return "nomusId inválido";
  if (!Number.isInteger(x.numero)) return "numero inválido";
  if (typeof x.codigoPedido !== "string" || x.codigoPedido === "") return "codigoPedido inválido";
  if (!(x.clienteId === null || Number.isInteger(x.clienteId))) return "clienteId inválido";
  if (!texto(x.clienteNome, 300) || !texto(x.telefone, 100)) return "cliente/telefone inválido";
  if (!dataOuNula(x.prazoEntrega)) return "prazoEntrega inválido";
  if (typeof x.primeiroVistoEm !== "string" || Number.isNaN(Date.parse(x.primeiroVistoEm))) return "primeiroVistoEm inválido";
  if (!(x.atualizadoManualEm === null || typeof x.atualizadoManualEm === "string")) return "atualizadoManualEm inválido";
  if (!(STATUS_PCP as readonly unknown[]).includes(x.statusPcp)) return `statusPcp inválido (${String(x.statusPcp)})`;
  if (!(ACAO_STATUS as readonly unknown[]).includes(x.acaoStatus)) return `acaoStatus inválido (${String(x.acaoStatus)})`;
  if (!texto(x.atendimento, LIMITES_TEXTO.atendimento)) return "atendimento inválido";
  if (!texto(x.responsavel, LIMITES_TEXTO.responsavel)) return "responsavel inválido";
  if (!texto(x.acao, LIMITES_TEXTO.acao)) return "acao inválida";
  if (!dataOuNula(x.prazoAcao)) return "prazoAcao inválido";
  return null;
}

function motivoHistoricoInvalido(h: unknown): string | null {
  if (typeof h !== "object" || h === null) return "não é um objeto";
  const x = h as Record<string, unknown>;
  if (!Number.isInteger(x.numero) || (x.numero as number) <= 0) return "numero inválido";
  if (!(STATUS_PCP as readonly unknown[]).includes(x.statusPcp)) return `statusPcp inválido (${String(x.statusPcp)})`;
  if (!dataOuNula(x.prazoEntrega)) return "prazoEntrega inválido";
  if (typeof x.origem !== "string" || x.origem === "") return "origem inválida";
  if (typeof x.importadoEm !== "string" || Number.isNaN(Date.parse(x.importadoEm))) return "importadoEm inválido";
  return null;
}

/**
 * Importa o backup. Regras:
 *  - o arquivo é validado INTEIRO antes de gravar qualquer coisa (um erro aborta tudo);
 *  - nunca apaga nada (pedido que não está no arquivo fica como está);
 *  - pedido que já existe só é alterado com `atualizar`, e então SÓ nos campos editáveis
 *    (status, prazo, atendimento, responsável, ação...): nome, telefone e código nunca mudam.
 */
export function importar(repo: PcpRepository, dados: unknown, opcoes: { atualizar: boolean; agora: string }): ResultadoImportacao {
  if (typeof dados !== "object" || dados === null) throw new Error("Arquivo inválido: não é um JSON de backup.");
  const arquivo = dados as { versao?: unknown; pedidos?: unknown; historico?: unknown };
  if (arquivo.versao !== 1) throw new Error(`Arquivo inválido: versão ${String(arquivo.versao)} não suportada (esperado 1).`);
  if (!Array.isArray(arquivo.pedidos)) throw new Error("Arquivo inválido: falta a lista de pedidos.");

  if (arquivo.historico !== undefined && !Array.isArray(arquivo.historico)) throw new Error("Arquivo inválido: o histórico deve ser uma lista.");

  const invalidos = [
    ...arquivo.pedidos.map((p, i) => ({ nome: `pedido #${i + 1}`, motivo: motivoInvalido(p) })),
    ...(arquivo.historico ?? []).map((h, i) => ({ nome: `histórico #${i + 1}`, motivo: motivoHistoricoInvalido(h) })),
  ]
    .filter((r) => r.motivo !== null)
    .slice(0, 5)
    .map((r) => `${r.nome}: ${r.motivo}`);
  if (invalidos.length > 0) throw new Error(`Arquivo inválido, nada foi importado. ${invalidos.join("; ")}`);

  const pedidos = arquivo.pedidos as PedidoRow[];
  const resultado: ResultadoImportacao = { inseridos: 0, atualizados: 0, jaExistiam: 0, historico: 0 };

  repo.transacao(() => {
    for (const h of (arquivo.historico ?? []) as HistoricoRow[]) {
      if (repo.restaurarHistorico(h)) resultado.historico++;
    }

    for (const p of pedidos) {
      const atual = repo.buscar(p.nomusId);

      if (!atual) {
        repo.restaurarPedido(p);
        resultado.inseridos++;
        continue;
      }
      if (!opcoes.atualizar) {
        resultado.jaExistiam++;
        continue;
      }

      const novos: TratativaPatch = {
        statusPcp: p.statusPcp,
        prazoEntrega: p.prazoEntrega,
        atendimento: p.atendimento,
        responsavel: p.responsavel,
        acao: p.acao,
        prazoAcao: p.prazoAcao,
        acaoStatus: p.acaoStatus,
      };
      const mudou = (Object.keys(novos) as Array<keyof TratativaPatch>).some(
        (k) => (atual as unknown as Record<string, unknown>)[k] !== novos[k]
      );
      if (mudou) {
        repo.atualizarTratativa(p.nomusId, novos, opcoes.agora);
        resultado.atualizados++;
      } else {
        resultado.jaExistiam++;
      }
    }
  });

  return resultado;
}
