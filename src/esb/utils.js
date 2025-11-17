import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectRoot = path.resolve(__dirname, '../..');

export const ensureDir = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

export const readJson = async (filePath, fallback = undefined) => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return fallback;
    }
    throw err;
  }
};

export const writeJson = async (filePath, data) => {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
};

export const slugify = (value) =>
  (value ?? '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';

export const replacePlaceholders = (template, replacements) =>
  template.replace(/\{(.*?)\}/g, (_, key) => {
    const replaced = replacements?.[key];
    return replaced === undefined || replaced === null ? `{${key}}` : String(replaced);
  });

export const pathRelativeToRoot = (...segments) => path.join(projectRoot, ...segments);

export const nowIso = () => new Date().toISOString();

export const valueFromCandidates = (obj, candidates, fallback = undefined) => {
  for (const key of candidates) {
    const value = obj?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return fallback;
};
