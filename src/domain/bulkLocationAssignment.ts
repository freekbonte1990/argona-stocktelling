import type { ArticleLocationAssignment } from "./types";

/**
 * Pure planningslogica voor bulk locatiebeheer vanuit het Artikels-overzicht
 * (v0.2.1: "locatie-toewijzing veel sneller maken" — vooraf indelen,
 * correcties, verhuis/herorganisatie, zonder telkens de artikeldetailpagina
 * te moeten openen). Berekent enkel WELKE `ArticleLocationAssignment`-rijen
 * geschreven moeten worden; schrijft zelf niets weg (zie
 * application/services/LocationAssignmentService.ts voor de orchestratie).
 *
 * Veiligheid (spec §9): deze functies raken NOOIT `CountEntry`'s of
 * voorraadhoeveelheden — enkel `ArticleLocationAssignment`. En net als het
 * bestaande "zacht verwijderen"-patroon (domain/locations.ts) wordt een
 * koppeling nooit hard verwijderd, enkel `active` aan/uit gezet: historische
 * tellingen blijven altijd geldig, want die verwijzen naar `Location.id`,
 * nooit naar de assignment zelf.
 */

function assignmentId(officeId: string, articleId: string, locationId: string): string {
  return `${officeId}:${articleId}:${locationId}`;
}

/**
 * "Locatie toevoegen": voegt `locationId` toe aan elk artikel in
 * `articleIds`, zonder de bestaande koppelingen van die artikelen te raken
 * (spec §2: "Bestaande locaties blijven behouden") — dit schrijft enkel de
 * nieuwe koppeling, andere assignments van diezelfde artikelen blijven
 * ongewijzigd omdat ze hier niet in de planning voorkomen.
 */
export function planAddLocation(
  officeId: string,
  articleIds: string[],
  locationId: string,
  now: string,
): ArticleLocationAssignment[] {
  return Array.from(new Set(articleIds)).map((articleId) => ({
    id: assignmentId(officeId, articleId, locationId),
    officeId,
    articleId,
    locationId,
    active: true,
    lastSeenAt: now,
  }));
}

/**
 * "Locatie verwijderen": deactiveert enkel de gekozen locatie voor de
 * geselecteerde artikelen (spec §2). Een artikel dat daar toch geen actieve
 * koppeling naar had, blijft gewoon ongewijzigd — er is dan niets te
 * schrijven voor dat artikel.
 */
export function planRemoveLocation(
  officeId: string,
  articleIds: string[],
  locationId: string,
  existingAssignments: ArticleLocationAssignment[],
  now: string,
): ArticleLocationAssignment[] {
  const existingById = new Map(existingAssignments.map((a) => [a.id, a]));
  const plan: ArticleLocationAssignment[] = [];
  for (const articleId of new Set(articleIds)) {
    const existing = existingById.get(assignmentId(officeId, articleId, locationId));
    if (existing?.active) {
      plan.push({ ...existing, active: false, lastSeenAt: now });
    }
  }
  return plan;
}

/**
 * "Verplaatsen naar": vervangt de huidige ACTIEVE locatie(s) van elk
 * geselecteerd artikel door `newLocationId` — bewust een andere actie dan
 * "toevoegen" (spec §2): de oude verwachte locatie(s) worden gedeactiveerd,
 * niet behouden. Historische tellingen blijven volledig intact, want dit
 * raakt enkel `ArticleLocationAssignment`, nooit `CountEntry`.
 */
export function planMoveToLocation(
  officeId: string,
  articleIds: string[],
  newLocationId: string,
  existingAssignments: ArticleLocationAssignment[],
  now: string,
): ArticleLocationAssignment[] {
  const plan: ArticleLocationAssignment[] = [];
  for (const articleId of new Set(articleIds)) {
    const currentActive = existingAssignments.filter((a) => a.articleId === articleId && a.active);
    let alreadyAtNewLocation = false;
    for (const assignment of currentActive) {
      if (assignment.locationId === newLocationId) {
        // Al actief op de nieuwe locatie: niets aan te passen, gewoon actief laten.
        alreadyAtNewLocation = true;
        continue;
      }
      plan.push({ ...assignment, active: false, lastSeenAt: now });
    }
    if (!alreadyAtNewLocation) {
      plan.push({
        id: assignmentId(officeId, articleId, newLocationId),
        officeId,
        articleId,
        locationId: newLocationId,
        active: true,
        lastSeenAt: now,
      });
    }
  }
  return plan;
}
