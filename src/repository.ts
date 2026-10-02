import type { DatabaseSync } from "node:sqlite";
import { ACAO_STATUS_PADRAO, STATUS_PCP_FINAIS, STATUS_PCP_PADRAO } from "./constants";
import { inTransaction } from "./db";
import type { HistoricoRow, ItemProducao, PedidoNomus, PedidoRow, SyncRun, TratativaPatch } from "./types";

export interface PessoaCache {
  nomusId: number;
  nome: string;
  telefone: string;
  buscadoEm: string;
}

type Linha = Record<string, unknown>;

/** Campo editável (camelCase, como a API) -> coluna do banco. Whitelist: só isto pode ser editado. */
const COLUNAS_EDITAVEIS: Record<keyof TratativaPatch, string> = {
  statusPcp: "status_pcp",
  atendimento: "atendimento",
  responsavel: "responsavel",
  acao: "acao",
  prazoAcao: "prazo_acao",
  acaoStatus: "acao_status",
  prazoEntrega: "prazo_entrega",
};

/** producao_itens é JSON gravado por nós; se estiver ausente ou corrompido, o pedido só aparece como não programado. */
function lerItensProducao(bruto: unknown): ItemProducao[] {
  if (typeof bruto !== "string" || bruto === "") return [];
  try {
    const lista = JSON.parse(bruto) as unknown;
    return Array.isArray(lista)
      ? lista.filter((i): i is ItemProducao => typeof i?.os === "string" && typeof i?.data === "string")
      : [];
  } catch {
    return [];
  }
}

const paraPedidoRow = (l: Linha): PedidoRow => ({
  nomusId: l.nomus_id as number,
  numero: l.numero as number,
  codigoPedido: l.codigo_pedido as string,
  clienteId: (l.cliente_id as number | null) ?? null,
  clienteNome: l.cliente_nome as string,
  telefone: l.telefone as string,
  prazoEntrega: (l.prazo_entrega as string | null) ?? null,
  primeiroVistoEm: l.primeiro_visto_em as string,
  statusPcp: l.status_pcp as string,
  atendimento: l.atendimento as string,
  responsavel: l.responsavel as string,
  acao: l.acao as string,
  prazoAcao: (l.prazo_acao as string | null) ?? null,
  acaoStatus: l.acao_status as string,
  atualizadoManualEm: (l.atualizado_manual_em as string | null) ?? null,
  prazoProducao: (l.prazo_producao as string | null) ?? null,
  producaoItens: lerItensProducao(l.producao_itens),
});

const paraHistorico = (l: Linha): HistoricoRow => ({
  numero: l.numero as number,
  statusPcp: l.status_pcp as string,
  prazoEntrega: (l.prazo_entrega as string | null) ?? null,
  origem: l.origem as string,
  importadoEm: l.importado_em as string,
});

const paraSyncRun = (l: Linha): SyncRun => ({
  id: l.id as number,
  iniciadoEm: l.iniciado_em as string,
  finalizadoEm: (l.finalizado_em as string | null) ?? null,
  gatilho: l.gatilho as string,
  status: l.status as SyncRun["status"],
  pedidosLidos: l.pedidos_lidos as number,
  novos: l.novos as number,
  erro: (l.erro as string | null) ?? null,
});

export class PcpRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Quais destes pedidos da Nomus já estão no banco. */
  idsExistentes(nomusIds: number[]): Set<number> {
    const consulta = this.db.prepare("SELECT 1 FROM pedidos WHERE nomus_id = ?");
    return new Set(nomusIds.filter((id) => consulta.get(id) !== undefined));
  }

  /**
   * Inclui os pedidos que ainda NÃO estão no banco. Um pedido que já existe é ignorado por inteiro:
   * nada dele é atualizado (nem nome, nem telefone, nem prazo), então o que o PCP digitou ou ajustou
   * nunca é desfeito. Devolve quantos foram realmente incluídos.
   */
  inserirNovos(pedidos: PedidoNomus[], agora: string): number {
    // status_pcp e acao_status vêm explícitos aqui (não do DEFAULT da coluna): um banco já criado antes de uma
    // mudança em STATUS_PCP_PADRAO/ACAO_STATUS_PADRAO manteria o valor antigo gravado no próprio schema do SQLite.
    const inserir = this.db.prepare(`
      INSERT INTO pedidos (nomus_id, numero, codigo_pedido, cliente_id, cliente_nome, telefone,
                           prazo_entrega, primeiro_visto_em, atualizado_nomus_em, status_pcp, acao_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(nomus_id) DO NOTHING
    `);

    return inTransaction(this.db, () => {
      let incluidos = 0;
      for (const p of pedidos) {
        const r = inserir.run(
          p.nomusId, p.numero, p.codigoPedido, p.clienteId, p.clienteNome, p.telefone, p.prazoEntrega, agora, agora,
          STATUS_PCP_PADRAO, ACAO_STATUS_PADRAO
        );
        incluidos += Number(r.changes);
      }
      return incluidos;
    });
  }

  /** Roda `fn` numa transação única (desfeita se lançar). Não aninhar com métodos que abrem a própria transação. */
  transacao<T>(fn: () => T): T {
    return inTransaction(this.db, fn);
  }

  /**
   * Insere um pedido COMPLETO (dados da Nomus + tratativa), usado para restaurar um backup em JSON.
   * Não sobrescreve: se o pedido já existe, devolve false e não muda nada. Não abre transação própria.
   */
  restaurarPedido(p: PedidoRow): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO pedidos (nomus_id, numero, codigo_pedido, cliente_id, cliente_nome, telefone, prazo_entrega,
                              primeiro_visto_em, atualizado_nomus_em,
                              status_pcp, atendimento, responsavel, acao, prazo_acao, acao_status, atualizado_manual_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(nomus_id) DO NOTHING`
      )
      .run(
        p.nomusId, p.numero, p.codigoPedido, p.clienteId, p.clienteNome, p.telefone, p.prazoEntrega,
        p.primeiroVistoEm, p.primeiroVistoEm,
        p.statusPcp, p.atendimento, p.responsavel, p.acao, p.prazoAcao, p.acaoStatus, p.atualizadoManualEm
      );
    return Number(r.changes) === 1;
  }

  /**
   * Reescreve a programação da produção de TODOS os pedidos: quem está no mapa recebe a data e as ordens; quem não
   * está volta a "não programado" (foi tirado do calendário). Mexe SÓ em prazo_producao/producao_itens — nunca em
   * dado da Nomus nem do PCP, e não conta como edição manual. Devolve quantos pedidos mudaram.
   */
  aplicarProducao(programacao: Map<number, { prazoProducao: string; itens: ItemProducao[] }>): number {
    const atuais = this.db.prepare("SELECT nomus_id, prazo_producao, producao_itens FROM pedidos").all() as Linha[];
    const atualizar = this.db.prepare("UPDATE pedidos SET prazo_producao = ?, producao_itens = ? WHERE nomus_id = ?");

    return inTransaction(this.db, () => {
      let mudaram = 0;
      for (const l of atuais) {
        const alvo = programacao.get(l.nomus_id as number);
        const novoPrazo = alvo?.prazoProducao ?? null;
        const novosItens = alvo ? JSON.stringify(alvo.itens) : null;
        const antigoPrazo = (l.prazo_producao as string | null) ?? null;
        const antigosItens = (l.producao_itens as string | null) ?? null;

        if (novoPrazo === antigoPrazo && novosItens === antigosItens) continue;
        atualizar.run(novoPrazo, novosItens, l.nomus_id as number);
        mudaram++;
      }
      return mudaram;
    });
  }

  /** Quantos pedidos têm hoje uma programação de produção gravada. */
  contarProgramados(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM pedidos WHERE prazo_producao IS NOT NULL").get() as { n: number };
    return row.n;
  }

  /** Todos os pedidos (id, número) para casar com o Planejamento, inclusive os já encerrados. */
  idsENumeros(): Array<{ nomusId: number; numero: number }> {
    return (this.db.prepare("SELECT nomus_id, numero FROM pedidos").all() as Linha[]).map((l) => ({
      nomusId: l.nomus_id as number,
      numero: l.numero as number,
    }));
  }

  contar(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM pedidos").get() as { n: number };
    return row.n;
  }

  /** Pedidos da tabela: por padrão, os que o PCP ainda não encerrou nem cancelou. */
  listar(opcoes: { incluirFinalizados?: boolean } = {}): PedidoRow[] {
    const filtroFinais = opcoes.incluirFinalizados
      ? ""
      : `WHERE status_pcp NOT IN (${STATUS_PCP_FINAIS.map(() => "?").join(", ")})`;

    const linhas = this.db
      .prepare(`SELECT * FROM pedidos ${filtroFinais} ORDER BY prazo_entrega IS NULL, prazo_entrega ASC, numero ASC`)
      .all(...(opcoes.incluirFinalizados ? [] : STATUS_PCP_FINAIS)) as Linha[];

    return linhas.map(paraPedidoRow);
  }

  /** Pedido pelo NÚMERO (o que o cliente digita). Se houver mais de um com o mesmo número, vale o mais recente. */
  buscarPorNumero(numero: number): PedidoRow | null {
    const linha = this.db.prepare("SELECT * FROM pedidos WHERE numero = ? ORDER BY nomus_id DESC LIMIT 1").get(numero) as Linha | undefined;
    return linha ? paraPedidoRow(linha) : null;
  }

  // ---- histórico (pedidos antigos, só para a consulta pública) ----

  buscarHistorico(numero: number): HistoricoRow | null {
    const l = this.db.prepare("SELECT * FROM historico_pedidos WHERE numero = ?").get(numero) as Linha | undefined;
    return l ? paraHistorico(l) : null;
  }

  /**
   * Lista o histórico. Tolera um banco de formato antigo, sem a tabela (o `exportar` só lê e não migra o banco
   * de quem está com ele aberto): nesse caso não há histórico.
   */
  listarHistorico(): HistoricoRow[] {
    const existe = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'historico_pedidos'").get();
    if (!existe) return [];
    return (this.db.prepare("SELECT * FROM historico_pedidos ORDER BY numero").all() as Linha[]).map(paraHistorico);
  }

  /** Insere um pedido do histórico sem sobrescrever. Não abre transação própria. */
  restaurarHistorico(h: HistoricoRow): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO historico_pedidos (numero, status_pcp, prazo_entrega, origem, importado_em) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(numero) DO NOTHING`
      )
      .run(h.numero, h.statusPcp, h.prazoEntrega, h.origem, h.importadoEm);
    return Number(r.changes) === 1;
  }

  buscar(nomusId: number): PedidoRow | null {
    const linha = this.db.prepare("SELECT * FROM pedidos WHERE nomus_id = ?").get(nomusId) as Linha | undefined;
    return linha ? paraPedidoRow(linha) : null;
  }

  /** Atualiza só os campos editáveis informados. Devolve a linha atualizada, ou null se o pedido não existe. */
  atualizarTratativa(nomusId: number, patch: TratativaPatch, agora: string): PedidoRow | null {
    if (!this.buscar(nomusId)) return null;

    const campos = (Object.keys(patch) as Array<keyof TratativaPatch>).filter((k) => k in COLUNAS_EDITAVEIS);

    if (campos.length > 0) {
      const sets = campos.map((k) => `${COLUNAS_EDITAVEIS[k]} = ?`).join(", ");
      const valores = campos.map((k) => patch[k] ?? null);
      this.db
        .prepare(`UPDATE pedidos SET ${sets}, atualizado_manual_em = ? WHERE nomus_id = ?`)
        .run(...valores, agora, nomusId);
    }

    return this.buscar(nomusId);
  }

  // ---- cache de clientes (pessoas da Nomus) ----

  buscarPessoas(ids: number[]): Map<number, PessoaCache> {
    const mapa = new Map<number, PessoaCache>();
    const consulta = this.db.prepare("SELECT * FROM pessoas WHERE nomus_id = ?");

    for (const id of ids) {
      const l = consulta.get(id) as Linha | undefined;
      if (l) {
        mapa.set(id, {
          nomusId: l.nomus_id as number,
          nome: l.nome as string,
          telefone: l.telefone as string,
          buscadoEm: l.buscado_em as string,
        });
      }
    }

    return mapa;
  }

  salvarPessoas(pessoas: PessoaCache[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO pessoas (nomus_id, nome, telefone, buscado_em) VALUES (?, ?, ?, ?)
      ON CONFLICT(nomus_id) DO UPDATE SET nome = excluded.nome, telefone = excluded.telefone, buscado_em = excluded.buscado_em
    `);

    inTransaction(this.db, () => {
      for (const p of pessoas) upsert.run(p.nomusId, p.nome, p.telefone, p.buscadoEm);
    });
  }

  // ---- histórico de sincronizações ----

  iniciarSync(gatilho: string, agora: string): number {
    const r = this.db
      .prepare("INSERT INTO sync_runs (iniciado_em, gatilho, status) VALUES (?, ?, 'executando')")
      .run(agora, gatilho);
    return Number(r.lastInsertRowid);
  }

  /** Chamado a cada página lida, para a tela mostrar o andamento de uma rodada longa. */
  atualizarProgressoSync(id: number, pedidosLidos: number, novos: number): void {
    this.db.prepare("UPDATE sync_runs SET pedidos_lidos = ?, novos = ? WHERE id = ?").run(pedidosLidos, novos, id);
  }

  buscarSync(id: number): SyncRun | null {
    const l = this.db.prepare("SELECT * FROM sync_runs WHERE id = ?").get(id) as Linha | undefined;
    return l ? paraSyncRun(l) : null;
  }

  finalizarSync(
    id: number,
    resultado: { status: "ok" | "erro"; pedidosLidos: number; novos: number; erro: string | null },
    agora: string
  ): void {
    this.db
      .prepare("UPDATE sync_runs SET finalizado_em = ?, status = ?, pedidos_lidos = ?, novos = ?, erro = ? WHERE id = ?")
      .run(agora, resultado.status, resultado.pedidosLidos, resultado.novos, resultado.erro, id);
  }

  /** Rodadas que ficaram "executando" porque o processo caiu no meio: viram erro no próximo boot. */
  encerrarSyncsOrfaos(agora: string): void {
    this.db
      .prepare(
        `UPDATE sync_runs SET status = 'erro', finalizado_em = ?, erro = 'Interrompida: o servidor reiniciou durante a sincronização'
         WHERE status = 'executando'`
      )
      .run(agora);
  }

  ultimaSync(apenasSucesso = false): SyncRun | null {
    const filtro = apenasSucesso ? "WHERE status = 'ok'" : "";
    const l = this.db.prepare(`SELECT * FROM sync_runs ${filtro} ORDER BY id DESC LIMIT 1`).get() as Linha | undefined;
    return l ? paraSyncRun(l) : null;
  }
}
