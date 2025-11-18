export const getNowTimeParts = (baseDate = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0');

  const utcIso = baseDate.toISOString();

  const yyyy = baseDate.getFullYear();
  const mm = pad(baseDate.getMonth() + 1);
  const dd = pad(baseDate.getDate());
  const hh = pad(baseDate.getHours());
  const min = pad(baseDate.getMinutes());
  const ss = pad(baseDate.getSeconds());

  const localIso = `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`;
  const datePart = `${yyyy}-${mm}-${dd}`;
  const timePart = `${hh}-${min}-${ss}`;

  return {
    now: baseDate,
    utcIso,
    localIso,
    datePart,
    timePart,
  };
};

export const formatLocalDateTime = (date) => {
  const { datePart, timePart } = getNowTimeParts(date);
  const [hh, mm] = timePart.split('-');
  return `${datePart} - ${hh}:${mm}`;
};
