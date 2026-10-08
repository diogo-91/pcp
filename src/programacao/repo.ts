import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "../db";
import {
  CIDADES_INICIAIS,
  CORES_INICIAIS,
  MATERIAIS_INICIAIS,
  PARAMETROS_INICIAIS,
  ROTAS_INICIAIS,
  type Categoria,
  type Situacao,
  type TipoPintura,
  type Trapezio,
} from "./enums";
import { chaveCidade, type Medida } from "./regras";

type Linha = Record<string, unknown>;

export interface PedidoProg {
  id: number;
  nomusPedidoId: number;
  numeroPedido: number;
  dataPedido: string | null;
  clienteNome: string;
  clienteTelefone: string;
  cidade: string;
  uf: string;
  rotaId: number | null;
  rotaManual: boolean;
  dataEntregaOriginal: string | null;
  dataEntregaNegociada: string | null;
  valorCentavos: number | null;
  statusNomus: string;
  observacao: string;
  nomusHash: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ItemProg {
  id: number;
  pedidoId: number;
  nomusItemId: number;
  itemSeq: string;
  produtoNomusId: number | null;
  produtoCodigo: string;
  categoria: Categoria;
  tipoPintura: TipoPintura | null;
  corId: number | null;
  descricaoProduto: string;
  infoAdicional: string;
  quantidade: number | null;
  medidas: Medida[];
  medidasOrigem: "nomus" | "quantidade" | "manual" | "nenhuma";
  trapezio: Trapezio | null;
  facesPintura: number;
  metrosTelha: number;
  metrosChapa: number;
  camposManuais: string[];
  situacao: Situacao;
  dataProgramacao: string | null;
  dataLiberacaoProducao: string | null;
  dataProduzida: string | null;
  dataEntregaRealizada: string | null;
  fornecedorTerceiro: string;
  dataEntregaTerceiro: string | null;
  removidoNoErp: boolean;
  alteradoNoErp: boolean;
  nomusHash: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ProdutoCache {
  nomusId: number;
  codigo: string;
  descricao: string;
  tipoProduto: string;
  unidade: string;
  categoria: Categoria;
  categoriaManual: boolean;
  buscadoEm: string;
}

export interface OpItem {
  itemId: number;
  nomusOpId: number;
  numeroOp: string;
  statusOp: string;
  inicioPlanejado: string | null;
}

export interface ConsumoRow {
  id: number;
  itemId: number;
  material: string;
  corId: number | null;
  quantidade: number;
  unidade: string;
  origem: "calculado" | "manual" | "nomus";
  calculadoEm: string;
}

export interface EventoRow {
  id: number;
  entidade: string;
  entidadeId: number;
  pedidoId: number | null;
  campo: string;
  valorAntigo: string | null;
  valorNovo: string | null;
  usuario: string;
  origem: string;
  em: string;
}

export interface NovoEvento {
  entidade: "pedido" | "item" | "parametro";
  entidadeId: number;
  pedidoId: number | null;
  campo: string;
  valorAntigo: unknown;
  valorNovo: unknown;
  usuario: string;
  origem?: "usuario" | "sync" | "importacao";
  em: string;
}

const texto = (v: unknown) => (v === null || v === undefined ? null : String(v));

const paraPedido = (l: Linha): PedidoProg => ({
  id: l.id as number,
  nomusPedidoId: l.nomus_pedido_id as number,
  numeroPedido: l.numero_pedido as number,
  dataPedido: (l.data_pedido as string | null) ?? null,
  clienteNome: l.cliente_nome as string,
  clienteTelefone: l.cliente_telefone as string,
  cidade: l.cidade as string,
  uf: l.uf as string,
  rotaId: (l.rota_id as number | null) ?? null,
  rotaManual: l.rota_manual === 1,
  dataEntregaOriginal: (l.data_entrega_cliente_original as string | null) ?? null,
  dataEntregaNegociada: (l.data_entrega_cliente_negociada as string | null) ?? null,
  valorCentavos: (l.valor_centavos as number | null) ?? null,
  statusNomus: l.status_nomus as string,
  observacao: l.observacao as string,
  nomusHash: l.nomus_hash as string,
  createdAt: l.created_at as string,
  updatedAt: l.updated_at as string,
  updatedBy: l.updated_by as string,
});

function lerJson<T>(bruto: unknown, padrao: T): T {
  try {
    return typeof bruto === "string" ? (JSON.parse(bruto) as T) : padrao;
  } catch {
    return padrao;
  }
}

const paraItem = (l: Linha): ItemProg => ({
  id: l.id as number,
  pedidoId: l.pedido_id as number,
  nomusItemId: l.nomus_item_id as number,
  itemSeq: l.item_seq as string,
  produtoNomusId: (l.produto_nomus_id as number | null) ?? null,
  produtoCodigo: l.produto_codigo as string,
  categoria: l.produto_categoria as Categoria,
  tipoPintura: (l.tipo_pintura as TipoPintura | null) ?? null,
  corId: (l.cor_id as number | null) ?? null,
  descricaoProduto: l.descricao_produto as string,
  infoAdicional: l.info_adicional as string,
  quantidade: (l.quantidade as number | null) ?? null,
  medidas: lerJson<Medida[]>(l.medidas, []),
  medidasOrigem: l.medidas_origem as ItemProg["medidasOrigem"],
  trapezio: (l.trapezio as Trapezio | null) ?? null,
  facesPintura: l.faces_pintura as number,
  metrosTelha: l.metros_telha as number,
  metrosChapa: l.metros_chapa as number,
  camposManuais: lerJson<string[]>(l.campos_manuais, []),
  situacao: l.situacao_pcp as Situacao,
  dataProgramacao: (l.data_programacao as string | null) ?? null,
  dataLiberacaoProducao: (l.data_liberacao_producao as string | null) ?? null,
  dataProduzida: (l.data_produzida as string | null) ?? null,
  dataEntregaRealizada: (l.data_entrega_realizada as string | null) ?? null,
  fornecedorTerceiro: l.fornecedor_terceiro as string,
  dataEntregaTerceiro: (l.data_entrega_terceiro as string | null) ?? null,
  removidoNoErp: l.removido_no_erp === 1,
  alteradoNoErp: l.alterado_no_erp === 1,
  nomusHash: l.nomus_hash as string,
  createdAt: l.created_at as string,
  updatedAt: l.updated_at as string,
  updatedBy: l.updated_by as string,
});

const paraProduto = (l: Linha): ProdutoCache => ({
  nomusId: l.nomus_id as number,
  codigo: l.codigo as string,
  descricao: l.descricao as string,
  tipoProduto: l.tipo_produto as string,
  unidade: l.unidade as string,
  categoria: l.categoria as Categoria,
  categoriaManual: l.categoria_manual === 1,
  buscadoEm: l.buscado_em as string,
});

const paraConsumo = (l: Linha): ConsumoRow => ({
  id: l.id as number,
  itemId: l.item_id as number,
  material: l.material as string,
  corId: (l.cor_id as number | null) ?? null,
  quantidade: l.quantidade as number,
  unidade: l.unidade as string,
  origem: l.origem as ConsumoRow["origem"],
  calculadoEm: l.calculado_em as string,
});

const paraEvento = (l: Linha): EventoRow => ({
  id: l.id as number,
  entidade: l.entidade as string,
  entidadeId: l.entidade_id as number,
  pedidoId: (l.pedido_id as number | null) ?? null,
  campo: l.campo as string,
  valorAntigo: (l.valor_antigo as string | null) ?? null,
  valorNovo: (l.valor_novo as string | null) ?? null,
  usuario: l.usuario as string,
  origem: l.origem as string,
  em: l.em as string,
});

/** Colunas de pedido gravadas pela sincronização (dono = Nomus). Tudo o mais é do PCP. */
export interface PedidoNomusCampos {
  numeroPedido: number;
  dataPedido: string | null;
  clienteNome: string;
  clienteTelefone: string;
  cidade: string;
  uf: string;
  valorCentavos: number | null;
  statusNomus: string;
  dataEntregaOriginal: string | null;
  nomusHash: string;
}

export interface ItemNomusCampos {
  itemSeq: string;
  produtoNomusId: number | null;
  produtoCodigo: string;
  descricaoProduto: string;
  infoAdicional: string;
  quantidade: number | null;
  nomusHash: string;
}

/** Campos derivados do item (do texto da Nomus), refeitos quando a Nomus muda, exceto os corrigidos à mão. */
export interface ItemDerivado {
  categoria: Categoria;
  tipoPintura: TipoPintura | null;
  corId: number | null;
  medidas: Medida[];
  medidasOrigem: ItemProg["medidasOrigem"];
  trapezio: Trapezio | null;
  facesPintura: number;
  metrosTelha: number;
  metrosChapa: number;
}

export class ProgramacaoRepository {
  constructor(private readonly db: DatabaseSync) {
    this.semear();
    inTransaction(this.db, () => this.preencherRotasFaltantes());
  }

  /** Catálogos iniciais (rotas, cores, materiais, parâmetros). Idempotente: nunca sobrescreve o que a equipe editou. */
  private semear(): void {
    inTransaction(this.db, () => {
      const rota = this.db.prepare("INSERT OR IGNORE INTO pcp_rota (id, nome) VALUES (?, ?)");
      for (const [id, nome] of ROTAS_INICIAIS) rota.run(id, nome);

      const cidade = this.db.prepare("INSERT OR IGNORE INTO pcp_cidade_rota (cidade_chave, cidade, rota_id) VALUES (?, ?, ?)");
      for (const [nome, rotaId] of CIDADES_INICIAIS) cidade.run(chaveCidade(nome), nome, rotaId);

      const cor = this.db.prepare("INSERT OR IGNORE INTO pcp_cor (nome, ral, palavras) VALUES (?, ?, ?)");
      for (const c of CORES_INICIAIS) cor.run(c.nome, c.ral, JSON.stringify(c.palavras));

      const mat = this.db.prepare("INSERT OR IGNORE INTO pcp_material (codigo, nome, unidade, grupo) VALUES (?, ?, ?, ?)");
      for (const m of MATERIAIS_INICIAIS) mat.run(m.codigo, m.nome, m.unidade, m.grupo);

      const par = this.db.prepare("INSERT OR IGNORE INTO pcp_parametro (chave, valor, descricao) VALUES (?, ?, ?)");
      for (const p of PARAMETROS_INICIAIS) par.run(p.chave, p.valor, p.descricao);
    });
  }

  /** Pedidos sem rota (e sem rota escolhida à mão) que já têm cidade mapeada: preenche. Roda ao abrir, cobrindo cidade cadastrada depois. */
  private preencherRotasFaltantes(): void {
    const sem = this.db.prepare("SELECT id, cidade FROM pcp_pedido WHERE rota_id IS NULL AND rota_manual = 0 AND cidade <> ''").all() as Linha[];
    const upd = this.db.prepare("UPDATE pcp_pedido SET rota_id = ? WHERE id = ?");
    for (const l of sem) {
      const rota = this.rotaDaCidade(chaveCidade(l.cidade as string));
      if (rota !== null) upd.run(rota, l.id as number);
    }
  }

  transacao<T>(fn: () => T): T {
    return inTransaction(this.db, fn);
  }

  // ---------------------------------------------------------------- catálogos

  rotas(): Array<{ id: number; nome: string }> {
    return (this.db.prepare("SELECT id, nome FROM pcp_rota ORDER BY id").all() as Linha[]).map((l) => ({ id: l.id as number, nome: l.nome as string }));
  }

  cores(): Array<{ id: number; nome: string; ral: string; palavras: string[] }> {
    return (this.db.prepare("SELECT * FROM pcp_cor ORDER BY id").all() as Linha[]).map((l) => ({
      id: l.id as number,
      nome: l.nome as string,
      ral: l.ral as string,
      palavras: lerJson<string[]>(l.palavras, []),
    }));
  }

  materiais(): Array<{ codigo: string; nome: string; unidade: string; grupo: string }> {
    return (this.db.prepare("SELECT * FROM pcp_material ORDER BY rowid").all() as Linha[]).map((l) => ({
      codigo: l.codigo as string,
      nome: l.nome as string,
      unidade: l.unidade as string,
      grupo: l.grupo as string,
    }));
  }

  parametros(): Array<{ chave: string; valor: number; descricao: string }> {
    return (this.db.prepare("SELECT * FROM pcp_parametro ORDER BY rowid").all() as Linha[]).map((l) => ({
      chave: l.chave as string,
      valor: l.valor as number,
      descricao: l.descricao as string,
    }));
  }

  parametro(chave: string): number {
    const l = this.db.prepare("SELECT valor FROM pcp_parametro WHERE chave = ?").get(chave) as Linha | undefined;
    if (l) return l.valor as number;
    return PARAMETROS_INICIAIS.find((p) => p.chave === chave)?.valor ?? 0;
  }

  definirParametro(chave: string, valor: number): boolean {
    return Number(this.db.prepare("UPDATE pcp_parametro SET valor = ? WHERE chave = ?").run(valor, chave).changes) === 1;
  }

  rotaDaCidade(chave: string): number | null {
    const l = this.db.prepare("SELECT rota_id FROM pcp_cidade_rota WHERE cidade_chave = ?").get(chave) as Linha | undefined;
    return l ? (l.rota_id as number) : null;
  }

  salvarCidadeRota(chave: string, cidade: string, rotaId: number): void {
    this.db
      .prepare(
        `INSERT INTO pcp_cidade_rota (cidade_chave, cidade, rota_id) VALUES (?, ?, ?)
         ON CONFLICT(cidade_chave) DO UPDATE SET cidade = excluded.cidade, rota_id = excluded.rota_id`
      )
      .run(chave, cidade, rotaId);
  }

  contarCidadesRota(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM pcp_cidade_rota").get() as { n: number }).n;
  }

  // ---------------------------------------------------------------- produtos

  buscarProduto(nomusId: number): ProdutoCache | null {
    const l = this.db.prepare("SELECT * FROM pcp_produto_nomus WHERE nomus_id = ?").get(nomusId) as Linha | undefined;
    return l ? paraProduto(l) : null;
  }

  listarProdutos(): ProdutoCache[] {
    return (this.db.prepare("SELECT * FROM pcp_produto_nomus ORDER BY descricao").all() as Linha[]).map(paraProduto);
  }

  /** Grava o produto da Nomus. Categoria corrigida à mão (categoria_manual) nunca é sobrescrita pelo de-para. */
  salvarProduto(p: Omit<ProdutoCache, "categoriaManual">): void {
    this.db
      .prepare(
        `INSERT INTO pcp_produto_nomus (nomus_id, codigo, descricao, tipo_produto, unidade, categoria, buscado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(nomus_id) DO UPDATE SET codigo = excluded.codigo, descricao = excluded.descricao,
           tipo_produto = excluded.tipo_produto, unidade = excluded.unidade, buscado_em = excluded.buscado_em,
           categoria = CASE WHEN pcp_produto_nomus.categoria_manual = 1 THEN pcp_produto_nomus.categoria ELSE excluded.categoria END`
      )
      .run(p.nomusId, p.codigo, p.descricao, p.tipoProduto, p.unidade, p.categoria, p.buscadoEm);
  }

  definirCategoriaProduto(nomusId: number, categoria: Categoria): boolean {
    return (
      Number(this.db.prepare("UPDATE pcp_produto_nomus SET categoria = ?, categoria_manual = 1 WHERE nomus_id = ?").run(categoria, nomusId).changes) === 1
    );
  }

  // ---------------------------------------------------------------- pedidos

  buscarPedidoPorNomus(nomusPedidoId: number): PedidoProg | null {
    const l = this.db.prepare("SELECT * FROM pcp_pedido WHERE nomus_pedido_id = ?").get(nomusPedidoId) as Linha | undefined;
    return l ? paraPedido(l) : null;
  }

  buscarPedido(id: number): PedidoProg | null {
    const l = this.db.prepare("SELECT * FROM pcp_pedido WHERE id = ?").get(id) as Linha | undefined;
    return l ? paraPedido(l) : null;
  }

  pedidosPorNumero(numero: number): PedidoProg[] {
    return (this.db.prepare("SELECT * FROM pcp_pedido WHERE numero_pedido = ? ORDER BY id").all(numero) as Linha[]).map(paraPedido);
  }

  listarPedidos(): PedidoProg[] {
    return (this.db.prepare("SELECT * FROM pcp_pedido").all() as Linha[]).map(paraPedido);
  }

  inserirPedido(nomusPedidoId: number, c: PedidoNomusCampos, rotaId: number | null, agora: string): number {
    const r = this.db
      .prepare(
        `INSERT INTO pcp_pedido (nomus_pedido_id, numero_pedido, data_pedido, cliente_nome, cliente_telefone, cidade, uf, rota_id,
                                 data_entrega_cliente_original, valor_centavos, status_nomus, nomus_hash, nomus_sincronizado_em,
                                 created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sync')`
      )
      .run(
        nomusPedidoId, c.numeroPedido, c.dataPedido, c.clienteNome, c.clienteTelefone,
        c.cidade, c.uf, rotaId, c.dataEntregaOriginal, c.valorCentavos, c.statusNomus, c.nomusHash, agora, agora, agora
      );
    return Number(r.lastInsertRowid);
  }

  /**
   * Atualiza SÓ as colunas que pertencem à Nomus. Não toca em situação, datas, observação, prazo negociado nem rota manual,
   * e NUNCA no prazo original (imutável depois da primeira carga). A rota só muda se não foi escolhida à mão.
   */
  atualizarPedidoNomus(id: number, c: Omit<PedidoNomusCampos, "dataEntregaOriginal">, rotaId: number | null, agora: string): void {
    this.db
      .prepare(
        `UPDATE pcp_pedido SET numero_pedido = ?, data_pedido = ?, cliente_nome = ?, cliente_telefone = ?, cidade = ?, uf = ?,
           valor_centavos = ?, status_nomus = ?, nomus_hash = ?, nomus_sincronizado_em = ?, updated_at = ?, updated_by = 'sync',
           rota_id = CASE WHEN rota_manual = 1 THEN rota_id ELSE ? END
         WHERE id = ?`
      )
      .run(c.numeroPedido, c.dataPedido, c.clienteNome, c.clienteTelefone, c.cidade, c.uf, c.valorCentavos, c.statusNomus, c.nomusHash, agora, agora, rotaId, id);
  }

  /** Quando o prazo original ainda estava vazio e a Nomus passou a ter data, grava (uma vez). */
  preencherPrazoOriginal(id: number, data: string): void {
    this.db.prepare("UPDATE pcp_pedido SET data_entrega_cliente_original = ? WHERE id = ? AND data_entrega_cliente_original IS NULL").run(data, id);
  }

  /** Edição do PCP no pedido (colunas permitidas). */
  atualizarPedidoPcp(
    id: number,
    campos: Partial<{ dataEntregaNegociada: string | null; observacao: string; rotaId: number | null; rotaManual: boolean }>,
    usuario: string,
    agora: string
  ): void {
    const mapa: Record<string, string> = {
      dataEntregaNegociada: "data_entrega_cliente_negociada",
      observacao: "observacao",
      rotaId: "rota_id",
      rotaManual: "rota_manual",
    };
    const chaves = Object.keys(campos).filter((k) => k in mapa);
    if (chaves.length === 0) return;
    const sets = chaves.map((k) => `${mapa[k]} = ?`).join(", ");
    const valores = chaves.map((k) => {
      const v = (campos as Record<string, unknown>)[k];
      return typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null);
    });
    this.db.prepare(`UPDATE pcp_pedido SET ${sets}, updated_at = ?, updated_by = ? WHERE id = ?`).run(...(valores as never[]), agora, usuario, id);
  }

  /** Recalcula a rota dos pedidos de uma cidade (quando o de-para muda), exceto os com rota escolhida à mão. */
  aplicarRotaNaCidade(chaveCidadeNormalizada: (cidade: string) => string, cidadeChave: string, rotaId: number): number {
    const alvo = (this.db.prepare("SELECT id, cidade FROM pcp_pedido WHERE rota_manual = 0").all() as Linha[]).filter(
      (l) => chaveCidadeNormalizada(l.cidade as string) === cidadeChave
    );
    const upd = this.db.prepare("UPDATE pcp_pedido SET rota_id = ? WHERE id = ? AND (rota_id IS NOT ?)");
    let n = 0;
    for (const l of alvo) n += Number(upd.run(rotaId, l.id as number, rotaId).changes);
    return n;
  }

  // ---------------------------------------------------------------- itens

  buscarItem(id: number): ItemProg | null {
    const l = this.db.prepare("SELECT * FROM pcp_pedido_item WHERE id = ?").get(id) as Linha | undefined;
    return l ? paraItem(l) : null;
  }

  buscarItemPorNomus(nomusItemId: number): ItemProg | null {
    const l = this.db.prepare("SELECT * FROM pcp_pedido_item WHERE nomus_item_id = ?").get(nomusItemId) as Linha | undefined;
    return l ? paraItem(l) : null;
  }

  itensDoPedido(pedidoId: number): ItemProg[] {
    return (this.db.prepare("SELECT * FROM pcp_pedido_item WHERE pedido_id = ? ORDER BY item_seq, id").all(pedidoId) as Linha[]).map(paraItem);
  }

  listarItens(): ItemProg[] {
    return (this.db.prepare("SELECT * FROM pcp_pedido_item").all() as Linha[]).map(paraItem);
  }

  inserirItem(pedidoId: number, n: ItemNomusCampos & { nomusItemId: number }, d: ItemDerivado, situacao: Situacao, agora: string): number {
    const r = this.db
      .prepare(
        `INSERT INTO pcp_pedido_item (pedido_id, nomus_item_id, item_seq, produto_nomus_id, produto_codigo, produto_categoria, tipo_pintura,
           cor_id, descricao_produto, info_adicional, quantidade, medidas, medidas_origem, trapezio, faces_pintura, metros_telha,
           metros_chapa, situacao_pcp, nomus_hash, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sync')`
      )
      .run(
        pedidoId, n.nomusItemId, n.itemSeq, n.produtoNomusId, n.produtoCodigo, d.categoria, d.tipoPintura, d.corId, n.descricaoProduto,
        n.infoAdicional, n.quantidade, JSON.stringify(d.medidas), d.medidasOrigem, d.trapezio, d.facesPintura, d.metrosTelha, d.metrosChapa,
        situacao, n.nomusHash, agora, agora
      );
    return Number(r.lastInsertRowid);
  }

  /** Reescreve os campos Nomus e os derivados do item. Situação, datas e demais campos do PCP ficam como estão. */
  atualizarItemNomus(id: number, n: ItemNomusCampos, d: ItemDerivado, alteradoNoErp: boolean, agora: string): void {
    this.db
      .prepare(
        `UPDATE pcp_pedido_item SET item_seq = ?, produto_nomus_id = ?, produto_codigo = ?, descricao_produto = ?, info_adicional = ?,
           quantidade = ?, nomus_hash = ?, produto_categoria = ?, tipo_pintura = ?, cor_id = ?, medidas = ?, medidas_origem = ?,
           trapezio = ?, faces_pintura = ?, metros_telha = ?, metros_chapa = ?, removido_no_erp = 0,
           alterado_no_erp = CASE WHEN ? = 1 THEN 1 ELSE alterado_no_erp END, updated_at = ?, updated_by = 'sync'
         WHERE id = ?`
      )
      .run(
        n.itemSeq, n.produtoNomusId, n.produtoCodigo, n.descricaoProduto, n.infoAdicional, n.quantidade, n.nomusHash, d.categoria,
        d.tipoPintura, d.corId, JSON.stringify(d.medidas), d.medidasOrigem, d.trapezio, d.facesPintura, d.metrosTelha, d.metrosChapa,
        alteradoNoErp ? 1 : 0, agora, id
      );
  }

  /** Só os derivados (quando a categoria do produto ou um parâmetro muda; a Nomus não mudou). */
  atualizarItemDerivado(id: number, d: ItemDerivado, agora: string, usuario: string): void {
    this.db
      .prepare(
        `UPDATE pcp_pedido_item SET produto_categoria = ?, tipo_pintura = ?, cor_id = ?, medidas = ?, medidas_origem = ?, trapezio = ?,
           faces_pintura = ?, metros_telha = ?, metros_chapa = ?, updated_at = ?, updated_by = ? WHERE id = ?`
      )
      .run(d.categoria, d.tipoPintura, d.corId, JSON.stringify(d.medidas), d.medidasOrigem, d.trapezio, d.facesPintura, d.metrosTelha, d.metrosChapa, agora, usuario, id);
  }

  marcarRemovidoNoErp(id: number, removido: boolean, agora: string): void {
    this.db.prepare("UPDATE pcp_pedido_item SET removido_no_erp = ?, updated_at = ?, updated_by = 'sync' WHERE id = ?").run(removido ? 1 : 0, agora, id);
  }

  limparAlteradoNoErp(id: number): void {
    this.db.prepare("UPDATE pcp_pedido_item SET alterado_no_erp = 0 WHERE id = ?").run(id);
  }

  /** Edição do PCP no item (campos permitidos). */
  atualizarItemPcp(id: number, campos: Record<string, unknown>, camposManuais: string[] | null, usuario: string, agora: string): void {
    const mapa: Record<string, string> = {
      situacao: "situacao_pcp",
      dataProgramacao: "data_programacao",
      dataLiberacaoProducao: "data_liberacao_producao",
      dataProduzida: "data_produzida",
      dataEntregaRealizada: "data_entrega_realizada",
      fornecedorTerceiro: "fornecedor_terceiro",
      dataEntregaTerceiro: "data_entrega_terceiro",
      categoria: "produto_categoria",
      tipoPintura: "tipo_pintura",
      corId: "cor_id",
      facesPintura: "faces_pintura",
      trapezio: "trapezio",
      metrosChapa: "metros_chapa",
      metrosTelha: "metros_telha",
      medidasOrigem: "medidas_origem",
    };
    const chaves = Object.keys(campos).filter((k) => k in mapa);
    const sets = chaves.map((k) => `${mapa[k]} = ?`);
    const valores: unknown[] = chaves.map((k) => campos[k] ?? null);
    if ("medidas" in campos) {
      sets.push("medidas = ?");
      valores.push(JSON.stringify(campos.medidas));
    }
    if (camposManuais) {
      sets.push("campos_manuais = ?");
      valores.push(JSON.stringify(camposManuais));
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE pcp_pedido_item SET ${sets.join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`).run(...(valores as never[]), agora, usuario, id);
  }

  // ---------------------------------------------------------------- OPs

  opsDoItem(itemId: number): OpItem[] {
    return (this.db.prepare("SELECT * FROM pcp_item_op WHERE item_id = ? ORDER BY numero_op").all(itemId) as Linha[]).map((l) => ({
      itemId: l.item_id as number,
      nomusOpId: l.nomus_op_id as number,
      numeroOp: l.numero_op as string,
      statusOp: l.status_op as string,
      inicioPlanejado: (l.inicio_planejado as string | null) ?? null,
    }));
  }

  todasAsOps(): OpItem[] {
    return (this.db.prepare("SELECT * FROM pcp_item_op ORDER BY numero_op").all() as Linha[]).map((l) => ({
      itemId: l.item_id as number,
      nomusOpId: l.nomus_op_id as number,
      numeroOp: l.numero_op as string,
      statusOp: l.status_op as string,
      inicioPlanejado: (l.inicio_planejado as string | null) ?? null,
    }));
  }

  /** Substitui as OPs do item pelas que a Nomus devolveu agora. Devolve true se algo mudou. */
  substituirOps(itemId: number, ops: Array<Omit<OpItem, "itemId">>): boolean {
    const atuais = this.opsDoItem(itemId);
    const chave = (o: Omit<OpItem, "itemId">) => `${o.nomusOpId}|${o.numeroOp}|${o.statusOp}|${o.inicioPlanejado ?? ""}`;
    const antes = atuais.map(chave).sort().join(";");
    const depois = ops.map(chave).sort().join(";");
    if (antes === depois) return false;

    this.db.prepare("DELETE FROM pcp_item_op WHERE item_id = ?").run(itemId);
    const ins = this.db.prepare("INSERT OR REPLACE INTO pcp_item_op (item_id, nomus_op_id, numero_op, status_op, inicio_planejado) VALUES (?, ?, ?, ?, ?)");
    for (const o of ops) ins.run(itemId, o.nomusOpId, o.numeroOp, o.statusOp, o.inicioPlanejado);
    return true;
  }

  // ---------------------------------------------------------------- consumos

  consumosDoItem(itemId: number): ConsumoRow[] {
    return (this.db.prepare("SELECT * FROM pcp_item_consumo WHERE item_id = ? ORDER BY id").all(itemId) as Linha[]).map(paraConsumo);
  }

  todosOsConsumos(): ConsumoRow[] {
    return (this.db.prepare("SELECT * FROM pcp_item_consumo ORDER BY id").all() as Linha[]).map(paraConsumo);
  }

  /** Troca só os consumos calculados do item (os lançados à mão ou vindos da Nomus ficam). */
  substituirConsumosCalculados(
    itemId: number,
    consumos: Array<{ material: string; corId: number | null; quantidade: number; unidade: string }>,
    agora: string
  ): void {
    this.db.prepare("DELETE FROM pcp_item_consumo WHERE item_id = ? AND origem = 'calculado'").run(itemId);
    const ins = this.db.prepare(
      "INSERT INTO pcp_item_consumo (item_id, material, cor_id, quantidade, unidade, origem, calculado_em) VALUES (?, ?, ?, ?, ?, 'calculado', ?)"
    );
    for (const c of consumos) ins.run(itemId, c.material, c.corId, c.quantidade, c.unidade, agora);
  }

  definirConsumoManual(itemId: number, material: string, corId: number | null, quantidade: number, unidade: string, agora: string): void {
    this.db.prepare("DELETE FROM pcp_item_consumo WHERE item_id = ? AND material = ? AND origem = 'manual' AND cor_id IS ?").run(itemId, material, corId);
    if (quantidade > 0) {
      this.db
        .prepare("INSERT INTO pcp_item_consumo (item_id, material, cor_id, quantidade, unidade, origem, calculado_em) VALUES (?, ?, ?, ?, ?, 'manual', ?)")
        .run(itemId, material, corId, quantidade, unidade, agora);
    }
  }

  // ---------------------------------------------------------------- eventos

  registrarEvento(e: NovoEvento): void {
    this.db
      .prepare(
        `INSERT INTO pcp_evento (entidade, entidade_id, pedido_id, campo, valor_antigo, valor_novo, usuario, origem, em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(e.entidade, e.entidadeId, e.pedidoId, e.campo, texto(e.valorAntigo), texto(e.valorNovo), e.usuario, e.origem ?? "usuario", e.em);
  }

  eventosDoPedido(pedidoId: number): EventoRow[] {
    return (this.db.prepare("SELECT * FROM pcp_evento WHERE pedido_id = ? ORDER BY id DESC LIMIT 500").all(pedidoId) as Linha[]).map(paraEvento);
  }

  // ---------------------------------------------------------------- log da sincronização

  iniciarSyncProgramacao(agora: string): number {
    return Number(this.db.prepare("INSERT INTO pcp_sync_programacao (iniciado_em) VALUES (?)").run(agora).lastInsertRowid);
  }

  atualizarSyncProgramacao(id: number, c: { lidos: number; criados: number; atualizados: number; erros: number; detalheErros: string[] }): void {
    this.db
      .prepare("UPDATE pcp_sync_programacao SET pedidos_lidos = ?, criados = ?, atualizados = ?, erros = ?, detalhe_erros = ? WHERE id = ?")
      .run(c.lidos, c.criados, c.atualizados, c.erros, JSON.stringify(c.detalheErros.slice(0, 50)), id);
  }

  finalizarSyncProgramacao(id: number, agora: string): void {
    this.db.prepare("UPDATE pcp_sync_programacao SET finalizado_em = ? WHERE id = ?").run(agora, id);
  }

  ultimaSyncProgramacao(): {
    id: number;
    iniciadoEm: string;
    finalizadoEm: string | null;
    pedidosLidos: number;
    criados: number;
    atualizados: number;
    erros: number;
    detalheErros: string[];
  } | null {
    const l = this.db.prepare("SELECT * FROM pcp_sync_programacao ORDER BY id DESC LIMIT 1").get() as Linha | undefined;
    if (!l) return null;
    return {
      id: l.id as number,
      iniciadoEm: l.iniciado_em as string,
      finalizadoEm: (l.finalizado_em as string | null) ?? null,
      pedidosLidos: l.pedidos_lidos as number,
      criados: l.criados as number,
      atualizados: l.atualizados as number,
      erros: l.erros as number,
      detalheErros: lerJson<string[]>(l.detalhe_erros, []),
    };
  }
}
