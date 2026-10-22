/** One place for platform-dependent shortcut copy. */
export function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function primaryModifier(): "⌘" | "Ctrl" {
  return isApplePlatform() ? "⌘" : "Ctrl";
}
