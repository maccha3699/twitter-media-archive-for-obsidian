import assert from "node:assert/strict";
import test from "node:test";
import { clampRatio, columnCountFor, shortestColumn } from "../src/masonry.ts";

const metrics = (width: number) => ({ width, targetColumn: 220, gap: 14, maxColumns: 8 });

test("column count fits as many target-width columns as the container allows", () => {
  // n columns need n*220 + (n-1)*14.
  assert.equal(columnCountFor(metrics(233)), 1);
  assert.equal(columnCountFor(metrics(453)), 1, "two columns need 454");
  assert.equal(columnCountFor(metrics(454)), 2);
  assert.equal(columnCountFor(metrics(688)), 3);
  assert.equal(columnCountFor(metrics(4000)), 8, "clamped by maxColumns");
});

test("a container too narrow for one column still gets one", () => {
  // A sidebar leaf can be narrower than a card, and zero columns would render
  // nothing at all rather than something cramped.
  assert.equal(columnCountFor(metrics(80)), 1);
  assert.equal(columnCountFor(metrics(0)), 1);
  assert.equal(columnCountFor({ width: Number.NaN, targetColumn: 220, gap: 14, maxColumns: 8 }), 1);
  assert.equal(columnCountFor({ width: 900, targetColumn: 0, gap: 14, maxColumns: 8 }), 1);
});

test("an empty grid fills left to right, so reading order is kept", () => {
  // Every column is zero to begin with, and a tie goes to the leftmost.
  const heights = [0, 0, 0];
  const order: number[] = [];
  for (let card = 0; card < 3; card++) {
    const column = shortestColumn(heights);
    order.push(column);
    heights[column] += 100;
  }
  assert.deepEqual(order, [0, 1, 2]);
});

test("cards go to the shortest column, which keeps the bottom edge level", () => {
  assert.equal(shortestColumn([300, 120, 260]), 1);
  assert.equal(shortestColumn([120, 120, 260]), 0, "a tie goes left");
  assert.equal(shortestColumn([500]), 0);
  assert.equal(shortestColumn([]), 0, "no columns yet is still a valid answer");
});

test("placement only ever appends, so a page cannot move a card already shown", () => {
  // The reader is looking at the earlier cards while the later ones arrive, so
  // the packing has to be incremental rather than a redistribution.
  const heights = [0, 0, 0, 0];
  const placed: number[][] = [[], [], [], []];
  const tall = [200, 340, 150, 480, 220, 310, 170, 260, 400, 190];
  tall.forEach((height, card) => {
    const column = shortestColumn(heights);
    placed[column].push(card);
    heights[column] += height;
  });
  const total = placed.flat();
  assert.equal(total.length, tall.length, "every card is placed exactly once");
  assert.deepEqual([...total].sort((a, b) => a - b), tall.map((_, index) => index));
  const spread = Math.max(...heights) - Math.min(...heights);
  assert.ok(spread < Math.max(...tall), `columns stay within one card of each other, got ${spread}`);
});

test("a nonsense height never stops a card being placed", () => {
  assert.equal(shortestColumn([Number.NaN, 10]), 0, "the first column is the fallback");
  assert.equal(shortestColumn([10, Number.NaN]), 0);
});

test("extreme image shapes are clamped so no tile can dwarf the viewport", () => {
  assert.equal(clampRatio(1000, 1000, 0.55, 1.6), 1);
  assert.equal(clampRatio(4000, 400, 0.55, 1.6), 0.55, "a panorama crops instead of going flat");
  assert.equal(clampRatio(400, 4000, 0.55, 1.6), 1.6, "a tall strip crops instead of filling the screen");
  assert.equal(clampRatio(0, 500, 0.55, 1.6), 0.55, "a zero dimension falls back rather than dividing");
  assert.equal(clampRatio(500, Number.NaN, 0.55, 1.6), 0.55);
});
