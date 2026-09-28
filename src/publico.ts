import type { PcpRepository } from "./repository";

/**
 * Resposta da consulta pública. É o MESMO formato que o Google Apps Script devolvia ao site
 * (`{ success, pedido, status, prazo }` ou `{ success: false, message }`), para o site só precisar trocar a URL.
 *
 * Por ser aberta ao público, expõe SOMENTE o número, o status e o prazo do pedido: nunca nome, telefone,
 * atendimento nem qualquer outro dado interno.
 */
export interface RespostaPublica {
  success: boolean;
  message?: string;
  pedido?: string;
  status?: string;
  /** dd/mm/aaaa, ou vazio quando o pedido não tem prazo (o site mostra "Em definição"). */
  prazo?: string;
}

const MSG_INVALIDO = "Informe um número de pedido válido.";
const MSG_NAO_ENCONTRADO = "Confira o número do pedido informado.";

/** "2026-11-01" -> "01/11/2026". */
export function isoParaBr(iso: string | null): string {
  if (!iso) return "";
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

export function consultarPedidoPublico(repo: PcpRepository, entrada: unknown): RespostaPublica {
  // Mesma regra do script antigo: só os dígitos contam ("PD 01978" e "1978" são o mesmo pedido).
  const digitos = String(typeof entrada === "string" || typeof entrada === "number" ? entrada : "").replace(/\D/g, "");
  if (!digitos) return { success: false, message: MSG_INVALIDO };

  // Números absurdos (muito longos) não existem: recusa sem consultar o banco.
  if (digitos.length > 9) return { success: false, message: MSG_NAO_ENCONTRADO };
  const numero = Number(digitos);
  if (numero <= 0) return { success: false, message: MSG_NAO_ENCONTRADO };

  const pedido = repo.buscarPorNumero(numero);
  if (pedido) {
    return { success: true, pedido: String(numero), status: pedido.statusPcp || "Em acompanhamento", prazo: isoParaBr(pedido.prazoEntrega) };
  }

  const antigo = repo.buscarHistorico(numero);
  if (antigo) {
    return { success: true, pedido: String(numero), status: antigo.statusPcp || "Em acompanhamento", prazo: isoParaBr(antigo.prazoEntrega) };
  }

  return { success: false, message: MSG_NAO_ENCONTRADO };
}
