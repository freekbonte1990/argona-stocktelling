import type { ButtonHTMLAttributes } from "react";

interface BigButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * "subtle" (visuele-polish-sprint §2): zelfde knop/gedrag als "ghost",
   * maar visueel nog stiller (tekstlink-achtig, geen rand) — voor een actie
   * die zichtbaar en bereikbaar moet blijven zonder als gelijkwaardig
   * alternatief naast de primaire actie te ogen (bv. "Telling annuleren"
   * naast "Hervatten"). Puur presentatie, geen nieuwe interactie.
   */
  variant?: "primary" | "secondary" | "ghost" | "subtle";
}

/** Grote, duimvriendelijke knop — de belangrijkste actie op een scherm moet altijd zo'n knop zijn. */
export function BigButton({ variant = "primary", className, ...rest }: BigButtonProps) {
  const variantClass =
    variant === "primary"
      ? "big-button--primary"
      : variant === "secondary"
        ? "big-button--secondary"
        : variant === "subtle"
          ? "big-button--subtle"
          : "big-button--ghost";
  return <button className={["big-button", variantClass, className].filter(Boolean).join(" ")} {...rest} />;
}
