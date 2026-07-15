/*
 * engine/shell/map-rules.js — the pure fog-of-war visibility rule for the galaxy
 * map, lifted out of ui/map.js so it imports in node and is unit-tested directly
 * (test/map-rules.test.mjs). Same UI/logic split as legal-rules / trade-rules /
 * landing-rules (docs/OOP_DESIGN.md "Separating UI from logic").
 *
 * Which systems appear on the map (spec: "Map knowledge"):
 *   - every explored system, and
 *   - the direct neighbours of an explored system (the one-jump-into-the-fog
 *     dots you can select and route to), and
 *   - every active mission destination — ALWAYS, even deep in unexplored space.
 *     A mission destination the player hasn't charted yet is drawn as a
 *     disconnected, unlabeled guide node with a marker (ui/map.js), at its true
 *     position, so a new player knows which way to head. This is the piece the
 *     fog would otherwise hide.
 *
 * Pure: takes the systems table (id → record with Con1..Con16), the explored
 * set, and the set of mission-destination system ids. Returns a Set of numeric
 * ids. Nothing here reads globals, the DOM, or draws.
 */
export function computeVisibleSystems(systs, explored, missionDests) {
  const vis = new Set();
  for (const id of Object.keys(systs)) {
    const nid = +id;
    if (!explored.has(nid)) continue;
    vis.add(nid);
    const s = systs[id];
    for (let i = 1; i <= 16; i++) {
      const c = s['Con' + i];
      if (c >= 128 && systs[c]) vis.add(c); // a neighbour, explored or not
    }
  }
  for (const id of missionDests) if (systs[id]) vis.add(+id); // guide nodes, fog or not
  return vis;
}
