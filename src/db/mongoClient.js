// src/db/mongoClient.js
import { MongoClient } from "mongodb";
import { MONGODB_URI, MONGODB_DB_NAME } from "../config/env.js";

let client;
let db;

export async function getDb() {
  if (!client) {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(MONGODB_DB_NAME);
    console.log("✅ Ansluten till MongoDB:", MONGODB_DB_NAME);
  }
  return db;
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log("🔌 MongoDB-anslutning stängd");
  }
}
