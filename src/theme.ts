// Single source of truth for every color in the app: CSS variables for the
// DOM/HUD and the canvas palette for the board. applyTheme pushes both at
// once so the accent color propagates everywhere simultaneously.

export type ThemeName = "nord" | "charcoal";

export interface CanvasPalette {
  readonly background: string;
  readonly hidden: string;
  readonly hiddenHover: string;
  readonly revealed: string;
  readonly grid: string;
  readonly flag: string;
  readonly flagPole: string;
  readonly mine: string;
  readonly exploded: string;
  readonly hint: string;
  readonly numbers: readonly string[];
}

export interface AccentPreset {
  readonly name: string;
  readonly hex: string;
}

export const ACCENTS: readonly AccentPreset[] = [
  { name: "Frost", hex: "#88c0d0" },
  { name: "Aurora Red", hex: "#bf616a" },
  { name: "Aurora Orange", hex: "#d08770" },
  { name: "Aurora Yellow", hex: "#ebcb8b" },
  { name: "Aurora Green", hex: "#a3be8c" },
  { name: "Aurora Purple", hex: "#b48ead" },
];

interface ThemeDefinition {
  readonly cssVars: Readonly<Record<string, string>>;
  readonly defaultAccent: string;
  readonly canvas: CanvasPalette;
}

export const THEMES: Readonly<Record<ThemeName, ThemeDefinition>> = {
  nord: {
    cssVars: {
      "--bg": "#2e3440",
      "--panel": "#3b4252",
      "--panel-border": "#4c566a",
      "--text": "#eceff4",
      "--muted": "#d8dee9",
      "--button": "#434c5e",
      "--button-hover": "#4c566a",
      "--button-border-hover": "#5c6a80",
      "--primary-text": "#2e3440",
    },
    defaultAccent: "#88c0d0",
    canvas: {
      background: "#2e3440",
      hidden: "#434c5e",
      hiddenHover: "#4c566a",
      revealed: "#3b4252",
      grid: "#2e3440",
      flag: "#bf616a",
      flagPole: "#d8dee9",
      mine: "#bf616a",
      exploded: "#bf616a",
      hint: "#ebcb8b",
      numbers: [
        "#5e81ac",
        "#a3be8c",
        "#bf616a",
        "#b48ead",
        "#ebcb8b",
        "#8fbcbb",
        "#d08770",
        "#d8dee9",
      ],
    },
  },
  charcoal: {
    cssVars: {
      "--bg": "#17130f",
      "--panel": "#221c16",
      "--panel-border": "#3a3128",
      "--text": "#ede4d4",
      "--muted": "#a89a86",
      "--button": "#2c2419",
      "--button-hover": "#382e21",
      "--button-border-hover": "#4d4131",
      "--primary-text": "#17130f",
    },
    defaultAccent: "#d08770",
    canvas: {
      background: "#17130f",
      hidden: "#332b20",
      hiddenHover: "#40362a",
      revealed: "#241e15",
      grid: "#17130f",
      flag: "#e0954f",
      flagPole: "#e8ddc8",
      mine: "#d08a7a",
      exploded: "#b0503c",
      hint: "#e0be6a",
      numbers: [
        "#7ba3c4",
        "#94b878",
        "#d99a86",
        "#ab8ecb",
        "#dec987",
        "#6fb5a8",
        "#d295b5",
        "#e8ddc8",
      ],
    },
  },
};

export interface ThemeSettings {
  readonly theme: ThemeName;
  readonly accent: string;
}

const STORAGE_KEY = "infinite-minesweeper.theme.v1";

export function resolveThemeName(value: unknown): ThemeName {
  return value === "charcoal" ? "charcoal" : "nord";
}

export function isAccentHex(value: unknown): value is string {
  return (
    typeof value === "string" && ACCENTS.some((preset) => preset.hex === value)
  );
}

export function loadThemeSettings(storage: Storage): ThemeSettings {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    parsed = null;
  }
  const raw =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  const theme = resolveThemeName(raw.theme);
  const accent = isAccentHex(raw.accent)
    ? raw.accent
    : THEMES[theme].defaultAccent;
  return { theme, accent };
}

let activeCanvasPalette: CanvasPalette = THEMES.nord.canvas;
let activeAccent: string = THEMES.nord.defaultAccent;

export function canvasPalette(): CanvasPalette {
  return activeCanvasPalette;
}

export function accentColor(): string {
  return activeAccent;
}

export function applyTheme(
  theme: ThemeName,
  accent: string,
  documentRef: Document,
  storage: Storage,
): void {
  const definition = THEMES[theme];
  const resolvedAccent = isAccentHex(accent)
    ? accent
    : definition.defaultAccent;
  for (const [name, value] of Object.entries(definition.cssVars)) {
    documentRef.documentElement.style.setProperty(name, value);
  }
  documentRef.documentElement.style.setProperty("--accent", resolvedAccent);
  activeCanvasPalette = definition.canvas;
  activeAccent = resolvedAccent;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ theme, accent: resolvedAccent }),
    );
  } catch {
    // why: sandboxed storage can throw; appearance is a cosmetic preference
  }
}
