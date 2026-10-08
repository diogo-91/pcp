/** Situação de produção de um item (substitui as 21 grafias livres da planilha). */
export const SITUACOES = [
  "AGUARDANDO_LIBERACAO",
  "PROGRAMAR",
  "PROGRAMADO",
  "PROCESSO",
  "COLA",
  "PINTURA",
  "PRODUZIDO_PARCIAL",
  "PRODUZIDO",
  "EXPEDICAO",
  "EM_TRANSITO",
  "ENTREGUE",
  "CANCELADO",
  "DEVOLUCAO",
  "NAO_PROGRAMAR",
  "VERIFICAR",
  "REVENDA",
  "COMPRAR",
  "COMPRADO",
] as const;
export type Situacao = (typeof SITUACOES)[number];

export const SITUACAO_ROTULO: Record<Situacao, string> = {
  AGUARDANDO_LIBERACAO: "Aguardando liberação",
  PROGRAMAR: "Programar",
  PROGRAMADO: "Programado",
  PROCESSO: "Processo",
  COLA: "Cola",
  PINTURA: "Pintura",
  PRODUZIDO_PARCIAL: "Produzido parcial",
  PRODUZIDO: "Produzido",
  EXPEDICAO: "Expedição",
  EM_TRANSITO: "Em trânsito",
  ENTREGUE: "Entregue",
  CANCELADO: "Cancelado",
  DEVOLUCAO: "Devolução",
  NAO_PROGRAMAR: "Não programar",
  VERIFICAR: "Verificar",
  REVENDA: "Revenda",
  COMPRAR: "Comprar",
  COMPRADO: "Comprado",
};

export type GrupoSituacao = "aberto" | "producao" | "pronto" | "encerrado" | "bloqueado" | "revenda";

export const SITUACAO_GRUPO: Record<Situacao, GrupoSituacao> = {
  AGUARDANDO_LIBERACAO: "aberto",
  PROGRAMAR: "aberto",
  PROGRAMADO: "aberto",
  PROCESSO: "producao",
  COLA: "producao",
  PINTURA: "producao",
  PRODUZIDO_PARCIAL: "producao",
  PRODUZIDO: "pronto",
  EXPEDICAO: "pronto",
  EM_TRANSITO: "pronto",
  ENTREGUE: "encerrado",
  CANCELADO: "encerrado",
  DEVOLUCAO: "encerrado",
  NAO_PROGRAMAR: "bloqueado",
  VERIFICAR: "bloqueado",
  REVENDA: "revenda",
  COMPRAR: "revenda",
  COMPRADO: "revenda",
};

/** Cancelado e devolução nunca entram em totais, indicadores ou contagens (padrão). */
export const SITUACOES_EXCLUIDAS_DOS_TOTAIS: readonly Situacao[] = ["CANCELADO", "DEVOLUCAO"];
/** Já saiu da fábrica ou foi encerrado: não está "em aberto". */
export const SITUACOES_ENCERRADAS: readonly Situacao[] = ["ENTREGUE", "CANCELADO", "DEVOLUCAO"];
/** Daqui em diante o item está produzido: consumos ficam congelados e a mudança de medidas vira alerta. */
export const SITUACOES_PRODUZIDAS: readonly Situacao[] = ["PRODUZIDO", "EXPEDICAO", "EM_TRANSITO", "ENTREGUE"];
/** Daqui em diante uma mudança do ERP é relevante ("pedido alterado no ERP após programação"). */
export const SITUACOES_PROGRAMADAS_OU_ALEM: readonly Situacao[] = [
  "PROGRAMADO",
  "PROCESSO",
  "COLA",
  "PINTURA",
  "PRODUZIDO_PARCIAL",
  "PRODUZIDO",
  "EXPEDICAO",
  "EM_TRANSITO",
  "ENTREGUE",
];

export const SITUACAO_INICIAL: Situacao = "PROGRAMAR";

export const CATEGORIAS = [
  "SANDUICHE",
  "SEMI_SANDUICHE",
  "SIMPLES",
  "FORRO_AMADEIRADO_CLARO",
  "FORRO_AMADEIRADO_ESCURO",
  "FORRO_BRANCO",
  "FORRO_METALICO",
  "FORRO_PVC",
  "CALHA_RUFO_PINGADEIRA",
  "CUMIEIRA",
  "ACABAMENTO",
  "VIGA",
  "PARAFUSO",
  "EPS",
  "TRANSLUCIDA",
  "BOBINA",
  "REFILO_BOBINA",
  "PINTURA_TERCEIRO",
  "PORTA_METALICA",
  "OUTROS",
] as const;
export type Categoria = (typeof CATEGORIAS)[number];

export const CATEGORIA_ROTULO: Record<Categoria, string> = {
  SANDUICHE: "Sanduíche",
  SEMI_SANDUICHE: "Semi-sanduíche",
  SIMPLES: "Simples",
  FORRO_AMADEIRADO_CLARO: "Forro amadeirado claro",
  FORRO_AMADEIRADO_ESCURO: "Forro amadeirado escuro",
  FORRO_BRANCO: "Forro branco",
  FORRO_METALICO: "Forro metálico",
  FORRO_PVC: "Forro PVC",
  CALHA_RUFO_PINGADEIRA: "Calha / rufo / pingadeira",
  CUMIEIRA: "Cumieira",
  ACABAMENTO: "Acabamento",
  VIGA: "Viga",
  PARAFUSO: "Parafuso",
  EPS: "EPS",
  TRANSLUCIDA: "Translúcida",
  BOBINA: "Bobina",
  REFILO_BOBINA: "Refilo de bobina",
  PINTURA_TERCEIRO: "Pintura (terceiro)",
  PORTA_METALICA: "Porta metálica",
  OUTROS: "Outros",
};

export const TIPOS_PINTURA = ["PINTURA", "SEM_PINTURA", "PRE_PINTADA"] as const;
export type TipoPintura = (typeof TIPOS_PINTURA)[number];

export const TRAPEZIOS = ["TR25", "TR40"] as const;
export type Trapezio = (typeof TRAPEZIOS)[number];

/** Categorias cujo metro de telha (e, portanto, chapa/EPS) tem sentido. */
export const CATEGORIAS_DE_TELHA: readonly Categoria[] = [
  "SANDUICHE",
  "SEMI_SANDUICHE",
  "SIMPLES",
  "FORRO_AMADEIRADO_CLARO",
  "FORRO_AMADEIRADO_ESCURO",
  "FORRO_BRANCO",
  "FORRO_METALICO",
];

export const CATEGORIAS_COM_EPS: readonly Categoria[] = ["SANDUICHE", "SEMI_SANDUICHE"];

/** Rotas de entrega (seed). O de-para cidade → rota é preenchido pela planilha (aba Rotas) ou pela própria tela. */
export const ROTAS_INICIAIS: Array<[number, string]> = [
  [1, "Sorocaba e entorno"],
  [2, "Piedade / Pilar do Sul"],
  [3, "Tatuí / Itapetininga / Sudoeste"],
  [4, "Porto Feliz / Itu"],
  [5, "São Roque / Alumínio"],
  [6, "Jundiaí"],
  [7, "Campinas / entorno"],
  [8, "Limeira / Rio Claro / Piracicaba"],
  [9, "Bragança / Sul de Minas"],
  [10, "Grande SP Oeste"],
  [11, "Grande SP Norte"],
  [12, "Grande SP Leste"],
  [13, "Grande SP Sul / ABC"],
  [14, "Baixada Santista"],
  [15, "Vale do Ribeira"],
  [16, "Interior distante"],
  [17, "Interior distante / Nordeste"],
  [18, "Vale do Paraíba / Litoral Norte"],
  [19, "Rio de Janeiro"],
  [20, "Noroeste Paulista / S. J. Rio Preto"],
  [21, "Ribeirão Preto / Nordeste Central"],
  [22, "Franca / Alta Mogiana"],
  [23, "Oeste Paulista"],
];

/**
 * Cores (tintas). `palavras` são frases em minúsculas e sem acento: a cor com a frase mais específica que aparece no
 * texto do item vence (ex.: "preto brilhante" ganha de "preto"). Texto só com a família ("preto") cai na primeira da família.
 */
export const CORES_INICIAIS: Array<{ nome: string; ral: string; palavras: string[] }> = [
  { nome: "Branco brilhante RAL 9003", ral: "9003", palavras: ["branco brilhante", "branco", "ral 9003"] },
  { nome: "Preto fosco", ral: "", palavras: ["preto fosco", "preto"] },
  { nome: "Preto brilhante RAL 9005", ral: "9005", palavras: ["preto brilhante", "ral 9005"] },
  { nome: "Preto semi-brilho RAL PSN 001", ral: "", palavras: ["preto semi", "psn 001"] },
  { nome: "Cerâmica RAL 8023", ral: "8023", palavras: ["ceramica", "ral 8023"] },
  { nome: "Cinza claro PCS 20723 RAL 7035 PBL016", ral: "7035", palavras: ["cinza claro", "ral 7035", "pbl016"] },
  { nome: "Laranja tráfego RAL PSL 10610", ral: "", palavras: ["laranja", "psl 10610"] },
  { nome: "Cinza prata / semi-fosco FSW010", ral: "", palavras: ["cinza prata", "prata", "fsw010"] },
  { nome: "Cinza brilhante Munsel PCS 10035 RAL 7042 (PBL030)", ral: "7042", palavras: ["cinza brilhante", "ral 7042", "pbl030"] },
  { nome: "Cinza / grafite fosco PCS10040 RAL 7024", ral: "7024", palavras: ["grafite", "cinza fosco", "cinza", "ral 7024"] },
  { nome: "Cinza janela RAL 7040", ral: "7040", palavras: ["cinza janela", "ral 7040"] },
  { nome: "Aço corten", ral: "", palavras: ["corten", "cortem"] },
  { nome: "Marrom fosco RAL 8014", ral: "8014", palavras: ["marrom fosco", "marrom", "ral 8014"] },
  { nome: "Marrom sépia brilho PMS 10438 RAL 8014", ral: "8014", palavras: ["marrom sepia", "sepia"] },
  { nome: "Marrom castanho PMS 10437 RAL 8015", ral: "8015", palavras: ["castanho", "ral 8015"] },
  { nome: "Bege RAL 1015", ral: "1015", palavras: ["bege", "ral 1015"] },
  { nome: "Azul Del Rey PAS 10015", ral: "", palavras: ["azul del rey", "del rey"] },
  { nome: "Azul claro brilho PAS 20529 PBJ035", ral: "", palavras: ["azul claro"] },
  { nome: "Azul brilhante PAS10016 PBJ125", ral: "", palavras: ["azul brilhante", "azul"] },
  { nome: "Azul semi-brilho PAS11006", ral: "", palavras: ["azul semi"] },
  { nome: "Amarelo brilhante PRS10012", ral: "", palavras: ["amarelo"] },
  { nome: "Vermelha 10005", ral: "", palavras: ["vermelho", "vermelha"] },
  { nome: "Verde escuro PDS 10005 RAL 6005", ral: "6005", palavras: ["verde escuro", "ral 6005"] },
  { nome: "Verde claro RAL 6002", ral: "6002", palavras: ["verde claro", "ral 6002"] },
  { nome: "Verde folha brilhante PDS10002", ral: "", palavras: ["verde folha", "verde"] },
  { nome: "Verde esmeralda PGS10602", ral: "", palavras: ["esmeralda"] },
  { nome: "Vermelho carmim RAL 3002", ral: "3002", palavras: ["carmim", "ral 3002"] },
];

/**
 * Cidades que o próprio nome da rota cita. É só um começo: a lista completa (196 cidades) vem da aba "Rotas" da planilha
 * (importação) ou da tela. Tudo é editável e o que a equipe corrigir nunca é sobrescrito.
 */
export const CIDADES_INICIAIS: Array<[string, number]> = [
  ["Sorocaba-SP", 1], ["Piedade-SP", 2], ["Pilar do Sul-SP", 2], ["Tatuí-SP", 3], ["Itapetininga-SP", 3], ["Porto Feliz-SP", 4],
  ["Itu-SP", 4], ["São Roque-SP", 5], ["Alumínio-SP", 5], ["Jundiaí-SP", 6], ["Campinas-SP", 7], ["Limeira-SP", 8], ["Rio Claro-SP", 8],
  ["Piracicaba-SP", 8], ["Bragança Paulista-SP", 9], ["Santos-SP", 14], ["Rio de Janeiro-RJ", 19], ["São José do Rio Preto-SP", 20],
  ["Ribeirão Preto-SP", 21], ["Franca-SP", 22],
];

export type UnidadeMaterial = "kg" | "m" | "un";

/** Catálogo de materiais: bobina/EPS/cola/tinta são calculados; o resto é lançado à mão (ou vem da Nomus, se um dia vier). */
export const MATERIAIS_INICIAIS: Array<{ codigo: string; nome: string; unidade: UnidadeMaterial; grupo: string }> = [
  { codigo: "bobina", nome: "Bobina", unidade: "kg", grupo: "base" },
  { codigo: "eps", nome: "EPS", unidade: "m", grupo: "base" },
  { codigo: "cola", nome: "Cola", unidade: "kg", grupo: "base" },
  { codigo: "tinta", nome: "Tinta", unidade: "kg", grupo: "base" },
  ...[
    "12x4 auto-brocante",
    "12x4 madeira",
    '12x3" auto-brocante',
    '12x3" madeira',
    'costura 7/8" auto-brocante',
    '12x2 1/2" auto-brocante',
    '12x1 1/2" auto-brocante',
    '12x2 3/4" auto-brocante',
    '12x2" auto-brocante',
    '12x3/4" auto-brocante',
    '12x3/4" madeira',
    '12x4 3/4" madeira',
    '12x2 3/4" madeira',
  ].map((nome, i) => ({ codigo: `parafuso_${i + 1}`, nome: `Parafuso ${nome}`, unidade: "un" as const, grupo: "parafusos" })),
  { codigo: "eps_forro_pir", nome: "EPS / Forro PIR", unidade: "m", grupo: "componentes" },
  { codigo: "forro_chapa", nome: "Forro chapa metálica", unidade: "m", grupo: "componentes" },
  { codigo: "forro_pvc", nome: "Forro PVC", unidade: "m", grupo: "componentes" },
  { codigo: "translucida", nome: "Translúcida", unidade: "m", grupo: "componentes" },
  { codigo: "viga_u", nome: "Viga U", unidade: "m", grupo: "componentes" },
  { codigo: "metalon", nome: "Metalon", unidade: "m", grupo: "componentes" },
];

/** Parâmetros editáveis por quem administra. Ver as perguntas abertas no README antes de mudar os valores. */
export const PARAMETROS_INICIAIS: Array<{ chave: string; valor: number; descricao: string }> = [
  { chave: "bobina_kg_por_metro", valor: 3.6, descricao: "Kg de bobina por metro de chapa (coeficiente da planilha)." },
  { chave: "densidade_aco_kg_m3", valor: 7850, descricao: "Densidade do aço (referência: aba Cálculo de peso)." },
  { chave: "largura_bobina_m", valor: 1.2, descricao: "Largura útil da bobina em metros (referência)." },
  { chave: "fator_chapa_sanduiche", valor: 2, descricao: "Metros de chapa por metro de telha sanduíche (duas chapas). Pergunta aberta 11.1." },
  { chave: "cola_kg_por_metro_eps", valor: 0.2, descricao: "Kg de cola por metro de EPS (200 g/m)." },
  { chave: "tinta_kg_por_metro_face", valor: 0.2, descricao: "Kg de tinta por metro pintado, por face (1 kg pinta 5 m)." },
  { chave: "capacidade_m_dia", valor: 2000, descricao: "Capacidade da fábrica em metros por dia útil (pergunta aberta 11.2)." },
  { chave: "dias_vence_em_breve", valor: 3, descricao: "Quantos dias antes do prazo o item aparece como 'vence em breve'." },
];
