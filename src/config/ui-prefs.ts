import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";

export type SetupMode = "auto" | "manual";

export const SETUP_MODES: readonly SetupMode[] = ["auto", "manual"];

/** Shown once, before the first ChatGPT connection on this machine. */
export const SETUP_CHOICE_PROMPT = [
  "Before connecting ChatGPT for the first time, choose a setup method (saved for later use):",
  "",
  "**1. AI-assisted setup (preview)**",
  "I handle setup in the built-in browser. You only need to act for login, verification codes or explicit confirmation.",
  "Benefit: very little manual interaction.",
  "Trade-off: more steps and slower overall; after two explicit setup failures, switch to guided manual setup.",
  "",
  "**2. Guided manual setup**",
  "I explain each page and field step by step, and you perform the actions in your browser.",
  "Benefit: typically takes about three minutes, with direct control and fewer automation dependencies.",
  "Trade-off: you need to follow the instructions rather than delegate every step.",
  "",
  "Reply with 1 or 2. Do not start setup before a choice is made.",
].join("\n");

interface StoredUiPrefs {
  developerModeEnabled?: boolean;
  setupMode?: SetupMode;
  updatedAt: string;
}

export interface UiPrefsView {
  developerModeEnabled: boolean;
  setupMode: SetupMode | null;
  setupChoicePrompt: string;
  remembered: {
    developerMode: boolean;
    setupMode: boolean;
  };
}

export function prefsFile(): string {
  return path.join(getStateDir(), "prefs.json");
}

function readStored(): StoredUiPrefs | null {
  const raw = readJsonIfExists<StoredUiPrefs>(prefsFile());
  if (!raw || typeof raw !== "object") return null;
  const setupMode = raw.setupMode === "auto" || raw.setupMode === "manual" ? raw.setupMode : undefined;
  return {
    developerModeEnabled: raw.developerModeEnabled === true,
    setupMode,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
}

export function readUiPrefs(): UiPrefsView {
  const stored = readStored();
  const developerModeEnabled = stored?.developerModeEnabled === true;
  const setupMode = stored?.setupMode ?? null;
  return {
    developerModeEnabled,
    setupMode,
    setupChoicePrompt: SETUP_CHOICE_PROMPT,
    remembered: {
      developerMode: developerModeEnabled,
      setupMode: setupMode !== null,
    },
  };
}

export interface UiPrefsPatch {
  developerModeEnabled?: true;
  setupMode?: SetupMode;
}

export function mergeUiPrefs(patch: UiPrefsPatch): UiPrefsView {
  if (patch.setupMode !== undefined && !SETUP_MODES.includes(patch.setupMode)) {
    throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
  }
  const previous = readStored();
  const setupMode = patch.setupMode ?? previous?.setupMode;
  const stored: StoredUiPrefs = {
    updatedAt: new Date().toISOString(),
  };
  // Only persist "confirmed on". Never write false — that would skip the
  // Security page on a new ChatGPT account or a machine restore.
  if (patch.developerModeEnabled === true || previous?.developerModeEnabled === true) {
    stored.developerModeEnabled = true;
  }
  if (setupMode) stored.setupMode = setupMode;
  writeSecureJson(prefsFile(), stored);
  return readUiPrefs();
}
