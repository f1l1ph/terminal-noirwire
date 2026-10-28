import { describe, expect, it } from "vitest";
import {
  formatClockTime,
  formatDecimal,
  formatDuration,
  formatEventTime,
  formatMoney,
  formatPercent,
  formatRelativeAge,
  formatShortAddress,
  formatTimeLeft,
  formatUpdatedAge,
  UNAVAILABLE,
} from "@/lib/format";

describe("formatDecimal", () => {
  it("groups thousands and pads to the given precision", () => {
    expect(formatDecimal(1234.5, 2)).toBe("1,234.50");
  });

  it("shows a nonzero amount below display precision as a bound, never 0.00", () => {
    expect(formatDecimal(0.0004, 2)).toBe("<0.01");
  });

  it("shows an exact zero as 0.00, not <0.01", () => {
    expect(formatDecimal(0, 2)).toBe("0.00");
  });

  it("reports an unparsable value as Unavailable", () => {
    expect(formatDecimal("not-a-number", 2)).toBe(UNAVAILABLE);
    expect(formatDecimal(Number.NaN, 2)).toBe(UNAVAILABLE);
  });

  it("accepts a decimal string", () => {
    expect(formatDecimal("42.1", 4)).toBe("42.1000");
  });
});

describe("formatMoney", () => {
  it("labels the amount with the venue's own quote symbol, never a bare dollar sign", () => {
    expect(formatMoney(5000, "nUSD")).toBe("5,000.00 nUSD");
    expect(formatMoney("12.5", "USDC")).toBe("12.50 USDC");
  });

  it("shows the number alone while the quote symbol is not known yet", () => {
    expect(formatMoney(5000, "")).toBe("5,000.00");
  });

  it("stays Unavailable without a trailing label", () => {
    expect(formatMoney(Number.NaN, "USDC")).toBe(UNAVAILABLE);
  });
});

describe("formatPercent", () => {
  it("signs a positive change", () => {
    expect(formatPercent(3.456)).toBe("+3.46%");
  });

  it("keeps the sign on a negative change", () => {
    expect(formatPercent(-1.2)).toBe("-1.20%");
  });
});

describe("formatDuration", () => {
  it("uses milliseconds below one second", () => {
    expect(formatDuration(420)).toBe("420 ms");
  });

  it("switches to seconds at the one second boundary", () => {
    expect(formatDuration(1000)).toBe("1.00 s");
    expect(formatDuration(910)).toBe("910 ms");
    expect(formatDuration(1240)).toBe("1.24 s");
  });

  it("rejects a negative or non-finite duration", () => {
    expect(formatDuration(-5)).toBe(UNAVAILABLE);
    expect(formatDuration(Number.NaN)).toBe(UNAVAILABLE);
  });
});

describe("formatClockTime", () => {
  it("pads hours, minutes, seconds and milliseconds", () => {
    const date = new Date(2026, 0, 5, 3, 4, 5, 6);
    expect(formatClockTime(date)).toBe("03:04:05.006");
  });
});

describe("formatRelativeAge", () => {
  it("buckets by magnitude", () => {
    expect(formatRelativeAge(400)).toBe("just now");
    expect(formatRelativeAge(4_000)).toBe("4s");
    expect(formatRelativeAge(120_000)).toBe("2m");
    expect(formatRelativeAge(7_200_000)).toBe("2h");
    expect(formatRelativeAge(172_800_000)).toBe("2d");
  });
});

describe("formatTimeLeft", () => {
  const now = 1_000_000;
  it("reads the time until expiry in the two largest units", () => {
    expect(formatTimeLeft(now + 30_000, now)).toBe("under 1m");
    expect(formatTimeLeft(now + 52 * 60_000 + 20_000, now)).toBe("52m");
    expect(formatTimeLeft(now + (3 * 60 + 10) * 60_000, now)).toBe("3h 10m");
    expect(formatTimeLeft(now + 2 * 3_600_000, now)).toBe("2h");
    expect(formatTimeLeft(now + 51 * 3_600_000, now)).toBe("2d 3h");
  });

  it("says Expired once the moment has passed", () => {
    expect(formatTimeLeft(now, now)).toBe("Expired");
    expect(formatTimeLeft(now - 5_000, now)).toBe("Expired");
  });

  it("reports a non-finite time as Unavailable", () => {
    expect(formatTimeLeft(Number.NaN, now)).toBe(UNAVAILABLE);
  });
});

describe("formatUpdatedAge", () => {
  it("says just now without a trailing ago", () => {
    expect(formatUpdatedAge(400)).toBe("Updated just now");
  });

  it("names the age and ends in ago", () => {
    expect(formatUpdatedAge(42_000)).toBe("Updated 42s ago");
    expect(formatUpdatedAge(120_000)).toBe("Updated 2m ago");
  });
});

describe("formatEventTime", () => {
  it("shows a clock time for an event from today", () => {
    const now = new Date(2026, 0, 5, 12, 0, 0);
    const event = new Date(2026, 0, 5, 9, 30, 0, 500);
    expect(formatEventTime(event, now)).toBe("09:30:00.500");
  });

  it("shows a date for an event from an earlier day", () => {
    const now = new Date(2026, 0, 5, 12, 0, 0);
    const event = new Date(2026, 0, 1, 9, 30, 0, 500);
    expect(formatEventTime(event, now)).toBe("2026-01-01");
  });
});

describe("formatShortAddress", () => {
  it("keeps a short string as is", () => {
    expect(formatShortAddress("abc123")).toBe("abc123");
  });

  it("shortens a long address to first six and last four", () => {
    expect(formatShortAddress("9xQeWv7xFd8jp7Kn3V8t7XaYJ6s2B3qkFfD4vK9pump")).toBe("9xQeWv…pump");
  });
});
