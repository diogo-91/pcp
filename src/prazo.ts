import { FUSO_HORARIO, JANELA_ATE_2_DIAS, JANELA_ATE_5_DIAS } from "./constants";
import type { FaixaPrazo } from "./types";

const MS_POR_DIA = 86_400_000;

/** Data de hoje no fuso de São Paulo (AAAA-MM-DD), independente do fuso do servidor (o container roda em UTC). */
export function hojeEmSaoPaulo(now: Date = new Date()): string {
  // "en-CA" formata como AAAA-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: FUSO_HORARIO }).format(now);
}

function isoParaUtc(iso: string): number {
  const [ano, mes, dia] = iso.split("-").map(Number);
  return Date.UTC(ano, mes - 1, dia);
}

/**
 * Diferença em dias corridos entre duas datas AAAA-MM-DD (prazo - hoje).
 * Compara datas de calendário puras em UTC, então não sofre com horário nem fuso:
 * prazo de hoje = 0, de amanhã = 1, de ontem = -1.
 */
export function diasEntre(hojeIso: string, prazoIso: string): number {
  return Math.round((isoParaUtc(prazoIso) - isoParaUtc(hojeIso)) / MS_POR_DIA);
}

export function faixaDoPrazo(dias: number | null): FaixaPrazo {
  if (dias === null) return "semdata";
  if (dias < 0) return "atrasado";
  if (dias <= JANELA_ATE_2_DIAS) return "ate2";
  if (dias <= JANELA_ATE_5_DIAS) return "de3a5";
  return "normal";
}

export function textoAlerta(faixa: FaixaPrazo, dias: number | null): string {
  if (dias === null) return "Sem prazo";
  if (dias < 0) return `${Math.abs(dias)} dia(s) em atraso`;
  if (dias === 0) return "Vence hoje";
  if (dias === 1) return "Vence amanhã";
  return faixa === "normal" ? "No prazo" : `Vence em ${dias} dias`;
}

/** Converte "DD/MM/AAAA[ HH:mm:ss]" (formato da Nomus) em "AAAA-MM-DD". Devolve null se vazio ou inválido. */
export function brParaIso(valor: string | null | undefined): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})/.exec((valor ?? "").trim());
  if (!match) return null;

  const [, dia, mes, ano] = match;
  const data = new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia)));
  const confere =
    data.getUTCFullYear() === Number(ano) && data.getUTCMonth() === Number(mes) - 1 && data.getUTCDate() === Number(dia);

  return confere ? `${ano}-${mes}-${dia}` : null;
}

/**
 * True se `valor` é uma data AAAA-MM-DD existente no calendário E de um ano plausível (2000–2100).
 * O segundo critério barra o que um campo de data gera enquanto se digita o ano ("0002-10-15", "0202-10-15").
 */
export function isDataPlausivel(valor: string): boolean {
  if (!isDataIsoValida(valor)) return false;
  const ano = Number(valor.slice(0, 4));
  return ano >= 2000 && ano <= 2100;
}

/** True se `valor` é uma data AAAA-MM-DD existente no calendário. */
export function isDataIsoValida(valor: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [ano, mes, dia] = valor.split("-").map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
}
