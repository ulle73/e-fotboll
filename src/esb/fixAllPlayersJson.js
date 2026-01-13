import path from 'path';
import { fileURLToPath } from 'url';
import { pathRelativeToRoot, readJson, writeJson } from './utils.js';
import * as logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;

const INPUT = pathRelativeToRoot('data', 'esb', 'all_players.json');

// Engångsscript: plockar ut .detail om den finns, annars behåller posten som är.
export const main = async () => {
  logger.step(`Läser ${INPUT}`);
  const rows = await readJson(INPUT, []);
  const fixed = rows.map((row) => row?.detail ?? row);
  logger.step(`Skriver tillbaka ${fixed.length} poster (endast API-respons)`);
  await writeJson(INPUT, fixed);
  logger.success('Klar med fixAllPlayersJson (engångskörning).');
};

if (isMain) {
  main().catch((err) => {
    logger.error('Fel i fixAllPlayersJson', err);
    process.exitCode = 1;
  });
}
