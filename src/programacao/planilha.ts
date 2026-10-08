import { isDataPlausivel } from "../prazo";
import type { ItemProg, PedidoProg, ProgramacaoRepository } from "./repo";
import { categoriaPorDescricao, chaveCidade, exigenciasDaSituacao, normalizarSituacao, validarCronologia } from "./regras";
import { serialParaIso, type Aba, type Celula } from "./xlsx";
import type { Situacao } from "./enums";

/**
 * Importação ÚNICA do histórico da planilha "Programação de Produção 2026" (aba Base, cabeçalho na linha 3, dados da 4 em
 * diante, colunas A–CC; aba Rotas). Importa SÓ o que existe apenas na planilha (situação, datas de programação/liberação/
 * produção/entrega, entrega do terceiro, prazo negociado, observação, rota manual); nada que o Nomus ou o cálculo já dão.
 * Casa com o que a sincronização já trouxe da Nomus por número do pedido + categoria do produto.
 */

export type StatusLinha = "importada" | "ajustada" | "rejeitada" | "ignorada" | "sem_mudanca";

export interface LinhaRelatorio {
  linha: number;
  pedido: number | null;
  produto: string;
  status: StatusLinha;
  itemId: number | null;
  detalhes: string[];
}

export interface ResultadoImportacao {
  gravou: boolean;
  relatorio: LinhaRelatorio[];
  resumo: Record<StatusLinha, number> & { rotasNovas: number; rotasDivergentes: number };
  rotas: LinhaRelatorio[];
}

interface LinhaBase {
  linha: number;
  pedido: number;
  produto: string;
  c: Record<string, Celula>;
}

const COLUNAS_BASE = { pedido: "A", cidade: "B", prog: "F", rota: "G", situacao: "H", produto: "I", mts: "S", lib: "BT", prod: "BU", ent: "BV", terceiro: "BW", negociada: "BX", obs: "BY" } as const;

const texto = (c: Celula | undefined): string => (c === null || c === undefined ? "" : String(c).replace(/\s+/g, " ").trim());

/** Data da planilha (serial do Excel, dd/mm/aaaa ou AAAA-MM-DD) -> ISO. Texto livre ("xxx", "22/01 e 23/01") e ano < 2025 são rejeitados. */
export function lerDataDaPlanilha(c: Celula | undefined): { iso: string | null; erro: string | null } {
  if (c === null || c === undefined || c === "") return { iso: null, erro: null };
  let iso: string | null = null;

  if (typeof c === "number") {
    iso = serialParaIso(c);
    if (!iso) return { iso: null, erro: `número ${c} não é uma data válida` };
  } else {
    const t = String(c).trim();
    const br = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
    const us = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
    if (br) iso = `${br[3].length === 2 ? `20${br[3]}` : br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
    else if (us) iso = `${us[1]}-${us[2]}-${us[3]}`;
    else return { iso: null, erro: `texto "${t.slice(0, 40)}" não é uma data` };
  }

  if (!isDataPlausivel(iso)) return { iso: null, erro: `data inexistente (${iso})` };
  if (iso < "2025-01-01") return { iso: null, erro: `ano anterior a 2025 (${iso})` };
  return { iso, erro: null };
}

/** Lê as linhas válidas da aba Base. Linha sem produto, situação e metragem (pedido "reservado" vazio) é ignorada. */
export function linhasDaBase(aba: Aba, primeiraLinha = 4): { linhas: LinhaBase[]; ignoradas: LinhaRelatorio[] } {
  const linhas: LinhaBase[] = [];
  const ignoradas: LinhaRelatorio[] = [];
  const ultima = Math.max(0, ...aba.keys());

  for (let n = primeiraLinha; n <= ultima; n++) {
    const cel = aba.get(n);
    if (!cel) continue;
    const c: Record<string, Celula> = {};
    for (const [col, v] of cel) c[col] = v;

    const produto = texto(c[COLUNAS_BASE.produto]);
    const pedidoNum = Number(String(c[COLUNAS_BASE.pedido] ?? "").replace(/\D/g, ""));
    if (!produto && !texto(c[COLUNAS_BASE.situacao]) && !texto(c[COLUNAS_BASE.mts])) {
      ignoradas.push({ linha: n, pedido: Number.isFinite(pedidoNum) && pedidoNum > 0 ? pedidoNum : null, produto: "", status: "ignorada", itemId: null, detalhes: ["linha reservada, sem produto, situação nem metragem"] });
      continue;
    }
    if (!Number.isInteger(pedidoNum) || pedidoNum <= 0) {
      ignoradas.push({ linha: n, pedido: null, produto, status: "rejeitada", itemId: null, detalhes: ["sem número de pedido válido"] });
      continue;
    }
    linhas.push({ linha: n, pedido: pedidoNum, produto, c });
  }
  return { linhas, ignoradas };
}

/** Rota da planilha ("ROTA 3", 3, "3") -> id, ou null. */
const rotaDe = (c: Celula | undefined): number | null => {
  const m = /(\d{1,2})/.exec(texto(c));
  return m ? Number(m[1]) : null;
};

interface Proposta {
  situacao?: Situacao;
  dataProgramacao?: string | null;
  dataLiberacaoProducao?: string | null;
  dataProduzida?: string | null;
  dataEntregaRealizada?: string | null;
  dataEntregaTerceiro?: string | null;
}

export function importarPlanilha(opcoes: {
  repo: ProgramacaoRepository;
  base: Aba;
  rotas?: Aba | null;
  /** false = dry-run: calcula e relata tudo, não grava nada. */
  gravar: boolean;
  /** Sobrescreve também o que alguém editou no sistema depois da carga (padrão: preserva). */
  forcar?: boolean;
  agora?: () => Date;
}): ResultadoImportacao {
  const { repo, base, gravar } = opcoes;
  const agora = (opcoes.agora ?? (() => new Date()))().toISOString();
  const relatorio: LinhaRelatorio[] = [];
  const rotasRel: LinhaRelatorio[] = [];
  const resumo = { importada: 0, ajustada: 0, rejeitada: 0, ignorada: 0, sem_mudanca: 0, rotasNovas: 0, rotasDivergentes: 0 };

  const trabalho = () => {
    // ---------------- aba Rotas (cidade -> rota)
    if (opcoes.rotas) {
      const ultima = Math.max(0, ...opcoes.rotas.keys());
      const rotasValidas = new Set(repo.rotas().map((r) => r.id));
      for (let n = 1; n <= ultima; n++) {
        const cel = opcoes.rotas.get(n);
        const cidade = texto(cel?.get("A"));
        if (!cel || !cidade || cidade.toLowerCase() === "cidade") continue; // cabeçalhos "Cidade" repetidos e linhas vazias
        const rota = rotaDe(cel.get("B"));
        const linha: LinhaRelatorio = { linha: n, pedido: null, produto: cidade, status: "importada", itemId: null, detalhes: [] };
        if (rota === null || !rotasValidas.has(rota)) {
          Object.assign(linha, { status: "rejeitada", detalhes: [`rota "${texto(cel.get("B"))}" inválida`] });
          rotasRel.push(linha);
          continue;
        }
        const chave = chaveCidade(cidade);
        const atual = repo.rotaDaCidade(chave);
        if (atual === rota) {
          linha.status = "sem_mudanca";
        } else if (atual !== null && !opcoes.forcar) {
          Object.assign(linha, { status: "ajustada", detalhes: [`já mapeada para a rota ${atual} (planilha diz ${rota}); mantida`] });
          resumo.rotasDivergentes++;
        } else {
          if (gravar) {
            repo.salvarCidadeRota(chave, cidade, rota);
            repo.aplicarRotaNaCidade(chaveCidade, chave, rota);
          }
          linha.detalhes = [`cidade → rota ${rota}`];
          resumo.rotasNovas++;
        }
        rotasRel.push(linha);
      }
    }

    // ---------------- aba Base
    const { linhas, ignoradas } = linhasDaBase(base);
    for (const ig of ignoradas) {
      relatorio.push(ig);
      resumo[ig.status as "ignorada" | "rejeitada"]++;
    }

    const porPedido = new Map<number, LinhaBase[]>();
    for (const l of linhas) porPedido.set(l.pedido, [...(porPedido.get(l.pedido) ?? []), l]);

    for (const [numero, doPedido] of porPedido) {
      const pedidos = repo.pedidosPorNumero(numero);
      if (pedidos.length === 0) {
        for (const l of doPedido) rejeitar(l, "pedido não está na Programação (ainda não veio da Nomus ou já saiu dos liberados)");
        continue;
      }
      if (pedidos.length > 1) {
        for (const l of doPedido) rejeitar(l, `há ${pedidos.length} pedidos com o número ${numero} na Programação: revisão manual`);
        continue;
      }
      processarPedido(pedidos[0], doPedido);
    }
  };

  function rejeitar(l: LinhaBase, motivo: string) {
    relatorio.push({ linha: l.linha, pedido: l.pedido, produto: l.produto, status: "rejeitada", itemId: null, detalhes: [motivo] });
    resumo.rejeitada++;
  }

  function processarPedido(pedido: PedidoProg, linhas: LinhaBase[]) {
    const itens = repo.itensDoPedido(pedido.id).filter((i) => !i.removidoNoErp);
    const usados = new Set<number>();
    const casamento = new Map<number, { item: ItemProg; porPosicao: boolean }>();

    // 1) mesma categoria, na ordem; 2) o que sobrar, por posição
    for (const l of linhas) {
      const cat = categoriaPorDescricao(l.produto);
      const item = itens.find((i) => !usados.has(i.id) && i.categoria === cat);
      if (item) {
        usados.add(item.id);
        casamento.set(l.linha, { item, porPosicao: false });
      }
    }
    for (const l of linhas) {
      if (casamento.has(l.linha)) continue;
      const item = itens.find((i) => !usados.has(i.id));
      if (item) {
        usados.add(item.id);
        casamento.set(l.linha, { item, porPosicao: true });
      }
    }

    // ---- pedido: prazo negociado, observação e rota (podem vir em várias linhas do mesmo pedido)
    const notasPedido: string[] = [];
    const negociadas = new Set<string>();
    const obs: string[] = [];
    const rotas = new Set<number>();
    for (const l of linhas) {
      const d = lerDataDaPlanilha(l.c[COLUNAS_BASE.negociada]);
      if (d.iso) negociadas.add(d.iso);
      else if (d.erro) notasPedido.push(`prazo negociado rejeitado (${d.erro})`);
      const o = texto(l.c[COLUNAS_BASE.obs]);
      if (o && !obs.includes(o)) obs.push(o);
      const r = rotaDe(l.c[COLUNAS_BASE.rota]);
      if (r !== null) rotas.add(r);
    }
    const negociadaEscolhida = [...negociadas].sort().at(-1) ?? null;
    if (negociadas.size > 1) notasPedido.push(`prazos negociados diferentes entre as linhas (${[...negociadas].join(", ")}); usado o mais recente`);
    const observacao = obs.join(" | ").slice(0, 4000);
    const rotaPlanilha = rotas.size === 1 ? [...rotas][0] : null;
    if (rotas.size > 1) notasPedido.push(`rotas diferentes entre as linhas (${[...rotas].join(", ")}): rota não importada`);

    const editadoNoSistema = !["sync", "importacao"].includes(pedido.updatedBy);
    const pedidoPulado = editadoNoSistema && !opcoes.forcar;
    if (pedidoPulado) notasPedido.push(`pedido editado no sistema por ${pedido.updatedBy}: prazo negociado, observação e rota preservados`);

    const mudancasPedido: string[] = [];
    if (!pedidoPulado) {
      const campos: Parameters<ProgramacaoRepository["atualizarPedidoPcp"]>[1] = {};
      if (negociadaEscolhida && negociadaEscolhida !== pedido.dataEntregaNegociada) {
        campos.dataEntregaNegociada = negociadaEscolhida;
        mudancasPedido.push(`prazo negociado ${negociadaEscolhida}`);
      }
      if (observacao && observacao !== pedido.observacao) {
        campos.observacao = observacao;
        mudancasPedido.push("observação");
      }
      if (rotaPlanilha !== null && rotaPlanilha !== pedido.rotaId) {
        if (repo.rotas().some((r) => r.id === rotaPlanilha)) {
          campos.rotaId = rotaPlanilha;
          campos.rotaManual = true;
          mudancasPedido.push(`rota ${rotaPlanilha} (diverge da derivada pela cidade)`);
        } else {
          notasPedido.push(`rota ${rotaPlanilha} não existe`);
        }
      }
      if (gravar && Object.keys(campos).length > 0) {
        repo.atualizarPedidoPcp(pedido.id, campos, "importacao", agora);
        for (const [campo, antes, depois] of [
          ["data_entrega_cliente_negociada", pedido.dataEntregaNegociada, campos.dataEntregaNegociada],
          ["observacao", pedido.observacao.slice(0, 2000), campos.observacao?.slice(0, 2000)],
          ["rota_id", pedido.rotaId, campos.rotaId],
        ] as Array<[string, unknown, unknown]>) {
          if (depois !== undefined && depois !== antes) {
            repo.registrarEvento({ entidade: "pedido", entidadeId: pedido.id, pedidoId: pedido.id, campo, valorAntigo: antes, valorNovo: depois, usuario: "importacao", origem: "importacao", em: agora });
          }
        }
      }
    }

    // ---- itens
    let primeiro = true;
    for (const l of linhas) {
      const cas = casamento.get(l.linha);
      if (!cas) {
        rejeitar(l, `o pedido tem ${itens.length} item(ns) na Nomus e a planilha tem ${linhas.length} linhas: sobrou esta (revisão manual)`);
        continue;
      }
      const { item, porPosicao } = cas;
      const detalhes: string[] = [];
      if (porPosicao) detalhes.push("casada com o item por posição (a categoria do produto não bateu)");

      const prop = montarProposta(l, item, detalhes);

      const diff: Array<[string, string, unknown, unknown]> = [];
      const compara = (campo: keyof Proposta, coluna: string) => {
        if (prop[campo] === undefined) return;
        const antes = item[campo as keyof ItemProg] as unknown;
        if ((antes ?? null) !== (prop[campo] ?? null)) diff.push([campo, coluna, antes, prop[campo]]);
      };
      compara("situacao", "situacao_pcp");
      compara("dataProgramacao", "data_programacao");
      compara("dataLiberacaoProducao", "data_liberacao_producao");
      compara("dataProduzida", "data_produzida");
      compara("dataEntregaRealizada", "data_entrega_realizada");
      compara("dataEntregaTerceiro", "data_entrega_terceiro");

      const itemEditado = !["sync", "importacao"].includes(item.updatedBy);
      if (itemEditado && !opcoes.forcar) {
        relatorio.push({ linha: l.linha, pedido: l.pedido, produto: l.produto, status: "rejeitada", itemId: item.id, detalhes: [`item editado no sistema por ${item.updatedBy}: preservado (use --forcar para sobrescrever)`] });
        resumo.rejeitada++;
        continue;
      }

      // As mudanças do pedido (prazo negociado, observação, rota) são relatadas uma vez só, na primeira linha dele.
      const mudouPedidoAqui = primeiro && mudancasPedido.length > 0;
      if (primeiro) {
        detalhes.push(...notasPedido);
        if (mudancasPedido.length) detalhes.push(`pedido: ${mudancasPedido.join(", ")}`);
        primeiro = false;
      }

      if (diff.length > 0 && gravar) {
        const campos: Record<string, unknown> = {};
        for (const [campo] of diff) campos[campo] = prop[campo as keyof Proposta];
        repo.atualizarItemPcp(item.id, campos, null, "importacao", agora);
        for (const [, coluna, antes, depois] of diff) {
          repo.registrarEvento({ entidade: "item", entidadeId: item.id, pedidoId: pedido.id, campo: coluna, valorAntigo: antes, valorNovo: depois, usuario: "importacao", origem: "importacao", em: agora });
        }
      }

      const houveAjuste = detalhes.some((d) => /rejeitad|inválid|diferentes|não existe|por posição|desconhecida|preservad|mantida/.test(d));
      const semMudanca = diff.length === 0 && !mudouPedidoAqui;
      const status: StatusLinha = houveAjuste ? "ajustada" : semMudanca ? "sem_mudanca" : "importada";
      if (diff.length > 0) detalhes.push(`campos: ${diff.map(([c, , , depois]) => `${c}=${depois ?? "vazio"}`).join(", ")}`);
      relatorio.push({ linha: l.linha, pedido: l.pedido, produto: l.produto, status, itemId: item.id, detalhes });
      resumo[status]++;
    }
  }

  /** Normaliza o que a planilha traz para um item, descartando (e relatando) o que não serve. */
  function montarProposta(l: LinhaBase, item: ItemProg, detalhes: string[]): Proposta {
    const prop: Proposta = {};
    const datas: Array<[keyof Proposta, string, string]> = [
      ["dataProgramacao", COLUNAS_BASE.prog, "programação"],
      ["dataLiberacaoProducao", COLUNAS_BASE.lib, "liberação"],
      ["dataProduzida", COLUNAS_BASE.prod, "produzida"],
      ["dataEntregaRealizada", COLUNAS_BASE.ent, "entrega"],
      ["dataEntregaTerceiro", COLUNAS_BASE.terceiro, "entrega do terceiro"],
    ];
    for (const [campo, col, nome] of datas) {
      const { iso, erro } = lerDataDaPlanilha(l.c[col]);
      if (erro) detalhes.push(`data de ${nome} rejeitada (${erro})`);
      else if (iso) (prop as Record<string, unknown>)[campo] = iso;
    }

    // Cronologia: liberação <= produzida <= entrega. Quem quebra a ordem é descartado (e relatado), para o item não
    // ficar com um estado que o próprio sistema recusaria numa edição futura.
    const lib = prop.dataLiberacaoProducao ?? item.dataLiberacaoProducao;
    if (prop.dataProduzida && lib && prop.dataProduzida < lib) {
      detalhes.push(`data produzida (${prop.dataProduzida}) rejeitada: anterior à liberação (${lib})`);
      delete prop.dataProduzida;
    }
    const prod = prop.dataProduzida ?? item.dataProduzida;
    if (prop.dataEntregaRealizada && (prod ?? lib) && prop.dataEntregaRealizada < (prod ?? lib)!) {
      detalhes.push(`data de entrega (${prop.dataEntregaRealizada}) rejeitada: anterior à produção/liberação`);
      delete prop.dataEntregaRealizada;
    }

    const bruto = texto(l.c[COLUNAS_BASE.situacao]);
    if (bruto) {
      const s = normalizarSituacao(bruto);
      if (!s) detalhes.push(`situação "${bruto.slice(0, 30)}" desconhecida: mantida a atual`);
      else {
        const resultado = {
          dataProduzida: prop.dataProduzida ?? item.dataProduzida,
          dataEntregaRealizada: prop.dataEntregaRealizada ?? item.dataEntregaRealizada,
        };
        const exigencia = exigenciasDaSituacao(s, resultado);
        if (exigencia) detalhes.push(`situação "${bruto}" rejeitada: ${exigencia.toLowerCase()} (ficou ${item.situacao})`);
        else prop.situacao = s;
      }
    }

    const cron = validarCronologia({
      dataLiberacaoProducao: prop.dataLiberacaoProducao ?? item.dataLiberacaoProducao,
      dataProduzida: prop.dataProduzida ?? item.dataProduzida,
      dataEntregaRealizada: prop.dataEntregaRealizada ?? item.dataEntregaRealizada,
    });
    if (cron) detalhes.push(`cronologia inválida após a importação: ${cron}`);
    return prop;
  }

  if (gravar) repo.transacao(trabalho);
  else trabalho();

  return { gravou: gravar, relatorio, resumo, rotas: rotasRel };
}

/** CSV do relatório (separador ;, com BOM para abrir certo no Excel). */
export function relatorioCsv(r: ResultadoImportacao): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linhas = (origem: string, ls: LinhaRelatorio[]) =>
    ls.map((l) => [origem, l.linha, l.pedido ?? "", l.produto, l.status, l.itemId ?? "", l.detalhes.join(" | ")].map(esc).join(";"));
  return (
    "﻿" +
    [["aba", "linha_planilha", "pedido", "produto_ou_cidade", "status", "item_id", "detalhes"].join(";"), ...linhas("Rotas", r.rotas), ...linhas("Base", r.relatorio)].join("\r\n") +
    "\r\n"
  );
}
