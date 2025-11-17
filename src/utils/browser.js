import puppeteer from 'puppeteer';
import * as logger from './logger.js';

let browser;

export const getBrowser = async () => {
  if (!browser) {
    logger.step('Startar puppeteer-browser');
    browser = await puppeteer.launch({ headless: true });
  }
  return browser;
};

export const closeBrowser = async () => {
  if (browser) {
    logger.info('Stänger puppeteer-browser');
    await browser.close();
    browser = null;
  }
};