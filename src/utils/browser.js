import puppeteer from 'puppeteer';
import * as logger from './logger.js';

let browser;

export const getBrowser = async () => {
  if (!browser) {
    logger.step('Startar puppeteer-browser');
    const puppeteerArgs = process.env.PUPPETEER_INFO ? process.env.PUPPETEER_INFO.split(' ') : [];
    browser = await puppeteer.launch({ headless: true, args: puppeteerArgs });
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