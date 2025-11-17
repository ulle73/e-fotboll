import { getBrowser } from '../utils/browser.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let urls;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const urlsPath = path.resolve(__dirname, '../../config/urls.json');
  urls = JSON.parse(fs.readFileSync(urlsPath, 'utf-8'));
} catch (error) {
    console.error('Failed to load or parse urls.json:', error);
    process.exit(1);
}


export const fetchStartingWithinData = async () => {
  const browser = await getBrowser();
  const page = await browser.newPage();

  const now = new Date();
  const to = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  
  const pad = (num) => num.toString().padStart(2, '0');

  const formatDate = (date) => {
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    const offset = -date.getTimezoneOffset();
    const offsetSign = offset >= 0 ? '+' : '-';
    const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
    const offsetMinutes = pad(Math.abs(offset) % 60);

    return `${year}${month}${day}T${hours}${minutes}${seconds}${offsetSign}${offsetHours}${offsetMinutes}`;
  };

  const fromDate = formatDate(now);
  const toDate = formatDate(to);

  const params = new URLSearchParams({
    lang: 'sv_SE',
    market: 'SE',
    channel_id: '1',
    ncid: Date.now(),
    useCombined: 'true',
    from: fromDate,
    to: toDate,
  });

  const fullUrl = `${urls.unibet.startingWithin}?${params.toString()}`;
  
  await page.goto(fullUrl);
  
  const data = await page.evaluate(() => {
    const pre = document.querySelector('pre');
    if (pre) {
      return JSON.parse(pre.innerText);
    }
    // Handle cases where the content is not in a <pre> tag
    const body = document.body.innerText;
    try {
      return JSON.parse(body);
    } catch (e) {
      // If parsing fails, return the raw text
      return body;
    }
  });
  
  await page.close();
  
  return data;
};
