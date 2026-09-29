import { JANELA_OCULTAR_ATRASO_DIAS, STATUS_PCP_FINAIS } from "./constants";
import { diasEntre, faixaDoPrazo, textoAlerta } from "./prazo";
import type { PedidoPcp, PedidoRow, Resumo } from "./types";

/** Acrescenta a cada pedido o alerta de prazo já calculado, para o frontend só exibir. */
export function montarPedido(row: PedidoRow, hoje: string): PedidoPcp {
  const dias = row.prazoEntrega ? diasEntre(hoje, row.prazoEntrega) : null;
  const faixa = faixaDoPrazo(dias);
  return { ...row, diasParaPrazo: dias, faixa, alerta: textoAlerta(faixa, dias) };
}

/** Contagem por PEDIDO (a planilha antiga contava linhas, então cada pedido aparecia em dobro). */
export function montarResumo(pedidos: PedidoPcp[]): Resumo {
  const resumo: Resumo = { total: pedidos.length, atrasado: 0, ate2: 0, de3a5: 0, normal: 0, semdata: 0 };
  for (const p of pedidos) resumo[p.faixa] += 1;
  return resumo;
}

/**
 * Separa os pedidos não finalizados com mais de `limiteDias` de atraso: é o que some do painel por padrão
 * (dashboard e tabela). Um pedido ENCERRADO/CANCELADO nunca é "oculto" por aqui — ele já sai da tela pelo status.
 */
export function separarMuitoAtrasados(
  pedidos: PedidoPcp[],
  limiteDias: number = JANELA_OCULTAR_ATRASO_DIAS
): { visiveis: PedidoPcp[]; ocultos: PedidoPcp[] } {
  const visiveis: PedidoPcp[] = [];
  const ocultos: PedidoPcp[] = [];

  for (const p of pedidos) {
    const muitoAtrasado = p.diasParaPrazo !== null && p.diasParaPrazo < -limiteDias;
    const finalizado = STATUS_PCP_FINAIS.includes(p.statusPcp);
    (muitoAtrasado && !finalizado ? ocultos : visiveis).push(p);
  }

  return { visiveis, ocultos };
}
