import { describe, expect, it } from "vitest";
import { pickWeighted, poisson, seeded } from "./random";

describe("seeded", () => {
  it("produces the same sequence for the same seed and values in [0, 1)", () => {
    const a = seeded(42);
    const b = seeded(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(seeded(1)()).not.toBe(seeded(2)());
  });
});

describe("pickWeighted", () => {
  const weights = { a: 0.5, b: 0.3, c: 0.2 };

  it("maps the unit interval onto the weights in order", () => {
    expect(pickWeighted(weights, 0)).toBe("a");
    expect(pickWeighted(weights, 0.49)).toBe("a");
    expect(pickWeighted(weights, 0.51)).toBe("b");
    expect(pickWeighted(weights, 0.79)).toBe("b");
    expect(pickWeighted(weights, 0.81)).toBe("c");
    expect(pickWeighted(weights, 0.999)).toBe("c");
  });

  it("does not require weights to sum to 1", () => {
    expect(pickWeighted({ x: 2, y: 2 }, 0.49)).toBe("x");
    expect(pickWeighted({ x: 2, y: 2 }, 0.51)).toBe("y");
  });
});

describe("poisson", () => {
  it("returns 0 for a non-positive rate", () => {
    expect(poisson(0)).toBe(0);
    expect(poisson(-1)).toBe(0);
  });

  it("has roughly the requested mean for the per-tick rates the simulator uses", () => {
    const lambda = 0.2; // 2 tps on a 100 ms tick
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) sum += poisson(lambda);
    expect(sum / n).toBeGreaterThan(0.17);
    expect(sum / n).toBeLessThan(0.23);
  });
});
