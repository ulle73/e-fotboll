// src/utils/poisson.js

/**
 * Beräknar Poisson-sannolikheten P(k, lambda)
 * @param {number} k Antal händelser
 * @param {number} lambda Genomsnittligt antal händelser (rate)
 * @returns {number} Sannolikheten
 */
export const poissonProbability = (k, lambda) => {
  if (k < 0 || !Number.isInteger(k)) {
    throw new Error("k måste vara ett icke-negativt heltal.");
  }
  if (lambda < 0) {
    throw new Error("lambda måste vara icke-negativt.");
  }
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
};

/**
 * Beräknar fakulteten av ett tal
 * @param {number} n
 * @returns {number} n!
 */
const factorial = (n) => {
  if (n === 0) return 1;
  let result = 1;
  for (let i = 1; i <= n; i++) {
    result *= i;
  }
  return result;
};

/**
 * Beräknar sannolikheten för att antalet mål blir ÖVER ett visst antal.
 * P(X > threshold) = 1 - P(X <= threshold)
 * @param {number} threshold Antal mål
 * @param {number} lambda Genomsnittligt antal mål
 * @returns {number} Sannolikheten
 */
export const poissonOverProbability = (threshold, lambda) => {
  let cumulativeProbability = 0;
  for (let k = 0; k <= threshold; k++) {
    cumulativeProbability += poissonProbability(k, lambda);
  }
  return 1 - cumulativeProbability;
};

/**
 * Beräknar sannolikheten för att antalet mål blir UNDER ett visst antal.
 * P(X < threshold) = P(X <= threshold - 1)
 * @param {number} threshold Antal mål
 * @param {number} lambda Genomsnittligt antal mål
 * @returns {number} Sannolikheten
 */
export const poissonUnderProbability = (threshold, lambda) => {
  let cumulativeProbability = 0;
  for (let k = 0; k < threshold; k++) {
    cumulativeProbability += poissonProbability(k, lambda);
  }
  return cumulativeProbability;
};
