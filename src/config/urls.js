import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const URLS_PATH = path.resolve(__dirname, '../../config/urls.json');
const ENV_PREFIX = 'env:';

const resolveEnvValue = (value, keyPath) => {
  if (typeof value !== 'string') return value;
  if (!value.startsWith(ENV_PREFIX)) return value;

  const envKey = value.slice(ENV_PREFIX.length);
  const envValue = process.env[envKey];
  if (!envValue) {
    const location = keyPath ? ` (${keyPath})` : '';
    throw new Error(`Missing ${envKey} for urls config${location}`);
  }
  return envValue;
};

const resolveEnvTree = (node, pathParts = []) => {
  if (Array.isArray(node)) {
    return node.map((item, index) => resolveEnvTree(item, [...pathParts, String(index)]));
  }

  if (node && typeof node === 'object') {
    const resolved = {};
    for (const [key, value] of Object.entries(node)) {
      resolved[key] = resolveEnvTree(value, [...pathParts, key]);
    }
    return resolved;
  }

  return resolveEnvValue(node, pathParts.join('.'));
};

export const loadUrls = async () => {
  const raw = await fs.readFile(URLS_PATH, 'utf-8');
  const json = JSON.parse(raw);
  return resolveEnvTree(json);
};

export { URLS_PATH };
