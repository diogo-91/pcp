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
