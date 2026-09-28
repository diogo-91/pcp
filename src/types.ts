export type FaixaPrazo = "atrasado" | "ate2" | "de3a5" | "normal" | "semdata";

/** Campos que vêm da Nomus, gravados uma única vez quando o pedido entra no banco. */
export interface PedidoNomus {
  nomusId: number;
  numero: number;
  codigoPedido: string;
  clienteId: number | null;
  clienteNome: string;
  telefone: string;
  /** AAAA-MM-DD, ou null quando o pedido não tem data de entrega. */
  prazoEntrega: string | null;
}

/** Campos digitados à mão; a sincronização nunca toca neles. */
export interface Tratativa {
  statusPcp: string;
  atendimento: string;
  responsavel: string;
  acao: string;
  /** AAAA-MM-DD ou null. */
  prazoAcao: string | null;
  acaoStatus: string;
}

/**
 * O que o PCP pode editar. Inclui o prazo de entrega: ele nasce com o valor da Nomus, mas depois é do PCP
 * (a sincronização só inclui pedidos novos e nunca altera um pedido que já está no banco).
 */
export type TratativaPatch = Partial<Tratativa> & { prazoEntrega?: string | null };

/** Linha como está no banco. */
export interface PedidoRow extends PedidoNomus, Tratativa {
  /** Quando o pedido entrou no banco. */
  primeiroVistoEm: string;
  atualizadoManualEm: string | null;
}

/** Linha como o frontend recebe: o alerta de prazo já vem calculado pelo servidor. */
export interface PedidoPcp extends PedidoRow {
  diasParaPrazo: number | null;
  faixa: FaixaPrazo;
  alerta: string;
}

export interface Resumo {
  total: number;
  atrasado: number;
  ate2: number;
  de3a5: number;
  normal: number;
  semdata: number;
}

export interface SyncRun {
  id: number;
  iniciadoEm: string;
  finalizadoEm: string | null;
  gatilho: string;
  status: "executando" | "ok" | "erro";
  /** Pedidos liberados que a Nomus listou nesta rodada (novos + já conhecidos). */
  pedidosLidos: number;
  /** Quantos deles ainda não estavam no banco e foram incluídos. */
  novos: number;
  erro: string | null;
}

export interface SyncStatus {
  executando: boolean;
  ultima: SyncRun | null;
  ultimaComSucesso: SyncRun | null;
}
