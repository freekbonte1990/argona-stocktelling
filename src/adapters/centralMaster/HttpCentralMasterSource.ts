import {
  CentralMasterFormatError,
  parseCentralMasterFile,
  parseCentralOfficeIndex,
  type CentralOfficeSummary,
} from "../../domain/centralMasterFile";
import {
  CentralMasterError,
  type CentralMasterFetchResult,
  type CentralMasterSource,
  type FetchOfficeMasterOptions,
} from "../../application/ports/CentralMasterSource";

export const DEFAULT_CENTRAL_MASTER_ENDPOINT = "/api/central-master";

export interface HttpCentralMasterSourceOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * `CentralMasterSource` tegen het Vercel-endpoint `api/central-master.ts` (geen
 * authenticatie, geen toegangscode). De masterdata staat bewust NIET als statisch
 * bestand in `public/`/`dist/` maar enkel achter dit alleen-lezen endpoint.
 *
 * ENKEL LEZEN: alleen GET-aanvragen. Vertaalt elke mislukking naar een
 * `CentralMasterError` en gooit nooit iets anders.
 *
 * Migratiepad eBuddy: een `EBuddyCentralMasterSource` implementeert dezelfde
 * poort (zie `application/ports/CentralMasterSource.ts`) en vervangt deze klasse
 * in `application/container.ts`.
 */
export class HttpCentralMasterSource implements CentralMasterSource {
  readonly label = "Argona centrale masterdata";
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpCentralMasterSourceOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_CENTRAL_MASTER_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async fetchOfficeIndex(): Promise<CentralOfficeSummary[]> {
    const response = await this.request(this.endpoint, {});
    const payload = await this.readJson(response);
    try {
      return parseCentralOfficeIndex(payload).offices;
    } catch (error) {
      throw this.asInvalid(error);
    }
  }

  async fetchOfficeMaster(officeId: string, options: FetchOfficeMasterOptions = {}): Promise<CentralMasterFetchResult> {
    const headers: Record<string, string> = {};
    if (options.knownRevision) headers["If-None-Match"] = `"${options.knownRevision}"`;
    const response = await this.request(`${this.endpoint}?officeId=${encodeURIComponent(officeId)}`, headers);
    if (response.status === 304) return { kind: "unchanged" };
    const payload = await this.readJson(response);
    try {
      return { kind: "master", file: parseCentralMasterFile(payload, officeId) };
    } catch (error) {
      throw this.asInvalid(error);
    }
  }

  private async request(url: string, extraHeaders: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", ...extraHeaders },
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
    } catch {
      throw new CentralMasterError("unavailable", "Centrale masterdata niet bereikbaar.");
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 304) return response;
    if (response.status === 404) {
      throw new CentralMasterError("not-found", "Geen centrale masterdata voor dit kantoor.");
    }
    if (!response.ok) {
      throw new CentralMasterError("unavailable", `Centrale masterdata niet beschikbaar (HTTP ${response.status}).`);
    }
    // In `vite dev`/zonder functie antwoordt een SPA-fallback met HTML (200) —
    // dat is "endpoint niet beschikbaar", geen corrupt bestand.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      throw new CentralMasterError("unavailable", "Het centrale endpoint is hier niet beschikbaar.");
    }
    return response;
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new CentralMasterError("invalid", "het antwoord is geen geldige JSON.");
    }
  }

  private asInvalid(error: unknown): CentralMasterError {
    if (error instanceof CentralMasterFormatError) return new CentralMasterError("invalid", error.message);
    return new CentralMasterError("invalid", "onbekende fout bij het lezen van het bestand.");
  }
}
