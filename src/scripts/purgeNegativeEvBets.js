import { getDb, closeDb } from '../db/mongoClient.js';

const MAX_DELETE_PER_RUN = Number.isFinite(Number(process.env.PURGE_NEG_EV_LIMIT))
  ? Math.max(1, Number(process.env.PURGE_NEG_EV_LIMIT))
  : 50000;
const DELETE_ALL = process.argv.includes('--delete-all');

const NEGATIVE_FILTER = {
  $and: [
    { ev: { $lt: 0 } },
    {
      $expr: {
        $lt: [
          { $toDouble: { $ifNull: ['$ev', 0] } },
          0,
        ],
      },
    },
  ],
};

const main = async () => {
  const db = await getDb();
  try {
    const col = db.collection('ev-bets');

    const totalNegative = await col.countDocuments({ ev: { $lt: 0 } });
    console.log(`Totalt antal ev-bets med EV < 0: ${totalNegative}`);
    if (!totalNegative) {
      console.log('Inga negativa EV-spel att ta bort.');
      return;
    }

    const candidates = await col
      .find({ ev: { $lt: 0 } })
      .sort({ createdAt: 1, _id: 1 })
      .limit(DELETE_ALL ? totalNegative : MAX_DELETE_PER_RUN)
      .project({ _id: 1 })
      .toArray();

    if (!candidates.length) {
      console.log('Hittade inga negativa EV-spel att plocka bort just nu.');
      return;
    }

    const ids = candidates.map((doc) => doc._id);
    const res = await col.deleteMany({ _id: { $in: ids } });
    console.log(
      `Raderade ${res.deletedCount} negativa EV-spel (äldre först). ${Math.max(
        totalNegative - res.deletedCount,
        0,
      )} finns kvar.`
    );
  } finally {
    await closeDb();
  }
};

main().catch((err) => {
  console.error('Fel i purgeNegativeEvBets:', err);
  process.exitCode = 1;
});
