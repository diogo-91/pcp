import assert from "node:assert/strict";
import { test } from "node:test";
import { brParaIso, diasEntre, faixaDoPrazo, hojeEmSaoPaulo, isDataIsoValida, textoAlerta } from "../src/prazo";

const HOJE = "2026-09-28";

test("diasEntre conta dias corridos de calendário (o bug do HTML errava por 1 dia)", () => {
  assert.equal(diasEntre(HOJE, "2026-09-27"), -1, "ontem = 1 dia de atraso");
  assert.equal(diasEntre(HOJE, "2026-09-28"), 0, "hoje = 0");
  assert.equal(diasEntre(HOJE, "2026-09-29"), 1, "amanhã = 1");
  assert.equal(diasEntre(HOJE, "2026-09-30"), 2);
  assert.equal(diasEntre(HOJE, "2026-10-03"), 5);
  assert.equal(diasEntre("2026-12-31", "2027-01-01"), 1, "virada de ano");
  assert.equal(diasEntre("2028-02-28", "2028-03-01"), 2, "ano bissexto");
});

test("faixas: atrasado < 0, até 2 dias = 0..2, 3 a 5 dias = 3..5, resto normal", () => {
  assert.equal(faixaDoPrazo(null), "semdata");
  assert.equal(faixaDoPrazo(-1), "atrasado");
  assert.equal(faixaDoPrazo(0), "ate2");
  assert.equal(faixaDoPrazo(2), "ate2");
  assert.equal(faixaDoPrazo(3), "de3a5");
  assert.equal(faixaDoPrazo(5), "de3a5");
  assert.equal(faixaDoPrazo(6), "normal");
});

test("textos do alerta", () => {
  assert.equal(textoAlerta("atrasado", -3), "3 dia(s) em atraso");
  assert.equal(textoAlerta("ate2", 0), "Vence hoje");
  assert.equal(textoAlerta("ate2", 1), "Vence amanhã");
  assert.equal(textoAlerta("ate2", 2), "Vence em 2 dias");
  assert.equal(textoAlerta("de3a5", 4), "Vence em 4 dias");
  assert.equal(textoAlerta("normal", 20), "No prazo");
  assert.equal(textoAlerta("semdata", null), "Sem prazo");
});

test("hojeEmSaoPaulo usa o fuso de SP, não o do servidor (UTC)", () => {
  // 29/09 01:30 UTC ainda é 28/09 22:30 em São Paulo (UTC-3).
  assert.equal(hojeEmSaoPaulo(new Date("2026-09-29T01:30:00Z")), "2026-09-28");
  assert.equal(hojeEmSaoPaulo(new Date("2026-09-29T03:00:00Z")), "2026-09-29");
});

test("brParaIso converte o formato da Nomus e rejeita lixo", () => {
  assert.equal(brParaIso("01/11/2026 00:00:00"), "2026-11-01");
  assert.equal(brParaIso("05/08/2026"), "2026-08-05");
  assert.equal(brParaIso("31/02/2026"), null, "data que não existe");
  assert.equal(brParaIso("05//08"), null);
  assert.equal(brParaIso(""), null);
  assert.equal(brParaIso(undefined), null);
});

test("isDataIsoValida", () => {
  assert.equal(isDataIsoValida("2026-09-28"), true);
  assert.equal(isDataIsoValida("2026-02-30"), false);
  assert.equal(isDataIsoValida("28/09/2026"), false);
  assert.equal(isDataIsoValida("2026-9-8"), false);
});

test("somarDias: soma dias corridos de calendário e recusa data inválida", async () => {
  const { somarDias } = await import("../src/prazo");
  assert.equal(somarDias("2026-10-10", 20), "2026-10-30");
  assert.equal(somarDias("2026-10-25", 20), "2026-11-14", "vira o mês");
  assert.equal(somarDias("2026-12-20", 20), "2027-01-09", "vira o ano");
  assert.equal(somarDias("2028-02-20", 20), "2028-03-11", "ano bissexto");
  assert.equal(somarDias("2027-02-20", 20), "2027-03-12", "ano comum");
  assert.equal(somarDias("2026-10-10", 0), "2026-10-10");
  assert.equal(somarDias("2026-10-10", -10), "2026-09-30");
  assert.equal(somarDias("2026-02-30", 5), null);
  assert.equal(somarDias("10/10/2026", 5), null);
  assert.equal(somarDias("", 5), null);
});
