import {
  planAddLocation,
  planMoveToLocation,
  planRemoveLocation,
} from "../../domain/bulkLocationAssignment";
import type { CountingRepository } from "../ports/CountingRepository";

/**
 * Orchestreert bulk locatiebeheer vanuit het Artikels-overzicht (v0.2.1:
 * "locatie-toewijzing veel sneller maken" dan via
 * Artikel openen → dropdown → locatie toevoegen). De eigenlijke
 * beslissingslogica staat puur en apart getest in
 * domain/bulkLocationAssignment.ts — deze service haalt enkel de huidige
 * koppelingen op (waar nodig) en schrijft het berekende resultaat weg.
 *
 * Ook gebruikt voor de "snelle locatiebediening" per artikelrij (spec §3):
 * dat is gewoon dezelfde bulk-actie met een array van één artikel-ID.
 */
export class LocationAssignmentService {
  private readonly repository: CountingRepository;

  constructor(repository: CountingRepository) {
    this.repository = repository;
  }

  async addLocation(officeId: string, articleIds: string[], locationId: string): Promise<void> {
    if (articleIds.length === 0) return;
    const plan = planAddLocation(officeId, articleIds, locationId, new Date().toISOString());
    await this.repository.saveArticleLocationAssignments(plan);
  }

  async removeLocation(officeId: string, articleIds: string[], locationId: string): Promise<void> {
    if (articleIds.length === 0) return;
    const existing = await this.repository.getArticleLocationAssignments(officeId);
    const plan = planRemoveLocation(officeId, articleIds, locationId, existing, new Date().toISOString());
    if (plan.length === 0) return;
    await this.repository.saveArticleLocationAssignments(plan);
  }

  async moveToLocation(officeId: string, articleIds: string[], locationId: string): Promise<void> {
    if (articleIds.length === 0) return;
    const existing = await this.repository.getArticleLocationAssignments(officeId);
    const plan = planMoveToLocation(officeId, articleIds, locationId, existing, new Date().toISOString());
    if (plan.length === 0) return;
    await this.repository.saveArticleLocationAssignments(plan);
  }
}
