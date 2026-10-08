import { diasEntre, isDataPlausivel } from "../prazo";
import {
  CATEGORIAS_COM_EPS,
  CATEGORIAS_DE_TELHA,
  CORES_INICIAIS,
  SITUACAO_GRUPO,
  SITUACOES,
  type Categoria,
  type Situacao,
  type TipoPintura,
  type Trapezio,
} from "./enums";

// ------------------------------------------------------------------ texto

const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** minúsculas, sem acento, espaços colapsados: base de toda comparação de texto livre. */
export const normalizarTexto = (s: string | null | undefined): string =>
  semAcento(String(s ?? "")).toLowerCase().replace(/\s+/g, " ").trim();

/** "Sorocaba" + "SP" -> "sorocaba-sp": chave do de-para cidade → rota. */
export const chaveCidade = (cidade: string): string => normalizarTexto(cidade).replace(/\s*-\s*/g, "-");

// ------------------------------------------------------------------ situação

/** Grafias da planilha (e variações de digitação) -> valor fechado. Texto desconhecido ("xxx") vira null. */
export function normalizarSituacao(texto: string | null | undefined): Situacao | null {
  const t = normalizarTexto(texto);
  if (t === "") return null;
  if ((SITUACOES as readonly string[]).includes(t.toUpperCase().replace(/ /g, "_"))) return t.toUpperCase().replace(/ /g, "_") as Situacao;

  if (t.startsWith("aguardando liberacao")) return "AGUARDANDO_LIBERACAO";
  if (t.startsWith("programar")) return "PROGRAMAR";
  if (t === "programado") return "PROGRAMADO";
  if (t === "processo") return "PROCESSO";
  if (t === "cola") return "COLA";
  if (t === "pintura") return "PINTURA";
  if (t === "produzido parcial") return "PRODUZIDO_PARCIAL";
  if (t === "produzido") return "PRODUZIDO";
  if (t === "expedicao") return "EXPEDICAO";
  if (t === "em transito" || t === "em rota") return "EM_TRANSITO";
  if (t === "entregue") return "ENTREGUE";
  if (t === "cancelado") return "CANCELADO";
  if (t === "devolucao") return "DEVOLUCAO";
  if (t === "nao programar") return "NAO_PROGRAMAR";
  if (t === "verificar") return "VERIFICAR";
  if (t === "revenda" || /^loja \d/.test(t)) return "REVENDA";
  if (t === "comprar") return "COMPRAR";
  if (t === "comprado") return "COMPRADO";
  return null;
}

/** A situação do pedido é a do item MENOS avançado (na ordem de SITUACOES) entre os que não estão cancelados/devolvidos. */
export function situacaoDoPedido(situacoes: Situacao[]): Situacao | null {
  const vivas = situacoes.filter((s) => s !== "CANCELADO" && s !== "DEVOLUCAO");
  const base = vivas.length > 0 ? vivas : situacoes;
  if (base.length === 0) return null;
  return base.reduce((menor, s) => (SITUACOES.indexOf(s) < SITUACOES.indexOf(menor) ? s : menor));
}

// ------------------------------------------------------------------ prazo (6.1, 6.2, 6.3)

export type CodigoStatusPrazo =
  | "entregue_no_prazo"
  | "entregue_com_atraso"
  | "entregue"
  | "na"
  | "sem_data"
  | "atrasado"
  | "vence_em_breve"
  | "a_vencer";

export interface StatusPrazo {
  codigo: CodigoStatusPrazo;
  /** Atrasado/entregue com atraso: dias de atraso; vence em breve / a vencer: dias que faltam. Senão null. */
  dias: number | null;
  texto: string;
}

export const prazoVigente = (negociada: string | null, original: string | null): string | null => negociada ?? original ?? null;

/**
 * Substitui a coluna "Entrega" da planilha (que marcava tudo como "atraso", inclusive entregue e sem data).
 * Entregue nunca é "atrasado"; sem prazo nunca é "atrasado"; cancelado/devolução não se aplica.
 */
export function statusDePrazo(p: {
  situacao: Situacao;
  prazoVigente: string | null;
  dataEntregaRealizada: string | null;
  hoje: string;
  diasVenceEmBreve?: number;
}): StatusPrazo {
  const { situacao, prazoVigente: prazo, dataEntregaRealizada: entrega, hoje } = p;

  if (situacao === "CANCELADO" || situacao === "DEVOLUCAO") return { codigo: "na", dias: null, texto: "—" };

  if (situacao === "ENTREGUE") {
    if (!entrega || !prazo) return { codigo: "entregue", dias: null, texto: "Entregue" };
    const atraso = diasEntre(prazo, entrega); // entrega - prazo
    return atraso <= 0
      ? { codigo: "entregue_no_prazo", dias: null, texto: "Entregue no prazo" }
      : { codigo: "entregue_com_atraso", dias: atraso, texto: `Entregue com ${atraso} dia(s) de atraso` };
  }

  if (!prazo) return { codigo: "sem_data", dias: null, texto: "Sem data" };

  const faltam = diasEntre(hoje, prazo);
  if (faltam < 0) return { codigo: "atrasado", dias: -faltam, texto: `${-faltam} dia(s) em atraso` };
  if (faltam <= (p.diasVenceEmBreve ?? 3)) {
    return { codigo: "vence_em_breve", dias: faltam, texto: faltam === 0 ? "Vence hoje" : faltam === 1 ? "Vence amanhã" : `Vence em ${faltam} dias` };
  }
  return { codigo: "a_vencer", dias: faltam, texto: `A vencer (${faltam} dias)` };
}

/** Data nula nunca é pronta entrega (a planilha tratava vazio como "menor" e dava 394 falsos positivos). */
export const prontaEntrega = (dataProduzida: string | null, prazo: string | null): boolean =>
  dataProduzida !== null && prazo !== null && dataProduzida < prazo;

export const programadoAntesDoPrazo = (dataProgramacao: string | null, prazo: string | null): boolean =>
  dataProgramacao !== null && prazo !== null && dataProgramacao < prazo;

/** Principal causa de atraso medida na planilha: a produção só foi liberada depois do prazo do cliente. */
export const liberadoAposPrazo = (dataLiberacao: string | null, prazo: string | null): boolean =>
  dataLiberacao !== null && prazo !== null && dataLiberacao > prazo;

/** Mês de referência como AAAA-MM (ordena cronologicamente; a tela formata "out/2026"). */
export const mesDe = (data: string | null): string | null => (data && /^\d{4}-\d{2}/.test(data) ? data.slice(0, 7) : null);

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
export const rotuloMes = (mes: string | null): string => {
  if (!mes) return "";
  const [ano, m] = mes.split("-").map(Number);
  return `${MESES[m - 1]}/${ano}`;
};

// ------------------------------------------------------------------ cronologia e datas (seção 8)

export interface DatasItem {
  dataLiberacaoProducao: string | null;
  dataProduzida: string | null;
  dataEntregaRealizada: string | null;
}

/** liberação <= produzida <= entrega. Devolve a mensagem do primeiro erro, ou null se tudo certo. */
export function validarCronologia(d: DatasItem): string | null {
  const { dataLiberacaoProducao: lib, dataProduzida: prod, dataEntregaRealizada: ent } = d;
  if (lib && prod && prod < lib) return "A data produzida não pode ser anterior à data de liberação da produção.";
  if (prod && ent && ent < prod) return "A data de entrega não pode ser anterior à data produzida.";
  if (lib && ent && ent < lib) return "A data de entrega não pode ser anterior à data de liberação da produção.";
  return null;
}

export const dataValida = (valor: string | null | undefined): boolean => valor === null || valor === undefined || isDataPlausivel(valor);

/** Regras de preenchimento por situação. `hoje` é o padrão da data de entrega. */
export function exigenciasDaSituacao(
  situacao: Situacao,
  d: { dataProduzida: string | null; dataEntregaRealizada: string | null }
): string | null {
  if (situacao === "PRODUZIDO" && !d.dataProduzida) return "Para marcar como Produzido, informe a data produzida.";
  if (situacao === "ENTREGUE" && !d.dataEntregaRealizada) return "Para marcar como Entregue, informe a data de entrega.";
  return null;
}

// ------------------------------------------------------------------ contato e valores

export const normalizarTelefone = (t: string | null | undefined): string => {
  let digitos = String(t ?? "").replace(/\D/g, "");
  if (digitos.startsWith("55") && digitos.length > 11) digitos = digitos.slice(2);
  return digitos;
};

/** (DD) 9XXXX-XXXX ou (DD) XXXX-XXXX; número fora do padrão aparece só com os dígitos. */
export function mascararTelefone(digitos: string): string {
  if (/^\d{11}$/.test(digitos)) return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`;
  if (/^\d{10}$/.test(digitos)) return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 6)}-${digitos.slice(6)}`;
  return digitos;
}

/** "1.452,00" -> 145200 (centavos). Inválido -> null. */
export function reaisParaCentavos(texto: string | null | undefined): number | null {
  const t = String(texto ?? "").trim();
  if (!t) return null;
  const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** "11,5" ou "11.5" -> 11.5 (formato brasileiro: vírgula é o decimal; "1.234,5" tem ponto de milhar). */
export function numeroBR(texto: string | null | undefined): number | null {
  const t = String(texto ?? "").trim();
  if (!t) return null;
  const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------ medidas e metragens (6.4)

export interface Medida {
  qtd: number;
  comprimento_m: number;
}

const arred = (n: number, casas = 2) => Math.round(n * 10 ** casas) / 10 ** casas;

const SEPARADOR_QTD = String.raw`(?:x|×|\*|(?:telhas?|pe[cç]as?|chapas?|unidades?|und?\.?|forros?|barras?|rufos?|calhas?|cumieiras?)\s+(?:de|com))`;
const PADRAO_MEDIDA = new RegExp(String.raw`(\d{1,3})\s*${SEPARADOR_QTD}\s*(\d{1,5}(?:[.,]\d{1,3})?)\s*(mm|m)?`, "gi");

/**
 * Lê as medidas do texto livre do item da Nomus ("11 X 3.000", "4 telhas de 3,50 m", "2x6,20 / 5x3,80").
 * Comprimento acima de 30 é tratado como milímetros. Linhas que não casam são ignoradas (o item fica "sem medidas").
 */
export function parsearMedidas(texto: string | null | undefined): Medida[] {
  const medidas: Medida[] = [];
  const t = String(texto ?? "");
  PADRAO_MEDIDA.lastIndex = 0;

  for (const m of t.matchAll(PADRAO_MEDIDA)) {
    const qtd = Number(m[1]);
    let comprimento = numeroBR(m[2]);
    if (!Number.isFinite(qtd) || qtd <= 0 || comprimento === null || comprimento <= 0) continue;
    if (m[3]?.toLowerCase() === "mm" || comprimento > 30) comprimento /= 1000;
    if (comprimento > 30) continue;
    medidas.push({ qtd, comprimento_m: arred(comprimento, 3) });
  }
  return medidas;
}

export const metrosDeTelha = (medidas: Medida[]): number => arred(medidas.reduce((s, m) => s + m.qtd * m.comprimento_m, 0));

/** Sanduíche usa duas chapas por metro de telha (fator em parâmetro, pergunta aberta 11.1); as demais, uma. */
export function metrosDeChapa(categoria: Categoria, metrosTelha: number, fatorSanduiche = 2): number {
  return categoria === "SANDUICHE" ? arred(metrosTelha * fatorSanduiche) : arred(metrosTelha);
}

// ------------------------------------------------------------------ classificação do produto da Nomus

/** De-para por palavras da descrição do produto da Nomus. O resultado pode ser corrigido na tela (fica gravado). */
export function categoriaPorDescricao(descricao: string | null | undefined): Categoria {
  const t = normalizarTexto(descricao);
  if (/semi[ -]?sanduiche/.test(t)) return "SEMI_SANDUICHE";
  if (/sanduiche/.test(t)) return "SANDUICHE";
  if (/forro/.test(t)) {
    if (/pvc/.test(t)) return "FORRO_PVC";
    if (/amadeirado/.test(t)) return /escuro/.test(t) ? "FORRO_AMADEIRADO_ESCURO" : "FORRO_AMADEIRADO_CLARO";
    if (/branco/.test(t)) return "FORRO_BRANCO";
    return "FORRO_METALICO";
  }
  if (/pintura (eletrostatica|terceir)|terceiriz|drafer|fenix|sorotelha|torre steel|ibi metal/.test(t)) return "PINTURA_TERCEIRO";
  if (/cumieira/.test(t)) return "CUMIEIRA";
  if (/calha|rufo|pingadeira/.test(t)) return "CALHA_RUFO_PINGADEIRA";
  if (/refilo/.test(t)) return "REFILO_BOBINA";
  if (/bobina/.test(t)) return "BOBINA";
  if (/telha simples|simples/.test(t)) return "SIMPLES";
  if (/translucid/.test(t)) return "TRANSLUCIDA";
  if (/parafuso/.test(t)) return "PARAFUSO";
  if (/\beps\b|isopor/.test(t)) return "EPS";
  if (/\bviga\b/.test(t)) return "VIGA";
  if (/porta/.test(t)) return "PORTA_METALICA";
  if (/acabamento|cantoneira|chapeu|arremate|tampa/.test(t)) return "ACABAMENTO";
  return "OUTROS";
}

export function trapezioPorTexto(texto: string | null | undefined): Trapezio | null {
  const t = normalizarTexto(texto);
  if (/\btr ?40\b/.test(t)) return "TR40";
  if (/\btr ?25\b/.test(t)) return "TR25";
  return null;
}

/** Faces pintadas e tipo de pintura pelo que o produto/item diz ("UMA FACE PINTADA", "SEM PINTURA", "DUAS FACES"). */
export function pinturaPorTexto(...textos: Array<string | null | undefined>): { tipo: TipoPintura | null; faces: number | null } {
  const t = normalizarTexto(textos.filter(Boolean).join(" | "));
  if (/pre[ -]?pintad/.test(t)) return { tipo: "PRE_PINTADA", faces: 0 };
  if (/sem pintura/.test(t)) return { tipo: "SEM_PINTURA", faces: 0 };
  if (/(duas|2) faces?/.test(t) || /dupla face/.test(t)) return { tipo: "PINTURA", faces: 2 };
  if (/(uma|1) face/.test(t)) return { tipo: "PINTURA", faces: 1 };
  return { tipo: null, faces: null };
}

/** Índice (na lista de cores) da cor cuja frase mais específica aparece no texto; -1 se nenhuma. */
export function indiceDaCor(texto: string | null | undefined, cores: Array<{ palavras: string[] }> = CORES_INICIAIS): number {
  const t = ` ${normalizarTexto(texto)} `;
  let melhor = -1;
  let melhorPeso = 0;
  cores.forEach((cor, i) => {
    for (const frase of cor.palavras) {
      if (!t.includes(` ${frase}`) && !t.includes(frase)) continue;
      const peso = frase.split(" ").length * 100 + frase.length;
      if (peso > melhorPeso) {
        melhorPeso = peso;
        melhor = i;
      }
    }
  });
  return melhor;
}

// ------------------------------------------------------------------ consumos (6.5)

export interface ParametrosConsumo {
  bobina_kg_por_metro: number;
  cola_kg_por_metro_eps: number;
  tinta_kg_por_metro_face: number;
}

export interface ConsumoCalculado {
  material: "bobina" | "eps" | "cola" | "tinta";
  quantidade: number;
  unidade: "kg" | "m";
}

/** Consumos derivados das metragens. Só gera linha com quantidade > 0. */
export function calcularConsumos(
  item: { categoria: Categoria; tipoPintura: TipoPintura | null; facesPintura: number; metrosTelha: number; metrosChapa: number },
  p: ParametrosConsumo
): ConsumoCalculado[] {
  const consumos: ConsumoCalculado[] = [];
  const telha = CATEGORIAS_DE_TELHA.includes(item.categoria);

  const bobina = telha ? item.metrosChapa * p.bobina_kg_por_metro : 0;
  const eps = CATEGORIAS_COM_EPS.includes(item.categoria) ? item.metrosTelha : 0;
  const cola = eps * p.cola_kg_por_metro_eps;
  const metrosPintados = telha && item.tipoPintura === "PINTURA" ? item.metrosTelha * item.facesPintura : 0;
  const tinta = metrosPintados * p.tinta_kg_por_metro_face;

  if (bobina > 0) consumos.push({ material: "bobina", quantidade: arred(bobina), unidade: "kg" });
  if (eps > 0) consumos.push({ material: "eps", quantidade: arred(eps), unidade: "m" });
  if (cola > 0) consumos.push({ material: "cola", quantidade: arred(cola), unidade: "kg" });
  if (tinta > 0) consumos.push({ material: "tinta", quantidade: arred(tinta), unidade: "kg" });
  return consumos;
}

export const grupoDaSituacao = (s: Situacao) => SITUACAO_GRUPO[s];
