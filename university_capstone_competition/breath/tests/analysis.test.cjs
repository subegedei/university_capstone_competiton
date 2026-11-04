require("./load-ts.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { displacementRmsM, responseScore, refinementCenterIndex } = require("../lib/analysis.ts");

test("candidate ranking uses fundamental velocity and never supply current", () => {
  const samples = [
    { hz: 25, accelerationRms: 1, currentA: 0.001 },
    { hz: 31, accelerationRms: 3, currentA: null },
    { hz: 40, accelerationRms: 4, currentA: 0.2 },
  ];
  assert.equal(refinementCenterIndex(samples), 1);
  assert.equal(responseScore(samples[1]), 3 / (2 * Math.PI * 31));
  assert.equal(displacementRmsM(samples[1]), 3 / (2 * Math.PI * 31) ** 2);
});
