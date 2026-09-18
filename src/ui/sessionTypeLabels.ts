import type { CountSessionType } from "../domain/types";

/** Titelversie, bv. voor schermtitels: "Maandtelling". */
export const SESSION_TYPE_LABELS: Record<CountSessionType, string> = {
  MONTHLY: "Maandtelling",
  QUARTERLY: "Kwartaaltelling",
  YEARLY: "Jaartelling",
  FULL: "Volledige telling",
};

/** Onderdeel-van-zin versie, bv. "...behoort normaal niet tot deze maandtelling." */
export const SESSION_TYPE_NOUN_LOWER: Record<CountSessionType, string> = {
  MONTHLY: "maandtelling",
  QUARTERLY: "kwartaaltelling",
  YEARLY: "jaartelling",
  FULL: "volledige telling",
};
