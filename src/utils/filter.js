const filterByTermKey = (events, termKey) => {
  return events.filter(item => {
    const event = item.event;
    if (!event || !event.path) {
      return false;
    }
    return event.path.some(p => p.termKey === termKey);
  });
};

const norm = (val = '') => val.toString().toLowerCase().trim();

const filterByGroupName = (events, allowedGroups) => {
  if (!allowedGroups || allowedGroups.length === 0) return events;
  const allowed = allowedGroups.map(norm);
  return events.filter(item => {
    const event = item.event;
    if (!event) return false;
    const candidates = [
      event.group,
      event.englishName,
      event.groupName,
    ].filter(Boolean).map(norm);
    return candidates.some(c => allowed.some(a => c.includes(a)));
  });
};

export const filterEvents = (data, termKey, allowedGroups) => {
  if (!data || !data.events) {
    return [];
  }
  let filteredEvents = data.events;
  if (termKey) {
    filteredEvents = filterByTermKey(filteredEvents, termKey);
  }
  filteredEvents = filterByGroupName(filteredEvents, allowedGroups);
  return filteredEvents;
};
