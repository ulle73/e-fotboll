const filterByTermKey = (events, termKey) => {
  return events.filter(item => {
    const event = item.event;
    if (!event || !event.path) {
      return false;
    }
    return event.path.some(p => p.termKey === termKey);
  });
};

const filterByGroupName = (events, allowedGroups) => {
  return events.filter(item => {
    const event = item.event;
    if (!event || !event.group) {
      return false;
    }
    return allowedGroups.includes(event.group);
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
  if (allowedGroups && allowedGroups.length > 0) {
    filteredEvents = filterByGroupName(filteredEvents, allowedGroups);
  }
  return filteredEvents;
};
