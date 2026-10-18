/** Our button vocabulary, powered by Animate UI's motion button. */
import { useReducedMotion } from "motion/react";
import {
  Button as AnimatedButton,
  type ButtonProps,
} from "@/components/animate-ui/components/buttons/button";
import { cn } from "@/utils/cn";

export function Button({ className, ...props }: ButtonProps) {
  const reduce = useReducedMotion();
  return (
    <AnimatedButton
      type="button"
      hoverScale={1}
      tapScale={reduce ? 1 : 0.98}
      className={cn(
        "rounded-lg text-[13px] font-medium shadow-none",
        className,
      )}
      {...props}
    />
  );
}
