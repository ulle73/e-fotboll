import * as logger from '../utils/logger.js';

export async function getUpcomingMatches(matchesCollection, windowMinutes) {
    const now = new Date();
    const nowUtc = new Date(now.toUTCString());
    const windowEndUtc = new Date(nowUtc.getTime() + windowMinutes * 60 * 1000);

    const latestSnapshot = await matchesCollection.findOne({}, { sort: { createdAt: -1 } });

    if (!latestSnapshot || !Array.isArray(latestSnapshot.matches) || latestSnapshot.matches.length === 0) {
        logger.info("Inga senaste match-snapshots hittades i databasen.");
        return [];
    }

    const upcomingMatches = latestSnapshot.matches.filter(match => {
        const matchStartTime = new Date(match.event.start);
        return matchStartTime > nowUtc && matchStartTime <= windowEndUtc;
    });

    if (!upcomingMatches.length) {
        logger.info(`Inga matcher hittades som startar inom de närmaste ${windowMinutes} minuterna.`);
    } else {
        logger.info(`Hittade ${upcomingMatches.length} matcher som startar inom ${windowMinutes} minuter.`);
    }

    return upcomingMatches;
}
