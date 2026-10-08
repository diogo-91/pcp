import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ACAO_STATUS_PADRAO, STATUS_PCP_PADRAO } from "./constants";

/**
 * Migrações em ordem. `PRAGMA user_version` guarda quantas já rodaram, então para
 * evoluir o schema basta ACRESCENTAR um item novo — nunca editar os antigos, porque
 * o banco de produção já passou por eles.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE pedidos (
    nomus_id            INTEGER PRIMARY KEY,
    numero              INTEGER NOT NULL,
    codigo_pedido       TEXT    NOT NULL,
    cliente_id          INTEGER,
    cliente_nome        TEXT    NOT NULL DEFAULT '',
    telefone            TEXT    NOT NULL DEFAULT '',
    prazo_entrega       TEXT,
    -- A coluna liberado não é mais usada: a sincronização só inclui pedidos novos e nunca altera nem retira os existentes.
    liberado            INTEGER NOT NULL DEFAULT 1,
    primeiro_visto_em   TEXT    NOT NULL,
    atualizado_nomus_em TEXT    NOT NULL,

    status_pcp           TEXT NOT NULL DEFAULT '${STATUS_PCP_PADRAO}',
    atendimento          TEXT NOT NULL DEFAULT '',
    responsavel          TEXT NOT NULL DEFAULT '',
    acao                 TEXT NOT NULL DEFAULT '',
    prazo_acao           TEXT,
    acao_status          TEXT NOT NULL DEFAULT '${ACAO_STATUS_PADRAO}',
    atualizado_manual_em TEXT
  );
  CREATE INDEX idx_pedidos_numero ON pedidos (numero);
  CREATE INDEX idx_pedidos_liberado_prazo ON pedidos (liberado, prazo_entrega);

  CREATE TABLE pessoas (
    nomus_id   INTEGER PRIMARY KEY,
    nome       TEXT NOT NULL DEFAULT '',
    telefone   TEXT NOT NULL DEFAULT '',
    buscado_em TEXT NOT NULL
  );

  CREATE TABLE sync_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    iniciado_em   TEXT NOT NULL,
    finalizado_em TEXT,
    gatilho       TEXT NOT NULL,
    status        TEXT NOT NULL,
    pedidos_lidos INTEGER NOT NULL DEFAULT 0,
    novos         INTEGER NOT NULL DEFAULT 0,
    removidos     INTEGER NOT NULL DEFAULT 0,
    erro          TEXT
  );
  `,
  // Pedidos antigos que não estão mais liberados na Nomus (vieram da planilha do PCP, quase todos encerrados).
  // Servem só para o site público continuar respondendo a consulta de um pedido já entregue; a tabela do PCP
  // não os mostra e a sincronização não mexe neles.
  `
  CREATE TABLE historico_pedidos (
    numero        INTEGER PRIMARY KEY,
    status_pcp    TEXT NOT NULL,
    prazo_entrega TEXT,
    origem        TEXT NOT NULL,
    importado_em  TEXT NOT NULL
  );
  `,
  // Programação da produção, vinda do Planejamento do sistema de apontamento (ordens agendadas no calendário).
  // Não é digitada no PCP nem vem da Nomus: é derivada e reescrita a cada leitura do planejamento, por isso
  // fica em colunas próprias (a sincronização da Nomus e as edições do PCP nunca passam por elas).
  // prazo_producao = a data MAIS TARDIA entre as ordens do pedido; producao_itens = JSON [{os, data}].
  `
  ALTER TABLE pedidos ADD COLUMN prazo_producao TEXT;
  ALTER TABLE pedidos ADD COLUMN producao_itens TEXT;
  `,
  // Módulo Programação de Produção (substitui a aba Base da planilha). Tabelas próprias, separadas da tabela de
  // pedidos do PCP: a sincronização da Nomus só escreve as colunas "Nomus"; situação, datas, observação e rota são do PCP.
  `
  ALTER TABLE pessoas ADD COLUMN municipio TEXT;
  ALTER TABLE pessoas ADD COLUMN uf TEXT;

  CREATE TABLE pcp_rota (
    id   INTEGER PRIMARY KEY,
    nome TEXT NOT NULL
  );
  CREATE TABLE pcp_cidade_rota (
    cidade_chave TEXT PRIMARY KEY,
    cidade       TEXT NOT NULL,
    rota_id      INTEGER NOT NULL REFERENCES pcp_rota(id)
  );
  CREATE TABLE pcp_cor (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    nome    TEXT NOT NULL UNIQUE,
    ral     TEXT NOT NULL DEFAULT '',
    palavras TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE pcp_material (
    codigo  TEXT PRIMARY KEY,
    nome    TEXT NOT NULL,
    unidade TEXT NOT NULL,
    grupo   TEXT NOT NULL
  );
  CREATE TABLE pcp_parametro (
    chave     TEXT PRIMARY KEY,
    valor     REAL NOT NULL,
    descricao TEXT NOT NULL DEFAULT ''
  );
  -- Cache dos produtos da Nomus + de-para para a categoria (corrigível: categoria_manual = 1 não é refeita).
  CREATE TABLE pcp_produto_nomus (
    nomus_id         INTEGER PRIMARY KEY,
    codigo           TEXT NOT NULL DEFAULT '',
    descricao        TEXT NOT NULL DEFAULT '',
    tipo_produto     TEXT NOT NULL DEFAULT '',
    unidade          TEXT NOT NULL DEFAULT '',
    categoria        TEXT NOT NULL,
    categoria_manual INTEGER NOT NULL DEFAULT 0,
    buscado_em       TEXT NOT NULL
  );

  CREATE TABLE pcp_pedido (
    id                              INTEGER PRIMARY KEY AUTOINCREMENT,
    nomus_pedido_id                 INTEGER NOT NULL UNIQUE,
    numero_pedido                   INTEGER NOT NULL,
    data_pedido                     TEXT,
    cliente_nome                    TEXT NOT NULL DEFAULT '',
    cliente_telefone                TEXT NOT NULL DEFAULT '',
    cidade                          TEXT NOT NULL DEFAULT '',
    uf                              TEXT NOT NULL DEFAULT '',
    rota_id                         INTEGER REFERENCES pcp_rota(id),
    rota_manual                     INTEGER NOT NULL DEFAULT 0,
    data_entrega_cliente_original   TEXT,
    data_entrega_cliente_negociada  TEXT,
    valor_centavos                  INTEGER,
    status_nomus                    TEXT NOT NULL DEFAULT '',
    observacao                      TEXT NOT NULL DEFAULT '',
    nomus_hash                      TEXT NOT NULL DEFAULT '',
    nomus_sincronizado_em           TEXT,
    created_at                      TEXT NOT NULL,
    updated_at                      TEXT NOT NULL,
    updated_by                      TEXT NOT NULL DEFAULT 'sync'
  );
  CREATE INDEX idx_pcp_pedido_numero ON pcp_pedido (numero_pedido);

  CREATE TABLE pcp_pedido_item (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id                INTEGER NOT NULL REFERENCES pcp_pedido(id),
    nomus_item_id            INTEGER NOT NULL UNIQUE,
    item_seq                 TEXT NOT NULL DEFAULT '',
    produto_nomus_id         INTEGER,
    produto_codigo           TEXT NOT NULL DEFAULT '',
    produto_categoria        TEXT NOT NULL DEFAULT 'OUTROS',
    tipo_pintura             TEXT,
    cor_id                   INTEGER REFERENCES pcp_cor(id),
    descricao_produto        TEXT NOT NULL DEFAULT '',
    info_adicional           TEXT NOT NULL DEFAULT '',
    quantidade               REAL,
    medidas                  TEXT NOT NULL DEFAULT '[]',
    medidas_origem           TEXT NOT NULL DEFAULT 'nenhuma',
    trapezio                 TEXT,
    faces_pintura            INTEGER NOT NULL DEFAULT 0,
    metros_telha             REAL NOT NULL DEFAULT 0,
    metros_chapa             REAL NOT NULL DEFAULT 0,
    -- Campos derivados que a equipe corrigiu à mão (JSON): a sincronização não os refaz.
    campos_manuais           TEXT NOT NULL DEFAULT '[]',
    situacao_pcp             TEXT NOT NULL DEFAULT 'PROGRAMAR',
    data_programacao         TEXT,
    data_liberacao_producao  TEXT,
    data_produzida           TEXT,
    data_entrega_realizada   TEXT,
    fornecedor_terceiro      TEXT NOT NULL DEFAULT '',
    data_entrega_terceiro    TEXT,
    removido_no_erp          INTEGER NOT NULL DEFAULT 0,
    alterado_no_erp          INTEGER NOT NULL DEFAULT 0,
    nomus_hash               TEXT NOT NULL DEFAULT '',
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    updated_by               TEXT NOT NULL DEFAULT 'sync'
  );
  CREATE INDEX idx_pcp_item_pedido ON pcp_pedido_item (pedido_id);
  CREATE INDEX idx_pcp_item_situacao ON pcp_pedido_item (situacao_pcp);

  CREATE TABLE pcp_item_op (
    item_id       INTEGER NOT NULL REFERENCES pcp_pedido_item(id),
    nomus_op_id   INTEGER NOT NULL,
    numero_op     TEXT NOT NULL,
    status_op     TEXT NOT NULL DEFAULT '',
    inicio_planejado TEXT,
    PRIMARY KEY (item_id, nomus_op_id)
  );

  CREATE TABLE pcp_item_consumo (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER NOT NULL REFERENCES pcp_pedido_item(id),
    material    TEXT NOT NULL REFERENCES pcp_material(codigo),
    cor_id      INTEGER REFERENCES pcp_cor(id),
    quantidade  REAL NOT NULL,
    unidade     TEXT NOT NULL,
    origem      TEXT NOT NULL,
    calculado_em TEXT NOT NULL
  );
  CREATE INDEX idx_pcp_consumo_item ON pcp_item_consumo (item_id);

  CREATE TABLE pcp_evento (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    entidade     TEXT NOT NULL,
    entidade_id  INTEGER NOT NULL,
    pedido_id    INTEGER,
    campo        TEXT NOT NULL,
    valor_antigo TEXT,
    valor_novo   TEXT,
    usuario      TEXT NOT NULL,
    origem       TEXT NOT NULL DEFAULT 'usuario',
    em           TEXT NOT NULL
  );
  CREATE INDEX idx_pcp_evento_entidade ON pcp_evento (entidade, entidade_id);
  CREATE INDEX idx_pcp_evento_pedido ON pcp_evento (pedido_id);

  CREATE TABLE pcp_sync_programacao (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    iniciado_em TEXT NOT NULL,
    finalizado_em TEXT,
    pedidos_lidos INTEGER NOT NULL DEFAULT 0,
    criados     INTEGER NOT NULL DEFAULT 0,
    atualizados INTEGER NOT NULL DEFAULT 0,
    erros       INTEGER NOT NULL DEFAULT 0,
    detalhe_erros TEXT
  );
  `,
  // Agenda de produção (feriados), compras de terceiros, pagamentos a fornecedores e estoque de parafusos.
  `
  CREATE TABLE IF NOT EXISTS pcp_feriado (
    data TEXT PRIMARY KEY,
    nome TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pcp_fornecedor (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    nome    TEXT NOT NULL UNIQUE,
    fornece TEXT NOT NULL DEFAULT '',
    contato TEXT NOT NULL DEFAULT '',
    ativo   INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS pcp_compra (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo               TEXT NOT NULL,
    pedido_id          INTEGER REFERENCES pcp_pedido(id),
    fornecedor_id      INTEGER REFERENCES pcp_fornecedor(id),
    medidas            TEXT NOT NULL DEFAULT '[]',
    total_metros       REAL NOT NULL DEFAULT 0,
    comprimento_peca_m REAL,
    material           TEXT NOT NULL DEFAULT '',
    tr                 TEXT,
    cotacao            TEXT NOT NULL DEFAULT '',
    valor_centavos     INTEGER,
    status             TEXT NOT NULL DEFAULT 'A_COTAR',
    comprado_por       TEXT NOT NULL DEFAULT '',
    comprado_em        TEXT,
    observacao         TEXT NOT NULL DEFAULT '',
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    updated_by         TEXT NOT NULL DEFAULT 'PCP'
  );
  CREATE INDEX IF NOT EXISTS idx_pcp_compra_pedido ON pcp_compra (pedido_id);
  CREATE TABLE IF NOT EXISTS pcp_pagamento (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    fornecedor_id  INTEGER NOT NULL REFERENCES pcp_fornecedor(id),
    data           TEXT NOT NULL,
    valor_centavos INTEGER NOT NULL,
    observacao     TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    created_by     TEXT NOT NULL DEFAULT 'PCP'
  );
  CREATE TABLE IF NOT EXISTS pcp_estoque (
    material    TEXT PRIMARY KEY REFERENCES pcp_material(codigo),
    quantidade  REAL NOT NULL,
    contado_em  TEXT NOT NULL
  );
  `,
];

export function openDatabase(filePath: string): DatabaseSync {
  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  const db = new DatabaseSync(filePath);
  // Modo comum (não WAL): o banco é UM arquivo só e está sempre completo, então copiar pcp.sqlite já é um backup
  // válido. No modo WAL as últimas gravações ficam num arquivo lateral (-wal) e uma cópia só do .sqlite as perderia.
  // O volume de dados é pequeno; a diferença de desempenho não existe na prática.
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("PRAGMA busy_timeout = 5000");
  // Mantém synchronous = FULL (o padrão): a tratativa é digitada à mão e não dá para refazer;
  // o volume é pequeno, então a durabilidade total não custa nada perceptível.

  migrate(db);
  return db;
}

function migrate(db: DatabaseSync) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;

  while (version < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      // PRAGMA não aceita parâmetro; `version` é um inteiro nosso, sem input externo.
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** Roda `fn` dentro de uma transação; desfaz tudo se ela lançar. */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
