// src/config/env.js
import dotenv from "dotenv";

dotenv.config();

export const MONGODB_URI = process.env.MONGODB_URI;
export const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "esportsbattle";

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI saknas i .env");
}
