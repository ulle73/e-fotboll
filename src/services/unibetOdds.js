// src/services/unibetOdds.js
import * as logger from "../utils/logger.js";

const buildOddsUrl = (eventId) => {
  const params = new URLSearchParams({
    lang: "sv_SE",
    market: "SE",
    ncid: Date.now().toString(),
  });
  return `https://eu.offering-api.kambicdn.com/offering/v2018/ubse/betoffer/event/${eventId}.json?${params.toString()}`;
};

export const fetchEventOdds = async (eventId) => {
  const url = buildOddsUrl(eventId);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for event ${eventId}`);
  }
  return res.json();
};

/**
 * Hjälpmetod för att hämta odds i sekvens och logga fel per event.
 * Returnerar en lista med { eventId, odds }-form.
 */
export const fetchOddsForEvents = async (events) => {
  const results = [];
  for (const eventId of events) {
    try {
      const odds = await fetchEventOdds(eventId);
      results.push({ eventId, odds });
    } catch (err) {
      logger.error(`Kunde inte hämta odds för event ${eventId}:`, err.message);
    }
  }
  return results;
};
