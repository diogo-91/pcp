import { JANELA_OCULTAR_ATRASO_DIAS, STATUS_PCP_FINAIS } from "./constants";
import { diasEntre, faixaDoPrazo, textoAlerta } from "./prazo";
import type { PedidoPcp, PedidoRow, Problema, Resumo } from "./types";

/**
 * "Pedidos problemáticos": o que pede ação do PCP agora. Um pedido pode ter vários motivos.
 *  - prazo vencido; sem prazo de entrega;
 *  - produção agendada para depois do prazo de entrega;
 *  - vence em até 2 dias e ainda não está programado na produção;
 *  - cadastro da Nomus incompleto (sem telefone ou sem nome do cliente: ninguém consegue avisar o cliente).
 */
export function problemasDoPedido(row: PedidoRow, faixa: string, dias: number | null, producaoAposEntrega: boolean): Problema[] {
  const p: Problema[] = [];
  if (faixa === "atrasado" && dias !== null) p.push({ codigo: "atrasado", texto: `Prazo vencido há ${Math.abs(dias)} dia(s)` });
  if (faixa === "semdata") p.push({ codigo: "sem_prazo", texto: "Sem prazo de entrega" });
  if (producaoAposEntrega) p.push({ codigo: "producao_depois_da_entrega", texto: "Produção programada depois do prazo de entrega" });
  if (faixa === "ate2" && !row.prazoProducao) p.push({ codigo: "vence_sem_producao", texto: "Vence em até 2 dias e não está programado na produção" });
  if (row.telefone.trim() === "") p.push({ codigo: "sem_telefone", texto: "Sem telefone do cliente" });
  if (row.clienteNome.trim() === "") p.push({ codigo: "sem_nome", texto: "Sem nome do cliente" });
  return p;
}

/** Acrescenta a cada pedido o alerta de prazo já calculado, para o frontend só exibir. */
export function montarPedido(row: PedidoRow, hoje: string): PedidoPcp {
  const dias = row.prazoEntrega ? diasEntre(hoje, row.prazoEntrega) : null;
  const faixa = faixaDoPrazo(dias);
  // Datas AAAA-MM-DD comparam certo como texto. Só vale quando as duas existem.
  const producaoAposEntrega = !!row.prazoProducao && !!row.prazoEntrega && row.prazoProducao > row.prazoEntrega;
  return { ...row, diasParaPrazo: dias, faixa, alerta: textoAlerta(faixa, dias), producaoAposEntrega, problemas: problemasDoPedido(row, faixa, dias, producaoAposEntrega) };
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
