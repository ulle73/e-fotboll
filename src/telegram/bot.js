import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ladda miljövariabler från .env-filen
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Ersätt 'YOUR_TELEGRAM_BOT_TOKEN' med din faktiska token
// Det är bäst att hämta token från miljövariabler för säkerhet
const token = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN_HERE'; // Använd din token här om du inte använder .env

if (token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE' || !token) {
  console.error('FEL: Telegram Bot Token saknas. Vänligen ange din token i .env-filen som TELEGRAM_BOT_TOKEN eller direkt i koden.');
  process.exit(1);
}

// Skapa en ny bot-instans
// 'polling' är en enkel metod för att ta emot meddelanden
const bot = new TelegramBot(token, { polling: true });

console.log('Telegram Bot startad...');

// Lyssna efter kommandot /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Välkommen! Jag är din eSoccerTelegram-bot.');
});

// Lyssna efter alla meddelanden och logga dem
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  console.log(`Mottog meddelande från ${msg.from.first_name} (${chatId}): ${msg.text}`);
});

// Hantera fel
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

export default bot;
