import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ladda miljövariabler från .env-filen
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const token = process.env.CONTROL_BOT_TOKEN;
const chatId = process.env.CONTROL_BOT_CHAT_ID;

if (!token || !chatId) {
  console.warn('VARNING: Kontroll-botens token eller chat-ID saknas. Kontroll-meddelanden kommer inte att skickas. Vänligen ange CONTROL_BOT_TOKEN och CONTROL_BOT_CHAT_ID i .env-filen.');
}

// Skapa en ny bot-instans endast om token finns
const controlBot = token ? new TelegramBot(token, { polling: false }) : null;

if (controlBot) {
    console.log('Telegram Control Bot initierad...');
}

export default controlBot;
