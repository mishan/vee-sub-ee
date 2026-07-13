/*
 * engine/shell/trade-rules.js — the pure economic math behind the landed shops,
 * lifted out of 07-trade.js (commodity price, tech gating, trade-in) and the
 * refuel price out of 04-combat.js.
 *
 * Each function takes the records/tables it needs as arguments and touches no
 * ambient `DATA`/`document`/`EV` global or live game state, so it imports in
 * node and is unit-tested directly (test/trade-rules.test.mjs). 07-trade.js and
 * 04-combat.js keep thin wrappers that thread their data tables and singletons,
 * so their public API is unchanged. No behavior change: the bodies are the
 * originals with their closed-over data passed in.
 *
 * The second step of OOP_DESIGN.md's "Testability — next" plan, after
 * missions-rules.js.
 */

/* Commodity price at a spöb: the base price scaled by the spöb's price level
 * ("Low"/"Med"/"High" → PRICE_MULT), or null when this spöb doesn't trade this
 * good. `tables` carries what this used to close over:
 *   commodities — the 6 commodity key names (index -> key),
 *   priceMult   — level name -> multiplier,
 *   basePrices  — base price per commodity index. */
export function priceAt(spob, i, tables) {
  const { commodities, priceMult, basePrices } = tables;
  const lvl = spob.$sem && spob.$sem.prices[commodities[i]];
  return lvl && priceMult[lvl] ? Math.round(basePrices[i] * priceMult[lvl]) : null;
}

/* Tech availability (spec: spöb TechLevel gate + SpecialTech exact match). Fully
 * pure over the item tech level and the spöb record. */
export function techAvailable(itemTech, p) {
  if (itemTech <= p.TechLevel) return true;
  return [p.SpecialTech1, p.SpecialTech2, p.SpecialTech3].includes(itemTech);
}

/* A "map" outfit (ModType 16, e.g. the Regional Map) isn't a kept item — buying
 * it charts a region. Pure over the outfit record. */
export const isMapOutfit = (o) => !!(o && o.$sem && o.$sem.modType === 'map');

/* Trade-in per the resource bible: "the cost of buying a ship is always the cost
 * of the new ship minus 25% of the original cost of your current ship and
 * upgrades." `entries` is the installed-outfit list [[outfitId, count], …];
 * `costOf(id)` gives that outfit's Cost (0 for an unknown id, as the original
 * did). */
export function tradeInValue(hullCost, entries, costOf) {
  return Math.round(0.25 * (hullCost + entries.reduce((n, [oid, c]) => n + costOf(oid) * c, 0)));
}

/* Spaceport refuel price: `unitPrice` per unit of missing fuel. */
export function refuelCost(current, max, unitPrice) {
  return (max - current) * unitPrice;
}
