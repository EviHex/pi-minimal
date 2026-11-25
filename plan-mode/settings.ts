import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Key id type as pi validates it (pi-tui is not a declared dependency). */
type KeyId = Parameters<ExtensionAPI["registerShortcut"]>[0];

/** What the user can configure in settings.json, under "pi-minimal"."plan-mode" */
export interface PlanModeSettings {
	/** Keyboard shortcut to toggle plan mode. */
	keyboardShortcut: KeyId;
}

/** Fallback when keys are not configured */
const DEFAULT_SETTINGS: PlanModeSettings = {
	keyboardShortcut: "ctrl+alt+p"
};

export function loadSettings(pi: ExtensionAPI): PlanModeSettings {
	const file = pi.getSettings() as { "pi-minimal"?: { "plan-mode"?: Partial<PlanModeSettings> } };
	return { ...DEFAULT_SETTINGS, ...file["pi-minimal"]?.["plan-mode"] };
}
