/**
 * Import / re-seed the operational risk rule library into the QMD database.
 *
 * Usage:  bun scripts/import-risk-rules.ts [dbPath]
 * Defaults to the global QMD database (getDefaultDbPath).
 */
import { createStore, getDefaultDbPath } from "../src/store.js";
import { importRiskRules } from "../src/contract-review/db.js";

const dbPath = process.argv[2] ?? getDefaultDbPath();
console.error(`Opening database: ${dbPath}`);
const store = createStore(dbPath);
const n = importRiskRules(store.db);
console.error(`✓ Imported ${n} operational risk rules (ruleset 1.0.0).`);
store.close?.();
process.exit(0);
