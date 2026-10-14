import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

/** What the user can configure in settings.json, under "pi-minimal"."plan-mode" */
export interface PlanModeSettings {
	/** Keyboard shortcut to toggle plan mode. */
	keyboardShortcut: KeyId;
}

const DEFAULT_SETTINGS: PlanModeSettings = {
	keyboardShortcut: "ctrl+shift+p"
};

export function loadSettings(pi: ExtensionAPI): PlanModeSettings {
	const file = pi.getSettings() as { "pi-minimal"?: { "plan-mode"?: Partial<PlanModeSettings> } };
	return { ...DEFAULT_SETTINGS, ...file["pi-minimal"]?.["plan-mode"] };
}
