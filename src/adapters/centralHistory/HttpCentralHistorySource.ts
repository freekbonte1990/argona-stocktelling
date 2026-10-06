import { CentralHistoryFormatError, parseCentralHistoryFile } from "../../domain/centralHistoryFile";
import type { CentralHistoryFile } from "../../domain/centralHistoryFile";
import { CentralHistoryError, type CentralHistorySource } from "../../application/ports/CentralHistorySource";

export const DEFAULT_CENTRAL_HISTORY_ENDPOINT = "/api/central-history";

export interface HttpCentralHistorySourceOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * `CentralHistorySource` tegen het Vercel-endpoint `api/central-history.ts`
 * (geen authenticatie, geen toegangscode). De centrale data staat bewust NIET als
 * statisch bestand in `public/`/`dist/` maar enkel achter dit alleen-lezen endpoint.
 *
 * ENKEL LEZEN (user-eis 1): één GET, geen enkele schrijfmethode.
 * Vertaalt elke mislukking naar een `CentralHistoryError` — gooit nooit iets
 * anders, zodat de sync-service het altijd netjes kan afvangen.
 *
 * Migratiepad eBuddy (user-eis 8): een `EBuddyCentralHistorySource` die
 * dezelfde poort implementeert vervangt deze klasse in `application/container.ts`;
 * niets anders verandert.
 */
export class HttpCentralHistorySource implements CentralHistorySource {
  readonly label = "Argona centrale historiek";
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpCentralHistorySourceOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_CENTRAL_HISTORY_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async fetchOfficeHistory(officeId: string): Promise<CentralHistoryFile> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoint}?officeId=${encodeURIComponent(officeId)}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
    } catch {
      throw new CentralHistoryError("unavailable", "Centrale historiek niet bereikbaar.");
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) {
      throw new CentralHistoryError("not-found", "Geen centrale historiek voor dit kantoor.");
    }
    if (!response.ok) {
      throw new CentralHistoryError("unavailable", `Centrale historiek niet beschikbaar (HTTP ${response.status}).`);
    }
    // In `vite dev`/zonder functie antwoordt een SPA-fallback met HTML (200) —
    // dat is "endpoint niet beschikbaar", geen corrupt bestand.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      throw new CentralHistoryError("unavailable", "Het centrale endpoint is hier niet beschikbaar.");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CentralHistoryError("invalid", "het antwoord is geen geldige JSON.");
    }
    try {
      return parseCentralHistoryFile(payload, officeId);
    } catch (error) {
      if (error instanceof CentralHistoryFormatError) {
        throw new CentralHistoryError("invalid", error.message);
      }
      throw new CentralHistoryError("invalid", "onbekende fout bij het lezen van het bestand.");
    }
  }
}
