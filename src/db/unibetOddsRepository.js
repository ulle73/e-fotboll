// src/db/unibetOddsRepository.js
import { getDb } from "./mongoClient.js";

const COLLECTION_NAME =
  process.env.MONGO_COLLECTION_UNIBET_ODDS || "unibet-odds";

/**
 * Bulk-spara odds kopplat till ett snapshot.
 */
export async function insertUnibetOddsBatch(oddsDocs = []) {
  if (!Array.isArray(oddsDocs) || oddsDocs.length === 0) {
    return { insertedCount: 0 };
  }

  const db = await getDb();
  const col = db.collection(COLLECTION_NAME);

  const res = await col.insertMany(oddsDocs);
  return { insertedCount: res.insertedCount };
}
