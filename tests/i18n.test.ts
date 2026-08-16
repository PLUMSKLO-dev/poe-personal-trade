import { afterEach, describe, expect, it } from "vitest";
import { getLanguage, locale, setLanguage, t } from "../src/renderer/i18n";

describe("renderer translations", () => {
  afterEach(() => setLanguage("en"));

  it("uses English as the public default", () => {
    expect(getLanguage()).toBe("en");
    expect(locale()).toBe("en-US");
    expect(t("priceCheck")).toBe("Price check");
    expect(t("resultsSummary", { total: "12", loaded: 10 })).toBe("12 results · cheapest 10 loaded");
  });

  it("switches every lookup to German", () => {
    setLanguage("de");
    expect(locale()).toBe("de-DE");
    expect(t("priceCheck")).toBe("Preis prüfen");
    expect(t("skillsDetected", { count: 6 })).toBe("6 Skills erkannt");
  });
});
