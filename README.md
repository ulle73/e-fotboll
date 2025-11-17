# EsportsBattle Over/Under Goals – Telegram Bot (Node.js)

En Node.js-baserad pipeline som:

- skrapar data från **EsportsBattle Football**
- beräknar **EV** på över/under-mål
- bestämmer **unit size** baserat på EV
- sparar alla spel i **MongoDB**
- skickar ut spelen automatiskt via en **Telegram-bot**
- körs automatiskt var 30:e minut via **GitHub Actions**

---

## 1. Översikt & designbeslut

### 1.1 Mål

Slutresultat:

> En Telegram-bot som automatiskt, var 30:e minut, skickar ut över/under-spel på mål från EsportsBattle, där varje spel:
>
> - är baserat på historik (minst X=10 matcher)
> - har ett beräknat EV
> - har en unit size beroende på EV
> - sparas i en databas för backtesting

### 1.2 Teknisk stack

- **Språk:** JavaScript (Node.js)
- **Databas:** MongoDB Atlas (free tier på Azure)
- **Scheduler:** GitHub Actions (cron var 30:e minut)
- **Scraping:** `axios` + `puppeteer` (HTML-parsing)
- **Telegram:** eget litet HTTP-anrop mot Telegram Bot API eller valfritt bibliotek
- **Konfiguration:** `.env` + separata config-filer

### 1.3 Varför databas?

Vi vill:

- spara **alla spel** som genereras → kunna backtesta i efterhand
- spara historiska matcher/linor → bygga bättre modeller senare
- undvika att skicka samma spel flera gånger

En **MongoDB Atlas (free tier)** på Azure räcker gott för detta projekt.

### 1.4 Varför ingen Vercel/hosting?

Vi behöver **inte** ta emot inkommande requests (ingen webhook, inget API).  
Flödet är “push”:

1. GitHub Actions startar vårt script var 30:e minut.
2. Scriptet:
   - skrapar EsportsBattle
   - kör modellen
   - skriver till MongoDB
   - skickar meddelande via Telegram Bot API

Därför räcker: **GitHub Actions + MongoDB Atlas + Telegram Bot API**.

---

## 2. Arkitektur & mapstruktur

### 2.1 Hög nivå

```text
EsportsBattle --> Scraper --> Datamodell --> EV-logik --> Unit-size --> Telegram
                               |
                               v
                             MongoDB
