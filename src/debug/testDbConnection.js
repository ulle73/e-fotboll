// src/debug/testDbConnection.js
import { getDb, closeDb } from "../db/mongoClient.js";

async function main() {
  try {
    const db = await getDb();
    const collections = await db.listCollections().toArray();
    console.log(
      "📂 Collections i databasen:",
      collections.map((c) => c.name)
    );
  } catch (err) {
    console.error("❌ Fel vid MongoDB-anslutning:", err);
  } finally {
    await closeDb();
  }
}

main();
