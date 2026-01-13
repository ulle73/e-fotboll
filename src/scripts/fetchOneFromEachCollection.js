// src/scripts/fetchOneFromEachCollection.js
import { getDb, closeDb } from '../db/mongoClient.js';

async function fetchOneFromEachCollection() {
  try {
    const db = await getDb();

    // Get all collection names
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(col => col.name);

    // Filter out 'ev-bets-old'
    const filteredCollections = collectionNames.filter(name => name !== 'ev-bets-old');

    console.log('Fetching one document from each collection (except ev-bets-old):');
    console.log('Collections:', filteredCollections);

    const results = {};

    for (const colName of filteredCollections) {
      try {
        const collection = db.collection(colName);
        const doc = await collection.findOne({});
        results[colName] = doc;
        console.log(`\n--- ${colName} ---`);
        console.log(JSON.stringify(doc, null, 2));
      } catch (error) {
        console.error(`Error fetching from ${colName}:`, error.message);
        results[colName] = { error: error.message };
      }
    }

    return results;
  } catch (error) {
    console.error('Error:', error);
    throw error;
  } finally {
    await closeDb();
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  fetchOneFromEachCollection()
    .then(() => console.log('Done'))
    .catch(console.error);
}

export { fetchOneFromEachCollection };