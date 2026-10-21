/** Shared motion vocabulary: quick feedback, settled springs, no content blur. */
export const panelTransition = { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const };
export const controlSpring = { type: "spring" as const, stiffness: 360, damping: 32, mass: 0.8 };
