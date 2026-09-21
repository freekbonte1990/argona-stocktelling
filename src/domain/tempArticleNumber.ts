import type { Article } from "./types";

/**
 * Genereert tijdelijke artikelnummers voor artikelen die tijdens het werk
 * ontdekt worden en nog niet in de artikelstam staan (v0.2.1 correctieronde
 * §3): "Gebruik een robuuste generator die geen reeds bestaande tijdelijke
 * nummers dupliceert." en "Maak NOOIT zelf een officieel ERP/eBuddy-
 * artikelnummer."
 *
 * Volgt exact de conventie die al elders in de codebase voorkomt (zie
 * CountingService.test.ts / spec-voorbeelden): `TMP-<3-letter kantoorcode>-
 * <4-cijferig volgnummer>`, bv. `TMP-DAM-0001`. Het interne `Article.id`
 * gebruikt gewoon dit zichtbare nummer (net als bij een officieel nummer) —
 * er is geen aparte UUID nodig, het tijdelijke nummer is zelf al robuust
 * genoeg als unieke sleutel binnen één kantoor.
 *
 * ROBUUSTHEID: de generator scant de bestaande artikelen van HETZELFDE
 * kantoor (de aanroeper geeft enkel al kantoor-gescoopte artikelen door —
 * zie NewArticleService) op reeds gebruikte volgnummers voor deze
 * kantoorcode, en telt vanaf het hoogst gevonden nummer + 1 verder. Dit
 * dedupliceert ook wanneer er "gaten" zijn (bv. na een import van een extern
 * bestand met TMP-nummers) — nooit een nummer herbruiken dat al bestaat.
 */

const TEMP_NUMBER_PATTERN = /^TMP-([A-Z]{3})-(\d{4,})$/;

/** Leidt een stabiele 3-letterige kantoorcode af uit de kantoornaam. */
export function deriveOfficeCode(officeName: string): string {
  const normalized = officeName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // diacritics (bv. "é" -> "e") wegfilteren
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (normalized.length === 0) return "OFF";
  return normalized.slice(0, 3).padEnd(3, "X");
}

/**
 * Genereert het volgende vrije tijdelijke artikelnummer voor dit kantoor.
 * `existingArticles` moet reeds gescoopt zijn tot het kantoor in kwestie
 * (bv. via `CountingRepository#getArticles(officeId)`) — deze functie kent
 * zelf geen kantoor-scoping, om puur en makkelijk testbaar te blijven.
 */
export function generateTempArticleNumber(
  officeName: string,
  existingArticles: Pick<Article, "articleNumber">[],
): string {
  const code = deriveOfficeCode(officeName);
  let maxSequence = 0;
  for (const article of existingArticles) {
    const match = TEMP_NUMBER_PATTERN.exec(article.articleNumber);
    if (match && match[1] === code) {
      const sequence = parseInt(match[2], 10);
      if (sequence > maxSequence) maxSequence = sequence;
    }
  }
  const next = maxSequence + 1;
  return `TMP-${code}-${String(next).padStart(4, "0")}`;
}
