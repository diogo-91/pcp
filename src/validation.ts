import { ACAO_STATUS, LIMITES_TEXTO, STATUS_PCP } from "./constants";
import { isDataPlausivel } from "./prazo";
import type { TratativaPatch } from "./types";

export type ResultadoPatch = { ok: true; patch: TratativaPatch } | { ok: false; erro: string };

const CAMPOS = ["statusPcp", "atendimento", "responsavel", "acao", "prazoAcao", "prazoEntrega", "acaoStatus"] as const;

/**
 * Valida o corpo de PATCH /api/pedidos/:id. Só os campos do PCP são aceitos (incluindo o prazo de entrega,
 * que nasce com o valor da Nomus mas depois é do PCP): nome, telefone e número do pedido não são editáveis.
 */
export function validarPatch(corpo: unknown): ResultadoPatch {
  if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) {
    return { ok: false, erro: "O corpo deve ser um objeto JSON." };
  }

  const entrada = corpo as Record<string, unknown>;
  const desconhecidos = Object.keys(entrada).filter((k) => !(CAMPOS as readonly string[]).includes(k));
  if (desconhecidos.length > 0) {
    return { ok: false, erro: `Campo(s) não editável(is): ${desconhecidos.join(", ")}.` };
  }
  if (Object.keys(entrada).length === 0) {
    return { ok: false, erro: "Informe ao menos um campo para atualizar." };
  }

  const patch: TratativaPatch = {};

  if ("statusPcp" in entrada) {
    if (!(STATUS_PCP as readonly unknown[]).includes(entrada.statusPcp)) {
      return { ok: false, erro: `statusPcp inválido. Use um de: ${STATUS_PCP.join(", ")}.` };
    }
    patch.statusPcp = entrada.statusPcp as string;
  }

  if ("acaoStatus" in entrada) {
    if (!(ACAO_STATUS as readonly unknown[]).includes(entrada.acaoStatus)) {
      return { ok: false, erro: `acaoStatus inválido. Use um de: ${ACAO_STATUS.join(", ")}.` };
    }
    patch.acaoStatus = entrada.acaoStatus as string;
  }

  for (const campo of ["atendimento", "responsavel", "acao"] as const) {
    if (!(campo in entrada)) continue;

    const valor = entrada[campo];
    if (typeof valor !== "string") return { ok: false, erro: `${campo} deve ser texto.` };

    const texto = valor.trim();
    if (texto.length > LIMITES_TEXTO[campo]) {
      return { ok: false, erro: `${campo} passa de ${LIMITES_TEXTO[campo]} caracteres.` };
    }
    patch[campo] = texto;
  }

  for (const campo of ["prazoAcao", "prazoEntrega"] as const) {
    if (!(campo in entrada)) continue;

    const valor = entrada[campo];
    if (valor === null || valor === "") {
      patch[campo] = null; // limpar: "sem prazo"
    } else if (typeof valor === "string" && isDataPlausivel(valor)) {
      patch[campo] = valor;
    } else {
      return { ok: false, erro: `${campo} deve ser uma data AAAA-MM-DD válida entre 2000 e 2100 (ou vazio para limpar).` };
    }
  }

  return { ok: true, patch };
}
