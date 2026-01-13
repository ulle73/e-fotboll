import { getBrowser } from '../utils/browser.js';
import { loadUrls } from '../config/urls.js';


export const fetchStartingWithinData = async () => {
  const urls = await loadUrls();
  const startingSoonUrl = urls.oddsFeed?.startingSoon;
  if (!startingSoonUrl) {
    throw new Error('startingSoon saknas i urls.json');
  }

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

  const fullUrl = `${startingSoonUrl}?${params.toString()}`;
  
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
