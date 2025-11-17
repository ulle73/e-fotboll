import * as logger from '../utils/logger.js';
import { getBrowser, closeBrowser } from '../utils/browser.js';

/**
 * Hämtar JSON med Puppeteer (headless) och parsar svaret.
 */
export const fetchJsonWithPuppeteer = async (url, timeout = 20000) => {
  logger.info(`[puppeteerFetch] start för ${url}`);
  const browser = await getBrowser();
  const page = await browser.newPage();
  const headers = {
    // Efterlikna en vanlig Chrome-klient
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
  };

  const doRequest = async (targetUrl) => {
    await page.setExtraHTTPHeaders(headers);
    await page.setCacheEnabled(false);
    logger.info(`[puppeteerFetch] goto ${targetUrl}`);
    const response = await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout });
    logger.info(`[puppeteerFetch] svar mottaget ${targetUrl}`);
    if (!response) {
      throw new Error(`Inget svar för ${targetUrl}`);
    }
    const status = response.status();
    const text = await response.text();
    logger.info(`[puppeteerFetch] status ${status} längd ${text?.length ?? 0}`);
    return { status, text };
  };

  try {
    let { status, text } = await doRequest(url);
    if (status === 304) {
      logger.info('[puppeteerFetch] Fick 304, testar med cachebust');
      const bustUrl = `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
      ({ status, text } = await doRequest(bustUrl));
    }
    if (status < 200 || status >= 300) {
      throw new Error(`Status ${status} för ${url}: ${text.slice(0, 200)}`);
    }
    try {
      const json = JSON.parse(text);
      logger.info(`[puppeteerFetch] JSON ok för ${url}`);
      return json;
    } catch (err) {
      logger.error(`[puppeteerFetch] JSON parse fel ${url}: ${err.message}`);
      throw new Error(`Kunde inte parsa JSON från ${url}: ${err.message}`);
    }
  } finally {
    logger.info(`[puppeteerFetch] stänger sida ${url}`);
    await page.close();
  }
};

export const shutdownPuppeteer = async () => {
  try {
    logger.info('[puppeteerFetch] stänger browser');
    await closeBrowser();
  } catch (err) {
    logger.error('Kunde inte stänga browser', err);
  }
};
