// export const getNowTimeParts = (baseDate = new Date()) => {
//   const pad = (value) => String(value).padStart(2, '0');

//   const utcIso = baseDate.toISOString();

//   const yyyy = baseDate.getFullYear();
//   const mm = pad(baseDate.getMonth() + 1);
//   const dd = pad(baseDate.getDate());
//   const hh = pad(baseDate.getHours());
//   const min = pad(baseDate.getMinutes());
//   const ss = pad(baseDate.getSeconds());

//   const localIso = `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`;
//   const datePart = `${yyyy}-${mm}-${dd}`;
//   const timePart = `${hh}-${min}-${ss}`;

//   return {
//     now: baseDate,
//     utcIso,
//     localIso,
//     datePart,
//     timePart,
//   };
// };

// export const formatLocalDateTime = (date) => {
//   const { datePart, timePart } = getNowTimeParts(date);
//   const [hh, mm] = timePart.split('-');
//   return `${datePart} - ${hh}:${mm}`;
// };


// utils/time.js (eller var filen nu ligger)

export const getNowTimeParts = (baseDate = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0');

  // ISO alltid i UTC
  const utcIso = baseDate.toISOString();

  // ❗ Gör om baseDate till Europe/Stockholm med Intl
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(baseDate);
  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  const yyyy = map.year;
  const mm = map.month;
  const dd = map.day;
  const hh = map.hour;
  const min = map.minute;
  const ss = map.second;

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
  // 🔁 Samma API som förr – använder getNowTimeParts internt
  const { datePart, timePart } = getNowTimeParts(date);
  const [hh, mm] = timePart.split('-');
  return `${datePart} - ${hh}:${mm}`;
};
