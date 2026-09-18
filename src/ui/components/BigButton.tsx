import type { ButtonHTMLAttributes } from "react";

interface BigButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
}

/** Grote, duimvriendelijke knop — de belangrijkste actie op een scherm moet altijd zo'n knop zijn. */
export function BigButton({ variant = "primary", className, ...rest }: BigButtonProps) {
  const variantClass =
    variant === "primary"
      ? "big-button--primary"
      : variant === "secondary"
        ? "big-button--secondary"
        : "big-button--ghost";
  return <button className={["big-button", variantClass, className].filter(Boolean).join(" ")} {...rest} />;
}
