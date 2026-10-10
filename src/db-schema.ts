/**
 * Database schema improvements and migrations for QMD.
 *
 * This module handles database schema versioning, indexes, and constraints.
 */

import type { Database } from "./db.js";

/**
 * Current schema version.
 * Increment this when making breaking schema changes.
 */
export const SCHEMA_VERSION = 9;

/**
 * Schema version table name.
 */
const VERSION_TABLE = "schema_version";

/**
 * Initialize schema versioning and run any needed migrations.
 */
export function initializeSchema(db: Database): void {
  // Create version tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${VERSION_TABLE} (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const currentVersion = getCurrentVersion(db);

  if (currentVersion < SCHEMA_VERSION) {
    // Run migrations
    migrateToVersion(db, SCHEMA_VERSION);
  }
}

/**
 * Get the current schema version from the database.
 */
function getCurrentVersion(db: Database): number {
  const row = db
    .prepare(`SELECT MAX(version) as v FROM ${VERSION_TABLE}`)
    .get() as { v: number | null };
  return row?.v ?? 0;
}

/**
 * Run migrations to bring the database up to the target version.
 */
function migrateToVersion(db: Database, targetVersion: number): void {
  const currentVersion = getCurrentVersion(db);

  console.error(
    `Migrating database from version ${currentVersion} to ${targetVersion}...`
  );

  for (let v = currentVersion + 1; v <= targetVersion; v++) {
    const migration = MIGRATIONS[v];
    if (migration) {
      console.error(`  Applying migration v${v}...`);
      migration(db);
      db.prepare(`INSERT INTO ${VERSION_TABLE} (version) VALUES (?)`).run(v);
    }
  }

  console.error("Migration complete.");
}

/**
 * Migration functions indexed by target version.
 */
const MIGRATIONS: Record<number, (db: Database) => void> = {
  1: (db) => {
    // Version 1: Add indexes for common queries

    // documents table indexes (bootstrap already creates idx_documents_collection
    // on (collection, active), so we only add the missing composite index here)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_collection_path
        ON documents(collection, path);

      CREATE INDEX IF NOT EXISTS idx_documents_active
        ON documents(active) WHERE active = 0;
    `);

    // content_vectors indexes (if sqlite-vec is available)
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_content_vectors_hash
          ON content_vectors(hash);

        CREATE INDEX IF NOT EXISTS idx_content_vectors_hash_seq
          ON content_vectors(hash, seq);
      `);
    } catch {
      // sqlite-vec not available, skip vector indexes
    }

    // llm_cache indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_llm_cache_created
        ON llm_cache(created_at);
    `);

    // links table indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_links_source
        ON links(source);

      CREATE INDEX IF NOT EXISTS idx_links_target
        ON links(target);
    `);

    // pages_cache index
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_pages_cache_docid
          ON pages_cache(docid);
      `);
    } catch {
      // Table doesn't exist yet, skip
    }

    // section_map index
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_section_map_docid
          ON section_map(docid);

        CREATE INDEX IF NOT EXISTS idx_section_map_docid_section
          ON section_map(docid, section_idx);
      `);
    } catch {
      // Table doesn't exist yet, skip
    }

    // slide_cache index
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_slide_cache_docid
          ON slide_cache(docid);
      `);
    } catch {
      // Table doesn't exist yet, skip
    }

    // docx_elements index
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_docx_elements_docid
          ON docx_elements(docid);

        CREATE INDEX IF NOT EXISTS idx_docx_elements_docid_section
          ON docx_elements(docid, section_idx);
      `);
    } catch {
      // Table doesn't exist yet, skip
    }

    // pptx_elements index
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_pptx_elements_docid
          ON pptx_elements(docid);

        CREATE INDEX IF NOT EXISTS idx_pptx_elements_docid_slide
          ON pptx_elements(docid, slide_idx);
      `);
    } catch {
      // Table doesn't exist yet, skip
    }
  },

  2: (db) => {
    // Version 2: Wiki support — collection type + activity log

    // Add type column to store_collections (existing rows default to 'raw')
    try {
      db.exec(`ALTER TABLE store_collections ADD COLUMN type TEXT DEFAULT 'raw'`);
    } catch {
      // Column already exists (fresh DB creates it in CREATE TABLE)
    }

    // Wiki activity log
    db.exec(`
      CREATE TABLE IF NOT EXISTS wiki_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        operation TEXT NOT NULL,
        source_file TEXT,
        wiki_files TEXT,
        details TEXT,
        session_id TEXT
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_wiki_log_timestamp ON wiki_log(timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_wiki_log_operation ON wiki_log(operation)`);
  },

  3: (db) => {
    // Version 3: Wiki provenance tracking + incremental ingest

    // Source-to-wiki page provenance (which source docs feed which wiki pages)
    db.exec(`
      CREATE TABLE IF NOT EXISTS wiki_sources (
        wiki_file TEXT NOT NULL,
        source_file TEXT NOT NULL,
        wiki_collection TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (wiki_file, source_file)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_wiki_sources_source ON wiki_sources(source_file)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_wiki_sources_collection ON wiki_sources(wiki_collection)`);

    // Incremental ingest tracker (tracks content hash at last ingest time)
    db.exec(`
      CREATE TABLE IF NOT EXISTS wiki_ingest_tracker (
        source_file TEXT NOT NULL,
        wiki_collection TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (source_file, wiki_collection)
      )
    `);
  },

  4: (db) => {
    // Version 4: Iterative info-collection (intake) sessions + persistent Q&A records
    db.exec(`
      CREATE TABLE IF NOT EXISTS intake_sessions (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS intake_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        refs TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_intake_records_session ON intake_records(session_id, seq)`);
  },

  5: (db) => {
    // 表结构与种子已迁移至场景模块 src/contract-review/db-init.ts
    // （ensureContractReviewSchema 幂等创建 risk_rules / contracts_meta /
    // analysis_records）。此处仅保留版本占位，避免重新初始化时漏跑版本号。
  },
  6: (db) => {
    // Version 6: Per-user persistent chat (Q&A) history. Sessions are scoped to a
    // single user via `user_id`; messages store the model, retrieved sources, and
    // a capped raw-results payload for full traceability on replay.

    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        title       TEXT NOT NULL DEFAULT '',
        collections TEXT NOT NULL DEFAULT '',
        mode        TEXT NOT NULL DEFAULT 'query',
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, updated_at DESC)`
    );

    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        model       TEXT,
        sources     TEXT,
        raw_results TEXT,
        tokens_used INTEGER,
        elapsed_ms  INTEGER,
        error       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, seq)`
    );
  },

  7: (db) => {
    // 合同类型维度列已迁移至场景模块 src/contract-review/db-init.ts
    // （ensureContractReviewSchema 对 contracts_meta 做容错 ALTER）。占位保留。
  },
  8: (db) => {
    // 合同类型主数据 + 多对多关联已迁移至场景模块 src/contract-review/db-init.ts
    // （ensureContractReviewSchema 幂等创建 contract_types / rule_contract_scope
    // 并种子化合同类型树）。此处仅保留版本占位。
  },

  9: (db) => {
    // Version 9: 场景约束 manifest 注册 / 版本约定（设计 §3.4）。
    // 仅存头信息 + 不透明 payload_ref；约束内容（规则行 / 模板）留在场景层，
    // 不进底座语义层（§3.6）。与 src/scenario-manifest.ts 的 ensureScenarioManifestSchema 互补。
    db.exec(`
      CREATE TABLE IF NOT EXISTS scenario_manifests (
        manifest_id  TEXT PRIMARY KEY,
        scenario     TEXT NOT NULL,
        kind         TEXT NOT NULL,
        version      TEXT NOT NULL,
        name         TEXT NOT NULL DEFAULT '',
        description  TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'active',
        payload_ref  TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_scenario_manifests_scenario_kind ON scenario_manifests(scenario, kind, status)`,
    );
  },

}; // MIGRATIONS 对象结束


/**
 * Get database statistics for health monitoring.
 */
export function getDatabaseStats(db: Database): {
  schemaVersion: number;
  tableRowCounts: Record<string, number>;
  indexCount: number;
  databaseSize: number;
} {
  const schemaVersion = getCurrentVersion(db);

  // Get row counts for all tables
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    .all() as { name: string }[];

  const tableRowCounts: Record<string, number> = {};
  for (const table of tables) {
    const row = db
      .prepare(`SELECT COUNT(*) as count FROM ${table.name}`)
      .get() as { count: number };
    tableRowCounts[table.name] = row.count;
  }

  // Get index count
  const indexRow = db
    .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='index'")
    .get() as { count: number };
  const indexCount = indexRow.count;

  // Get database page count * page size
  const pageRow = db
    .prepare("PRAGMA page_count")
    .get() as { page_count: number };
  const sizeRow = db
    .prepare("PRAGMA page_size")
    .get() as { page_size: number };
  const databaseSize = (pageRow?.page_count ?? 0) * (sizeRow?.page_size ?? 0);

  return {
    schemaVersion,
    tableRowCounts,
    indexCount,
    databaseSize,
  };
}

/**
 * Analyze database tables to update query planner statistics.
 * Should be called after bulk inserts/deletes.
 */
export function analyzeDatabase(db: Database): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    .all() as { name: string }[];

  for (const table of tables) {
    db.prepare(`ANALYZE ${table.name}`).run();
  }
}

/**
 * Get index usage statistics to identify unused indexes.
 */
export function getIndexUsage(db: Database): Array<{
  name: string;
  table: string;
  scans: number;
}> {
  try {
    const rows = db
      .prepare(`
        SELECT
          name as name,
          tbl_name as table,
          stat1 as scans
        FROM sqlite_stat1
        ORDER BY stat1 ASC
      `)
      .all() as Array<{ name: string; table: string; scans: string }>;

    return rows.map(row => ({
      name: row.name,
      table: row.table,
      scans: parseInt(row.scans || "0", 10),
    }));
  } catch {
    return [];
  }
}
