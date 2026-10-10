import { createStore } from "./src/index.js";
import { enableProductionMode, getDefaultDbPath } from "./src/store.js";

enableProductionMode();
const dbPath = process.env.INDEX_PATH || getDefaultDbPath();
console.log("=== DB PATH ===");
console.log(dbPath);

const store = await createStore({ dbPath });
const db = store.internal.db;

console.log("\n=== store_collections SCHEMA ===");
const schema = db.prepare("PRAGMA table_info(store_collections)").all() as { name: string }[];
console.log(schema.map((s) => s.name).join(", "));

console.log("\n=== COLLECTIONS ===");
const cols =
  db.prepare("SELECT name, type FROM store_collections ORDER BY name").all() as {
    name: string;
    type: string | null;
  }[];
for (const c of cols) {
  const cnt = (
    db.prepare("SELECT COUNT(*) c FROM documents WHERE collection=? AND active=1").get(c.name) as {
      c: number;
    }
  ).c;
  console.log(`- ${c.name}  type=${c.type ?? "raw"}  docs=${cnt}`);
}

console.log("\n=== documents SCHEMA ===");
const dSchema = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
console.log(dSchema.map((s) => s.name).join(", "));

// find which column holds the text body
const bodyCol = dSchema.find((s) => /body|content|text/.test(s.name))?.name ?? null;
console.log("body column:", bodyCol);

async function dumpDoc(displayPath: string): Promise<void> {
  const r = await store.get(displayPath, { includeBody: true });
  if ("error" in r) {
    console.log(`  [error fetching ${displayPath}: ${r.error}]`);
    return;
  }
  const body = ((r as { body?: string }).body as string) || "";
  console.log(`  title: ${r.title ?? "(none)"}`);
  console.log(`  chars: ${body.length}`);
  console.log("  SNIPPET:\n" + body.slice(0, 1000));
}

console.log("\n=== yunyingwiki CONTENTS (via store.get) ===");
const ywDocs = db
  .prepare(`SELECT path FROM documents WHERE collection='yunyingwiki' AND active=1 ORDER BY path`)
  .all() as { path: string }[];
console.log(`total pages: ${ywDocs.length}`);
for (const d of ywDocs) {
  console.log(`\n--- yunyingwiki/${d.path} ---`);
  await dumpDoc(`yunyingwiki/${d.path}`);
}

console.log("\n=== yunying (raw) CONTENTS (via store.get) ===");
const rawDocs = db
  .prepare(`SELECT path FROM documents WHERE collection='yunying' AND active=1 ORDER BY path`)
  .all() as { path: string }[];
console.log(`total raw docs: ${rawDocs.length}`);
for (const d of rawDocs) {
  console.log(`\n--- yunying/${d.path} ---`);
  await dumpDoc(`yunying/${d.path}`);
}

console.log("\n=== PROVENANCE (was an LLM ingest ever recorded?) ===");
try {
  const tracker = db
    .prepare("SELECT source_file, wiki_collection, ingested_at FROM wiki_ingest_tracker")
    .all() as { source_file: string; wiki_collection: string; ingested_at: string }[];
  console.log(`wiki_ingest_tracker rows: ${tracker.length}`);
  for (const t of tracker) console.log(`  ${t.source_file} -> ${t.wiki_collection} @ ${t.ingested_at}`);
} catch (e) {
  console.log("wiki_ingest_tracker table missing or error:", (e as Error).message);
}
try {
  const src = db
    .prepare("SELECT wiki_file, source_file FROM wiki_sources")
    .all() as { wiki_file: string; source_file: string }[];
  console.log(`wiki_sources rows: ${src.length}`);
  for (const s of src.slice(0, 20)) console.log(`  ${s.wiki_file} derived from ${s.source_file}`);
} catch (e) {
  console.log("wiki_sources table missing or error:", (e as Error).message);
}

console.log("\n=== wiki_log (operations actually performed) ===");
try {
  const logs = db
    .prepare(
      "SELECT operation, source_file, wiki_files, timestamp FROM wiki_log ORDER BY timestamp DESC LIMIT 30",
    )
    .all() as { operation: string; source_file: string | null; wiki_files: string | null; timestamp: string }[];
  console.log(`wiki_log rows: ${logs.length}`);
  for (const l of logs)
    console.log(`  ${l.timestamp}  ${l.operation}  src=${l.source_file ?? "-"}  files=${l.wiki_files ?? "-"}`);
} catch (e) {
  console.log("wiki_log error:", (e as Error).message);
}

await store.close();
