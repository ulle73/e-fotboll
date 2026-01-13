const DEFAULT_UNIBET_BASE = 'https://www.unibet.se';

/**
 * Bygger en direktlänk till en Unibet-event-sida givet eventId.
 * @param {string|number} eventId
 * @param {string} [baseUrl] Grunddomän, t.ex. https://www.unibet.se
 * @returns {string} URL till eventet
 */
export const buildUnibetEventUrl = (eventId, baseUrl = DEFAULT_UNIBET_BASE) => {
  if (!eventId) return '';
  const cleanBase = baseUrl.replace(/\/+$/, '');
  return `${cleanBase}/betting/sports/event/${eventId}`;
};
