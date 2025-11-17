// src/db/unibetMatchesRepository.js
import { getDb } from "./mongoClient.js";

const COLLECTION_NAME =
  process.env.MONGO_COLLECTION_UNIBET_MATCHES || "unibet-matches";

/**
 * Spara ett snapshot av matcher från Unibet.
 * Returnerar insertedId för koppling mot odds m.m.
 */
export async function insertUnibetSnapshot(snapshot) {
  if (!snapshot) {
    throw new Error("insertUnibetSnapshot: snapshot saknas");
  }

  const db = await getDb();
  const col = db.collection(COLLECTION_NAME);

  const now = new Date();
  const doc = {
    createdAt: now,
    snapshotTime: snapshot.snapshotTime || snapshot.createdAt || now,
    ...snapshot,
  };

  const { insertedId } = await col.insertOne(doc);
  return insertedId;
}
