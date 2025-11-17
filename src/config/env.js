import dotenv from "dotenv";

dotenv.config();

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
const dbName = process.env.MONGODB_DB_NAME || process.env.MONGO_DB || "esportsbattle";

if (!uri) {
  throw new Error("MONGODB_URI saknas i .env");
}

export const MONGODB_URI = uri;
export const MONGODB_DB_NAME = dbName;
