import type { GateInstallation } from "./api";

/** Enabled repository names, stable-sorted and de-duplicated across installs. */
export function enabledRepositoryNames(installations: GateInstallation[]): string[] {
  return [
    ...new Set(
      installations
        .filter((installation) => !installation.suspended)
        .flatMap((installation) =>
          installation.repos
            .filter((repo) => repo.enabled)
            .map((repo) => repo.fullName),
        ),
    ),
  ].sort();
}
