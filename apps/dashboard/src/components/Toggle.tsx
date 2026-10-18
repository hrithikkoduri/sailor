/** The gate's switch — used by onboarding and settings alike. */
export function Toggle({ on }: { on: boolean }) {
  return (
    <span
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-indigo-500" : "bg-white/15"
      }`}
    >
      <span
        className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-5.5" : "translate-x-1"
        }`}
      />
    </span>
  );
}
