/**
 * The Sailor identity: the helm mark, the wordmark, the octocat.
 *
 * The helm is ONE geometry worn everywhere — product logo, favicon
 * (public/favicon.svg mirrors it), and busy indicator (`helm-spin` turns it
 * while work is happening: agent messages, tool activity, thinking).
 */
export function Helm({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      fill="none"
      aria-hidden
    >
      {/* A traditional eight-handle helm: a weighty rim, tapered spokes,
          turned grips, and an open hub, following the reference silhouette. */}
      {Array.from({ length: 8 }, (_, i) => (
        <g key={i} transform={`rotate(${i * 45} 16 16)`} fill="currentColor">
          <path d="M15.45 14.1 15.15 7.7h1.7l-.3 6.4Z" />
          <path d="M15.35 6.4 15.5 4.3C15.05 3.75 14.95 3.2 15.1 2.95c.25-.6 1.55-.6 1.8 0 .1.35.05.9-.4 1.35l.15 2.1Z" />
        </g>
      ))}
      <circle cx="16" cy="16" r="9" stroke="currentColor" strokeWidth="2.8" />
      <circle cx="16" cy="16" r="1.9" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Bare monochrome mark: no tile, border, or background. */
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center text-foreground"
      style={{ width: size, height: size }}
    >
      <Helm size={size * 0.875} />
    </span>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5 select-none">
      <Logo size={34} />
      <span className="text-lg font-semibold tracking-[-.04em] text-foreground">
        sailor.
      </span>
    </span>
  );
}

/** The octocat — for the GitHub sign-in button. */
export function GithubMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
