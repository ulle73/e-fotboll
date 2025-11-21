export const escapeRegex = (value = '') =>
  value.replace(/[.*+?^${}()|[\\]/g, '\\$&');

export const findPlayerStats = async (collection, playerNick) => {
  if (!playerNick) return null;
  const direct = await collection.findOne({ playerNick });
  if (direct) return direct;
  const regex = new RegExp(`^${escapeRegex(playerNick)}$`, 'i');
  return collection.findOne({ playerNick: regex });
};

export const chunkArray = (arr, chunkSize) => {
  const size = Math.max(1, chunkSize);
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};

