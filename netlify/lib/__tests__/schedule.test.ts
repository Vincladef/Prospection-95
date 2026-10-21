import { describe, expect, it } from "vitest";
import { isWithinSendWindow, nextAllowedInstant, nextSequenceDueAt } from "../schedule.mts";

const window = {
  timezone: "Europe/Paris",
  sendDays: [1, 2, 3, 4, 5],
  start: "08:00",
  end: "18:00",
};

describe("send scheduling", () => {
  it("accepts a weekday instant inside the Paris window", () => {
    expect(isWithinSendWindow(new Date("2026-10-21T10:00:00Z"), window)).toBe(true);
  });

  it("moves a weekend to Monday morning in Paris", () => {
    expect(nextAllowedInstant(new Date("2026-10-24T12:00:00Z"), window).toISOString()).toBe(
      "2026-10-26T07:00:00.000Z",
    );
  });

  it("bases R1 on the confirmed J0 send and adds three days", () => {
    expect(
      nextSequenceDueAt(new Date("2026-10-19T08:30:00Z"), "R1", window).toISOString(),
    ).toBe("2026-10-22T08:30:00.000Z");
  });

  it("keeps the Paris business hour across the autumn DST change", () => {
    expect(nextAllowedInstant(new Date("2026-10-25T06:30:00Z"), window).toISOString()).toBe(
      "2026-10-26T07:00:00.000Z",
    );
  });
});
