import { createStore, getDefaultDbPath } from "./src/index.js";
import { reindexCollection } from "./src/store.js";

async function main() {
  const dbPath = getDefaultDbPath();
  console.log("db:", dbPath);
  const store = await createStore({ dbPath });

  const coll = store.internal.getCollectionByName("yunyingwiki");
  if (!coll) {
    console.log("集合 yunyingwiki 不存在");
    await store.close();
    return;
  }
  console.log("集合路径:", coll.pwd, "pattern:", coll.glob_pattern);

  const ri = await reindexCollection(
    store.internal,
    coll.pwd,
    "**/*",
    "yunyingwiki",
    { preserveUnseen: true },
  );
  console.log("reindex 结果:", JSON.stringify(ri));

  const emb = await store.embed({ collections: ["yunyingwiki"], force: true });
  console.log("embed 结果:", JSON.stringify(emb));

  await store.close();
}

main().catch((e) => {
  console.error("脚本失败:", e);
  process.exit(1);
});
