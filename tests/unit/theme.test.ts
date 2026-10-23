import { describe, expect, it } from "vitest";
import {
  ACCENTS,
  applyTheme,
  accentColor,
  canvasPalette,
  isAccentHex,
  loadThemeSettings,
  resolveThemeName,
  THEMES,
} from "../../src/theme.js";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  // why: satisfies the DOM Storage index signature requirement
  [name: string]: unknown;

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe("resolveThemeName", () => {
  it("accepts every defined theme", () => {
    expect(resolveThemeName("nord")).toBe("nord");
    expect(resolveThemeName("charcoal")).toBe("charcoal");
  });

  it("falls back to nord for unknown values", () => {
    expect(resolveThemeName("solarized")).toBe("nord");
    expect(resolveThemeName(null)).toBe("nord");
  });
});

describe("isAccentHex", () => {
  it("accepts the preset accents only", () => {
    for (const preset of ACCENTS) {
      expect(isAccentHex(preset.hex)).toBe(true);
    }
    expect(isAccentHex("#123456")).toBe(false);
    expect(isAccentHex(123)).toBe(false);
  });
});

describe("loadThemeSettings", () => {
  it("returns the theme default accent when nothing is stored", () => {
    const settings = loadThemeSettings(new MemoryStorage());
    expect(settings.theme).toBe("nord");
    expect(settings.accent).toBe(THEMES.nord.defaultAccent);
  });

  it("restores persisted values", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "infinite-minesweeper.theme.v1",
      JSON.stringify({ theme: "charcoal", accent: "#a3be8c", flagFirst: true }),
    );
    expect(loadThemeSettings(storage)).toEqual({
      theme: "charcoal",
      accent: "#a3be8c",
      flagFirst: true,
    });
  });

  it("returns flagFirst undefined when absent, true and false when set", () => {
    expect(loadThemeSettings(new MemoryStorage()).flagFirst).toBeUndefined();
    const storage = new MemoryStorage();
    storage.setItem(
      "infinite-minesweeper.theme.v1",
      JSON.stringify({ flagFirst: false }),
    );
    expect(loadThemeSettings(storage).flagFirst).toBe(false);
    storage.setItem(
      "infinite-minesweeper.theme.v1",
      JSON.stringify({ flagFirst: "yes" }),
    );
    expect(loadThemeSettings(storage).flagFirst).toBeUndefined();
  });

  it("ignores corrupt or invalid data", () => {
    const storage = new MemoryStorage();
    storage.setItem("infinite-minesweeper.theme.v1", "{not json");
    expect(loadThemeSettings(storage).theme).toBe("nord");
    storage.setItem(
      "infinite-minesweeper.theme.v1",
      JSON.stringify({ theme: "charcoal", accent: "#123456" }),
    );
    const settings = loadThemeSettings(storage);
    expect(settings.theme).toBe("charcoal");
    expect(settings.accent).toBe(THEMES.charcoal.defaultAccent);
  });
});

// why: tests run in node without a DOM; applyTheme only needs setProperty
function stubDocument(): Document {
  return {
    documentElement: {
      style: {
        setProperty: () => undefined,
      },
    },
  } as unknown as Document;
}

describe("applyTheme", () => {
  it("updates the canvas palette and accent, and persists", () => {
    const storage = new MemoryStorage();
    applyTheme("charcoal", "#d08770", true, stubDocument(), storage);
    expect(canvasPalette().background).toBe(THEMES.charcoal.canvas.background);
    expect(canvasPalette().hidden).toBe("#d08770");
    expect(accentColor()).toBe("#d08770");
    expect(loadThemeSettings(storage)).toEqual({
      theme: "charcoal",
      accent: "#d08770",
      flagFirst: true,
    });
    applyTheme("nord", "#88c0d0", false, stubDocument(), new MemoryStorage());
    expect(canvasPalette().background).toBe(THEMES.nord.canvas.background);
    expect(canvasPalette().hidden).toBe("#88c0d0");
  });

  it("falls back to the theme default for an invalid accent", () => {
    applyTheme("nord", "#123456", false, stubDocument(), new MemoryStorage());
    expect(accentColor()).toBe(THEMES.nord.defaultAccent);
  });
});
