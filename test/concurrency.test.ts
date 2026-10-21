import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "../src/lib/concurrency.ts";

describe("mapLimit", () => {
    it("keeps at most `limit` calls in flight and preserves order", async () => {
        let inFlight = 0;
        let peak = 0;
        const items = Array.from({ length: 10 }, (_, i) => i);
        const results = await mapLimit(items, 3, async i => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, 10 - i));
            inFlight--;
            return i * 2;
        });
        assert.equal(peak, 3);
        assert.deepEqual(results, items.map(i => i * 2));
    });

    it("handles an empty list", async () => {
        assert.deepEqual(await mapLimit([], 4, async () => 1), []);
    });
});
