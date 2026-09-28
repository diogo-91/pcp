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
