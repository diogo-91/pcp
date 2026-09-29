/** Fluxo manual do PCP (mesmos valores da planilha original). */
export const STATUS_PCP = [
  "AGUARDANDO",
  "PEDIDO LIBERADO",
  "EM PRODUÇÃO",
  "EXPEDIÇÃO",
  "ROTA DE ENTREGA",
  "ENCERRADO",
  "CANCELADO",
] as const;

/** Pedidos nesses status saem da tabela, mas continuam gravados no banco. */
export const STATUS_PCP_FINAIS: readonly string[] = ["ENCERRADO", "CANCELADO"];

export const STATUS_PCP_PADRAO = "AGUARDANDO";

/** Sugestões de atendimento; o campo aceita texto livre. A grafia "Aguardado programação" vem da planilha original. */
export const ATENDIMENTO_OPCOES = [
  "Atendimento aberto",
  "Aguardando compras",
  "Aguardado programação",
  "Aguardando produção",
  "Em Analise",
  "Aguardando retorno",
  "Resolvido",
] as const;

export const ACAO_STATUS = ["Pendente", "Em andamento", "Concluída"] as const;

export const ACAO_STATUS_PADRAO = "Pendente";

/** Janelas de alerta em dias corridos: atrasado < 0; "até 2 dias" = 0..2; "3 a 5 dias" = 3..5. */
export const JANELA_ATE_2_DIAS = 2;
export const JANELA_ATE_5_DIAS = 5;

/**
 * Pedido não finalizado com mais de tantos dias corridos de atraso some do painel (dashboard e tabela) por padrão:
 * em geral é pedido antigo represado, nunca encerrado, não uma prioridade real do dia a dia. Continua gravado e
 * pode ser revisto com `?antigos=1` (botão "Mostrar" na tela).
 */
export const JANELA_OCULTAR_ATRASO_DIAS = 90;

export const LIMITES_TEXTO = {
  atendimento: 500,
  responsavel: 100,
  acao: 2000,
} as const;

export const FUSO_HORARIO = "America/Sao_Paulo";
