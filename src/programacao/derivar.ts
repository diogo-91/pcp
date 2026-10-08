import { CATEGORIAS_DE_TELHA, SITUACOES_PRODUZIDAS, type Categoria } from "./enums";
import type { ItemDerivado, ItemProg, ProgramacaoRepository } from "./repo";
import {
  calcularConsumos,
  indiceDaCor,
  metrosDeChapa,
  metrosDeTelha,
  parsearMedidas,
  pinturaPorTexto,
  trapezioPorTexto,
} from "./regras";

export interface EntradaDerivacao {
  /** Categoria do produto (de-para, já com a correção manual do produto). */
  categoria: Categoria;
  descricaoProduto: string;
  infoAdicional: string;
  quantidade: number | null;
}

/** O que o item já tem (para respeitar os campos que a equipe corrigiu à mão). */
type Atual = Pick<
  ItemProg,
  "camposManuais" | "categoria" | "tipoPintura" | "corId" | "medidas" | "medidasOrigem" | "trapezio" | "facesPintura" | "metrosTelha" | "metrosChapa"
>;

/**
 * Tudo que se deduz do texto da Nomus: categoria, tipo/faces de pintura, trapézio, cor, medidas e metragens.
 * Campo listado em `camposManuais` do item mantém o valor atual (a Nomus não desfaz correção da equipe).
 */
export function derivarItem(
  entrada: EntradaDerivacao,
  cores: Array<{ id: number; palavras: string[] }>,
  fatorSanduiche: number,
  atual?: Atual
): ItemDerivado {
  const manual = new Set(atual?.camposManuais ?? []);
  const pega = <T>(campo: string, calculado: T, valorAtual: T | undefined): T => (manual.has(campo) && atual ? (valorAtual as T) : calculado);

  const categoria = pega("categoria", entrada.categoria, atual?.categoria);

  const pintura = pinturaPorTexto(entrada.descricaoProduto, entrada.infoAdicional);
  const faces = pega("facesPintura", pintura.faces ?? 0, atual?.facesPintura);
  const tipoPintura = pega("tipoPintura", pintura.tipo ?? (faces > 0 ? "PINTURA" : null), atual?.tipoPintura ?? null);

  const trapezio = pega("trapezio", trapezioPorTexto(`${entrada.descricaoProduto} ${entrada.infoAdicional}`), atual?.trapezio ?? null);

  const i = indiceDaCor(entrada.infoAdicional, cores);
  const corId = pega("corId", i >= 0 ? cores[i].id : null, atual?.corId ?? null);

  let medidas = parsearMedidas(entrada.infoAdicional);
  let medidasOrigem: ItemDerivado["medidasOrigem"] = medidas.length > 0 ? "nomus" : "nenhuma";
  let metrosTelha = metrosDeTelha(medidas);
  if (manual.has("medidas") && atual) {
    medidas = atual.medidas;
    medidasOrigem = "manual";
    metrosTelha = metrosDeTelha(medidas);
  } else if (medidas.length === 0 && CATEGORIAS_DE_TELHA.includes(categoria) && entrada.quantidade && entrada.quantidade > 0) {
    // A Nomus só trouxe a quantidade (em metros, para telha): vale como metragem, mas fica sinalizado para revisão.
    metrosTelha = entrada.quantidade;
    medidasOrigem = "quantidade";
  }

  const metrosChapa = pega("metrosChapa", metrosDeChapa(categoria, metrosTelha, fatorSanduiche), atual?.metrosChapa);

  return { categoria, tipoPintura, corId, medidas, medidasOrigem, trapezio, facesPintura: faces, metrosTelha, metrosChapa };
}

/**
 * Refaz os consumos CALCULADOS do item (os lançados à mão ficam). Item já produzido fica congelado: o que foi consumido
 * não muda por causa de uma medida ou parâmetro alterado depois. Sem consumo calculado ainda, calcula uma vez.
 */
export function recalcularConsumosDoItem(repo: ProgramacaoRepository, item: ItemProg, agora: string): boolean {
  const jaTem = repo.consumosDoItem(item.id).some((c) => c.origem === "calculado");
  if (jaTem && SITUACOES_PRODUZIDAS.includes(item.situacao)) return false;

  const p = {
    bobina_kg_por_metro: repo.parametro("bobina_kg_por_metro"),
    cola_kg_por_metro_eps: repo.parametro("cola_kg_por_metro_eps"),
    tinta_kg_por_metro_face: repo.parametro("tinta_kg_por_metro_face"),
  };
  const calculados = calcularConsumos(item, p).map((c) => ({
    material: c.material,
    corId: c.material === "tinta" ? item.corId : null,
    quantidade: c.quantidade,
    unidade: c.unidade,
  }));
  repo.substituirConsumosCalculados(item.id, calculados, agora);
  return true;
}
