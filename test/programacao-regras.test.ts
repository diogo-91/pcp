import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calcularConsumos,
  categoriaPorDescricao,
  indiceDaCor,
  liberadoAposPrazo,
  mascararTelefone,
  metrosDeChapa,
  metrosDeTelha,
  normalizarSituacao,
  normalizarTelefone,
  parsearMedidas,
  pinturaPorTexto,
  prazoVigente,
  prontaEntrega,
  reaisParaCentavos,
  situacaoDoPedido,
  statusDePrazo,
  trapezioPorTexto,
  validarCronologia,
  exigenciasDaSituacao,
} from "../src/programacao/regras";
import { CORES_INICIAIS } from "../src/programacao/enums";

const HOJE = "2026-10-08";
const sp = (o: Partial<Parameters<typeof statusDePrazo>[0]>) =>
  statusDePrazo({ situacao: "PROGRAMADO", prazoVigente: "2026-10-20", dataEntregaRealizada: null, hoje: HOJE, ...o });

// ------------------------------------------------------------ 6.1 status de prazo

test("item ENTREGUE com prazo vencido NÃO é atrasado (a planilha marcava tudo como atraso)", () => {
  const noPrazo = sp({ situacao: "ENTREGUE", prazoVigente: "2026-09-01", dataEntregaRealizada: "2026-09-01" });
  assert.equal(noPrazo.codigo, "entregue_no_prazo");
  const atrasado = sp({ situacao: "ENTREGUE", prazoVigente: "2026-09-01", dataEntregaRealizada: "2026-09-04" });
  assert.equal(atrasado.codigo, "entregue_com_atraso");
  assert.equal(atrasado.dias, 3);
});

test("item em aberto sem prazo aparece como 'sem data', nunca 'atrasado'", () => {
  assert.equal(sp({ prazoVigente: null }).codigo, "sem_data");
});

test("atrasado / vence em breve / a vencer, com os dias", () => {
  assert.deepEqual([sp({ prazoVigente: "2026-10-05" }).codigo, sp({ prazoVigente: "2026-10-05" }).dias], ["atrasado", 3]);
  assert.equal(sp({ prazoVigente: "2026-10-08" }).codigo, "vence_em_breve"); // hoje não é atraso
  assert.equal(sp({ prazoVigente: "2026-10-11" }).codigo, "vence_em_breve"); // 3 dias
  assert.equal(sp({ prazoVigente: "2026-10-12" }).codigo, "a_vencer"); // 4 dias
});

test("cancelado e devolução: prazo não se aplica", () => {
  assert.equal(sp({ situacao: "CANCELADO", prazoVigente: "2020-01-01" }).codigo, "na");
  assert.equal(sp({ situacao: "DEVOLUCAO", prazoVigente: "2020-01-01" }).codigo, "na");
});

test("o prazo negociado com o cliente, quando existe, vira o prazo vigente", () => {
  assert.equal(prazoVigente("2026-11-10", "2026-10-10"), "2026-11-10");
  assert.equal(prazoVigente(null, "2026-10-10"), "2026-10-10");
  assert.equal(prazoVigente(null, null), null);
});

// ------------------------------------------------------------ 6.2 / 6.3

test("data produzida nula NUNCA é pronta entrega", () => {
  assert.equal(prontaEntrega(null, "2026-10-10"), false);
  assert.equal(prontaEntrega("2026-10-01", "2026-10-10"), true);
  assert.equal(prontaEntrega("2026-10-10", "2026-10-10"), false);
});

test("liberado após o prazo exige as duas datas", () => {
  assert.equal(liberadoAposPrazo("2026-10-12", "2026-10-10"), true);
  assert.equal(liberadoAposPrazo(null, "2026-10-10"), false);
  assert.equal(liberadoAposPrazo("2026-10-12", null), false);
});

// ------------------------------------------------------------ 5.1 situação

test("as 21 grafias da planilha caem no valor fechado", () => {
  const casos: Record<string, string> = {
    "aguardando Liberação": "AGUARDANDO_LIBERACAO",
    "Aguardando liberação ": "AGUARDANDO_LIBERACAO",
    "Programar em junho/2026": "PROGRAMAR",
    Programado: "PROGRAMADO",
    "Produzido Parcial": "PRODUZIDO_PARCIAL",
    "Em Trânsito": "EM_TRANSITO",
    "Em Rota": "EM_TRANSITO",
    "Expedição": "EXPEDICAO",
    "Devolução": "DEVOLUCAO",
    "Não Programar": "NAO_PROGRAMAR",
    "Loja 2": "REVENDA",
    Comprado: "COMPRADO",
  };
  for (const [texto, esperado] of Object.entries(casos)) assert.equal(normalizarSituacao(texto), esperado, texto);
  assert.equal(normalizarSituacao("xxx"), null);
  assert.equal(normalizarSituacao(""), null);
});

test("situação do pedido = a do item menos avançado, ignorando cancelados", () => {
  assert.equal(situacaoDoPedido(["PRODUZIDO", "PROGRAMADO"]), "PROGRAMADO");
  assert.equal(situacaoDoPedido(["PRODUZIDO", "CANCELADO"]), "PRODUZIDO");
  assert.equal(situacaoDoPedido(["CANCELADO"]), "CANCELADO");
});

// ------------------------------------------------------------ medidas (critério 10)

test("sanduíche 5×4,16 + 2×3,57 → 27,94 m de telha", () => {
  const medidas = [
    { qtd: 5, comprimento_m: 4.16 },
    { qtd: 2, comprimento_m: 3.57 },
  ];
  assert.equal(metrosDeTelha(medidas), 27.94);
  assert.equal(metrosDeChapa("SANDUICHE", 27.94, 2), 55.88);
  assert.equal(metrosDeChapa("SIMPLES", 27.94, 2), 27.94);
});

test("lê as medidas do texto livre da Nomus (formatos reais)", () => {
  assert.deepEqual(parsearMedidas("11 X 3.000\r\nUMA FACE PRETO EXTERNO"), [{ qtd: 11, comprimento_m: 3 }]);
  assert.deepEqual(parsearMedidas("4 telhas de 3,50 m \n2 telhas de 0.90 m\n2 telhas de 1.5 m"), [
    { qtd: 4, comprimento_m: 3.5 },
    { qtd: 2, comprimento_m: 0.9 },
    { qtd: 2, comprimento_m: 1.5 },
  ]);
  assert.deepEqual(parsearMedidas("2x6,20 / 5x3,80 / 8x3,00"), [
    { qtd: 2, comprimento_m: 6.2 },
    { qtd: 5, comprimento_m: 3.8 },
    { qtd: 8, comprimento_m: 3 },
  ]);
  assert.deepEqual(parsearMedidas("7 TELHAS DE 5.000"), [{ qtd: 7, comprimento_m: 5 }]);
  assert.deepEqual(parsearMedidas("4 X 3,000 1 FACE PINTADA EXTERNA\nAZUL BRILHANTE"), [{ qtd: 4, comprimento_m: 3 }]);
  assert.deepEqual(parsearMedidas("7 CUMIEIRAS"), [], "sem comprimento: não inventa medida");
  assert.deepEqual(parsearMedidas("3 x 3000 mm"), [{ qtd: 3, comprimento_m: 3 }], "milímetros viram metros");
  assert.deepEqual(parsearMedidas(""), []);
});

// ------------------------------------------------------------ classificação do produto

test("categoria, trapézio e pintura saem da descrição do produto da Nomus", () => {
  assert.equal(categoriaPorDescricao("TELHA SANDUICHE TR25 - 1020mm - (GALVALUME) - SEM PINTURA"), "SANDUICHE");
  assert.equal(categoriaPorDescricao("TELHA SEMI-SANDUICHE TR40"), "SEMI_SANDUICHE");
  assert.equal(categoriaPorDescricao("TELHA SIMPLES TR25 - 1020mm - (GALVALUME) - UMA FACE PINTADA"), "SIMPLES");
  assert.equal(categoriaPorDescricao("FORRO AMADEIRADO ESCURO"), "FORRO_AMADEIRADO_ESCURO");
  assert.equal(categoriaPorDescricao("CUMIEIRA TR25 SIMPLES"), "CUMIEIRA");
  assert.equal(categoriaPorDescricao("PINTURA ELETROSTÁTICA"), "PINTURA_TERCEIRO");
  assert.equal(categoriaPorDescricao("COISA ESTRANHA"), "OUTROS");
  assert.equal(trapezioPorTexto("TELHA SIMPLES TR25 - 1020mm"), "TR25");
  assert.equal(trapezioPorTexto("TELHA TR40"), "TR40");
  assert.equal(trapezioPorTexto("CALHA"), null);
  assert.deepEqual(pinturaPorTexto("TELHA SIMPLES - UMA FACE PINTADA"), { tipo: "PINTURA", faces: 1 });
  assert.deepEqual(pinturaPorTexto("TELHA SANDUICHE - SEM PINTURA"), { tipo: "SEM_PINTURA", faces: 0 });
  assert.deepEqual(pinturaPorTexto("TELHA - DUAS FACES PINTADAS"), { tipo: "PINTURA", faces: 2 });
  assert.deepEqual(pinturaPorTexto("CALHA"), { tipo: null, faces: null });
});

test("cor: a frase mais específica vence", () => {
  const nome = (t: string) => CORES_INICIAIS[indiceDaCor(t)]?.nome;
  assert.match(nome("UMA FACE PRETO EXTERNO") ?? "", /^Preto fosco/);
  assert.match(nome("PRETO BRILHANTE") ?? "", /^Preto brilhante/);
  assert.match(nome("1 FACE PINTADA EXTERNA\nAZUL BRILHANTE") ?? "", /^Azul brilhante/);
  assert.match(nome("azul claro") ?? "", /^Azul claro/);
  assert.equal(indiceDaCor("sem cor nenhuma"), -1);
});

// ------------------------------------------------------------ consumos (6.5)

const params = { bobina_kg_por_metro: 3.6, cola_kg_por_metro_eps: 0.2, tinta_kg_por_metro_face: 0.2 };

test("consumos do sanduíche pintado: bobina, EPS, cola e tinta", () => {
  const c = calcularConsumos({ categoria: "SANDUICHE", tipoPintura: "PINTURA", facesPintura: 1, metrosTelha: 27.94, metrosChapa: 55.88 }, params);
  const por = Object.fromEntries(c.map((x) => [x.material, x.quantidade]));
  assert.equal(por.bobina, 201.17); // 55,88 × 3,6
  assert.equal(por.eps, 27.94);
  assert.equal(por.cola, 5.59);
  assert.equal(por.tinta, 5.59); // 27,94 m × 1 face × 0,2
});

test("sem pintura não consome tinta; simples não consome EPS nem cola", () => {
  const c = calcularConsumos({ categoria: "SIMPLES", tipoPintura: "SEM_PINTURA", facesPintura: 0, metrosTelha: 10, metrosChapa: 10 }, params);
  assert.deepEqual(c.map((x) => x.material), ["bobina"]);
  assert.deepEqual(calcularConsumos({ categoria: "CUMIEIRA", tipoPintura: null, facesPintura: 0, metrosTelha: 0, metrosChapa: 0 }, params), []);
});

// ------------------------------------------------------------ validações (seção 8) e valores

test("cronologia: produzida não pode ser antes da liberação, entrega não antes da produzida", () => {
  assert.match(validarCronologia({ dataLiberacaoProducao: "2026-10-10", dataProduzida: "2026-10-09", dataEntregaRealizada: null }) ?? "", /produzida/i);
  assert.match(validarCronologia({ dataLiberacaoProducao: null, dataProduzida: "2026-10-10", dataEntregaRealizada: "2026-10-09" }) ?? "", /entrega/i);
  assert.equal(validarCronologia({ dataLiberacaoProducao: "2026-10-01", dataProduzida: "2026-10-02", dataEntregaRealizada: "2026-10-03" }), null);
  assert.equal(validarCronologia({ dataLiberacaoProducao: null, dataProduzida: null, dataEntregaRealizada: null }), null);
});

test("PRODUZIDO exige data produzida; ENTREGUE exige data de entrega", () => {
  assert.ok(exigenciasDaSituacao("PRODUZIDO", { dataProduzida: null, dataEntregaRealizada: null }));
  assert.ok(exigenciasDaSituacao("ENTREGUE", { dataProduzida: "2026-10-01", dataEntregaRealizada: null }));
  assert.equal(exigenciasDaSituacao("PROGRAMADO", { dataProduzida: null, dataEntregaRealizada: null }), null);
});

test("telefone: só dígitos, sem o 55, e máscara", () => {
  assert.equal(normalizarTelefone("+55 15 991585191"), "15991585191");
  assert.equal(mascararTelefone("15991585191"), "(15) 99158-5191");
  assert.equal(mascararTelefone("1532221234"), "(15) 3222-1234");
  assert.equal(mascararTelefone("12345"), "12345", "fora do padrão: mostra como veio");
});

test("valor em reais brasileiros vira centavos", () => {
  assert.equal(reaisParaCentavos("1.452,00"), 145200);
  assert.equal(reaisParaCentavos("37698"), 3769800);
  assert.equal(reaisParaCentavos(""), null);
  assert.equal(reaisParaCentavos("abc"), null);
});
