// src/db/matchResultsRepository.js
import { getDb } from "./mongoClient.js";

const COLLECTION_NAME =
  process.env.MONGO_COLLECTION_RESULTS || "match_results";

/**
 * Sparar eller uppdaterar resultat för en match
 * Du kan kalla den här från din EsportsBattle-scraper.
 */
export async function upsertMatchResult(result) {
  const db = await getDb();
  const col = db.collection(COLLECTION_NAME);

  if (!result.eventId) {
    throw new Error("upsertMatchResult: result.eventId saknas");
  }

  const filter = { eventId: result.eventId };

  const doc = {
    ...result,
    totalGoals:
      typeof result.goalsHome === "number" &&
      typeof result.goalsAway === "number"
        ? result.goalsHome + result.goalsAway
        : null,
    updatedAt: new Date(),
  };

  const update = { $set: doc };
  const options = { upsert: true };

  await col.updateOne(filter, update, options);
}

/**
 * Hämta resultat via eventId (koppling mot Unibet-data)
 */
export async function getResultByEventId(eventId) {
  const db = await getDb();
  const col = db.collection(COLLECTION_NAME);
  return col.findOne({ eventId });
}
