import { useRef, useState, type ReactNode } from "react";
import type { LegacyImportPreview, LegacyStockRow } from "../../domain/legacyImport";
import { legacyImportService } from "../../application/container";
import { formatEuro } from "../../shared/format";
import { BigButton } from "../components/BigButton";

/**
 * Sprint 3.3 §3: minimale UI voor de pragmatische legacy-historiekimport —
 * spec-vereiste "preview/report vóór toepassen". BEWUST twee losse, expliciet
 * benoemde knoppen i.p.v. één generieke "importeer historisch bestand"-flow:
 * `parseLegacyStockLokeren`/`parseLegacyStockDamme` zijn zelf al bewust
 * bestandsspecifieke, niet-generieke parsers (zie
 * `adapters/excel/parseLegacyStock.ts`s eigen documentatie — de twee bron-
 * bestanden zijn te verschillend gestructureerd voor één parser), dus doet
 * deze sectie hetzelfde: ze toont enkel de knop die bij DIT kantoor hoort.
 *
 * Bewust een ÉÉNMALIGE (maar herhaalbare — zie idempotentie in
 * `LegacyImportService`) migratieactie, geen permanente/generieke
 * "historisch bestand importeren"-functie voor eender welk kantoor — vandaar
 * hier, als een aparte kaart in Instellingen, i.p.v. een eigen route/scherm.
 */

type LegacyOfficeKind = "lokeren" | "damme";

/**
 * Sprint 3.3 §3: welke kantoren een bespoke legacy-parser hebben, en met
 * welk bronbestand/label. Best-effort aanname (nog te bevestigen tegen de
 * echte productie-DB, zie het item-10-rapport): `officeId = slugify(naam)`,
 * dus "Lokeren" -> "lokeren", "Damme" -> "damme".
 */
const LEGACY_OFFICE_LABELS: Record<LegacyOfficeKind, { title: string; fileHint: string }> = {
  lokeren: { title: "Lokeren-historiek (TGOVL)", fileHint: "bv. \"TGOVL - Stock ... - Telfrequentie.xlsx\"" },
  damme: { title: "Damme-historiek (TGWVL)", fileHint: "bv. \"TGWVL - Stock ... - Telfrequentie.xlsx\"" },
};

function resolveLegacyOfficeKind(officeId: string): LegacyOfficeKind | null {
  if (officeId === "lokeren" || officeId === "damme") return officeId;
  return null;
}

type LegacyImportState =
  | { step: "idle" }
  | { step: "loading" }
  | { step: "error"; message: string }
  | { step: "preview"; preview: LegacyImportPreview; rows: LegacyStockRow[] }
  | { step: "committing"; preview: LegacyImportPreview; rows: LegacyStockRow[] }
  | { step: "done"; preview: LegacyImportPreview; newArticleCount: number; historyEntryCount: number };

interface LegacyImportSectionProps {
  officeId: string;
}

export function LegacyImportSection({ officeId }: LegacyImportSectionProps) {
  const officeKind = resolveLegacyOfficeKind(officeId);
  const [state, setState] = useState<LegacyImportState>({ step: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  // Geen bespoke parser voor dit kantoor — deze kaart toont hier bewust
  // niets (geen generieke fallback, spec: "geen fuzzy/verzonnen gedrag").
  if (!officeKind) return null;
  const labels = LEGACY_OFFICE_LABELS[officeKind];

  async function handleFile(file: File) {
    setState({ step: "loading" });
    try {
      const buffer = await file.arrayBuffer();
      // Dynamische import, zelfde precedent als ImportPage: de xlsx-library
      // wordt pas geladen op het moment dat er écht geïmporteerd wordt.
      const { parseLegacyStockLokeren, parseLegacyStockDamme } = await import(
        "../../adapters/excel/parseLegacyStock"
      );
      const rows =
        officeKind === "lokeren"
          ? parseLegacyStockLokeren(buffer, file.name)
          : parseLegacyStockDamme(buffer, file.name);
      const preview = await legacyImportService.preview(officeId, rows);
      setState({ step: "preview", preview, rows });
    } catch (error) {
      setState({
        step: "error",
        message: error instanceof Error ? error.message : "Onbekende fout bij het inlezen van het bestand.",
      });
    }
  }

  async function handleCommit(preview: LegacyImportPreview, rows: LegacyStockRow[]) {
    setState({ step: "committing", preview, rows });
    try {
      const result = await legacyImportService.commit(officeId, rows);
      setState({
        step: "done",
        preview: result.preview,
        newArticleCount: result.newArticleCount,
        historyEntryCount: result.historyEntryCount,
      });
    } catch (error) {
      setState({
        step: "error",
        message: error instanceof Error ? error.message : "Onbekende fout bij het toepassen van de import.",
      });
    }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Historische stockimport (legacy) — {labels.title}</h2>
      <p className="screen-subtitle" style={{ margin: 0 }}>
        Eenmalige (maar veilig herhaalbare) import van het historische stockbestand van vóór deze app.
        Oude artikelen die niet meer in het huidige assortiment staan, blijven zichtbaar in de historiek
        van dit kantoor, maar worden nooit actief in een nieuwe telling. Een herhaalde import van hetzelfde
        bestand overschrijft gewoon dezelfde regels — er ontstaan nooit duplicaten.
      </p>

      {state.step === "error" && <div className="error-banner">{state.message}</div>}

      {(state.step === "idle" || state.step === "loading" || state.step === "error") && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = "";
            }}
          />
          <BigButton
            variant="secondary"
            style={{ width: "auto" }}
            disabled={state.step === "loading"}
            onClick={() => inputRef.current?.click()}
          >
            {state.step === "loading" ? "Bezig met inlezen..." : `Bestand kiezen (${labels.fileHint})`}
          </BigButton>
        </>
      )}

      {(state.step === "preview" || state.step === "committing") && (
        <LegacyPreviewReport
          preview={state.preview}
          footer={
            <div className="stack stack--tight stack--row">
              <BigButton
                variant="primary"
                style={{ width: "auto" }}
                disabled={state.step === "committing"}
                onClick={() => handleCommit(state.preview, state.rows)}
              >
                {state.step === "committing" ? "Bezig met toepassen..." : "Toepassen"}
              </BigButton>
              <BigButton
                variant="ghost"
                style={{ width: "auto" }}
                disabled={state.step === "committing"}
                onClick={() => setState({ step: "idle" })}
              >
                Annuleren
              </BigButton>
            </div>
          }
        />
      )}

      {state.step === "done" && (
        <div className="stack">
          <div className="warning-banner">
            Toegepast: {state.newArticleCount} nieuw historisch/inactief artikel(en) aangemaakt,{" "}
            {state.historyEntryCount} HISTORIE-regel(s) bewaard.
          </div>
          <LegacyPreviewReport preview={state.preview} />
          <BigButton variant="ghost" style={{ width: "auto" }} onClick={() => setState({ step: "idle" })}>
            Nog een bestand importeren
          </BigButton>
        </div>
      )}
    </div>
  );
}

function LegacyPreviewReport({
  preview,
  footer,
}: {
  preview: LegacyImportPreview;
  footer?: ReactNode;
}) {
  return (
    <div className="stack">
      <p className="screen-subtitle" style={{ margin: 0 }}>
        "Gematcht"/"Onopgelost" hieronder tellen per matching-methode (op artikelnummer of op omschrijving) — zie
        de exacte rijreconciliatie verderop voor wat er per rij werkelijk mee gebeurt.
      </p>
      <div className="summary-grid">
        <div className="card stack stack--tight">
          <span className="screen-subtitle" style={{ margin: 0 }}>
            Totaal rijen
          </span>
          <strong>{preview.totalRows.toLocaleString("nl-BE")}</strong>
        </div>
        <div className="card stack stack--tight">
          <span className="screen-subtitle" style={{ margin: 0 }}>
            Gematcht (methode)
          </span>
          <strong>{preview.totalMatched.toLocaleString("nl-BE")}</strong>
        </div>
        <div className="card stack stack--tight">
          <span className="screen-subtitle" style={{ margin: 0 }}>
            Onopgelost (methode)
          </span>
          <strong>{preview.totalUnresolved.toLocaleString("nl-BE")}</strong>
        </div>
        <div className="card stack stack--tight">
          <span className="screen-subtitle" style={{ margin: 0 }}>
            Oorspronkelijke stockwaarde
          </span>
          <strong>{formatEuro(preview.totalOriginalStockValue)}</strong>
        </div>
      </div>

      <div className="stack stack--tight">
        <strong>Exacte rijreconciliatie</strong>
        <p className="screen-subtitle" style={{ margin: 0 }}>
          Elke brondata-rij eindigt in exact één van deze drie uitkomsten — hun som is altijd gelijk aan het
          totaal aantal rijen hierboven, er verdwijnt nooit een rij stilzwijgend.
        </p>
        <div className="summary-grid">
          <div className="card stack stack--tight">
            <span className="screen-subtitle" style={{ margin: 0 }}>
              Gematcht op bestaand artikel
            </span>
            <strong>{preview.totalMatchedExistingArticle.toLocaleString("nl-BE")}</strong>
          </div>
          <div className="card stack stack--tight">
            <span className="screen-subtitle" style={{ margin: 0 }}>
              Nieuw historisch artikel
            </span>
            <strong>{preview.totalNewHistoricalArticleRows.toLocaleString("nl-BE")}</strong>
          </div>
          <div className="card stack stack--tight">
            <span className="screen-subtitle" style={{ margin: 0 }}>
              Expliciet overgeslagen (met reden)
            </span>
            <strong>{preview.totalRejectedRows.toLocaleString("nl-BE")}</strong>
          </div>
          <div className="card stack stack--tight">
            <span className="screen-subtitle" style={{ margin: 0 }}>
              Som (moet = totaal rijen)
            </span>
            <strong>
              {(
                preview.totalMatchedExistingArticle +
                preview.totalNewHistoricalArticleRows +
                preview.totalRejectedRows
              ).toLocaleString("nl-BE")}
            </strong>
          </div>
        </div>
      </div>

      {preview.rejectedRows.length > 0 && (
        <div className="warning-banner">
          {preview.rejectedRows.length} rij(en) expliciet overgeslagen — bv. "{preview.rejectedRows[0].description}"
          ({preview.rejectedRows[0].reason}).
        </div>
      )}

      <div className="stack stack--tight">
        <strong>Periodes ({preview.periods.length})</strong>
        {preview.periods.map((period) => (
          <div key={period.periodKey} className="card stack stack--tight location-settings-row">
            <div className="stack stack--tight stack--row">
              <span className="location-settings-row__name">{period.periodLabel}</span>
              <span className="screen-subtitle" style={{ margin: 0 }}>
                {period.rowCount.toLocaleString("nl-BE")} rijen · {period.matchedExistingArticleCount} bestaand ·{" "}
                {period.newHistoricalArticleRowCount} nieuw historisch · {period.rejectedRowCount} overgeslagen ·{" "}
                {formatEuro(period.totalOriginalStockValue)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {preview.anomalies.length > 0 && (
        <div className="warning-banner">
          {preview.anomalies.length} anomalie(ën) gevonden (bv. ontbrekende hoeveelheid/kostprijs) — deze
          rijen worden WEL geïmporteerd (nooit geblokkeerd), maar verdienen later een blik. Voorbeeld:{" "}
          "{preview.anomalies[0].description}" ({preview.anomalies[0].reason}).
        </div>
      )}

      {preview.duplicateRowCount > 0 && (
        <div className="warning-banner">
          {preview.duplicateRowCount} brondata-rij(en) verwijzen, binnen dezelfde periode, naar hetzelfde
          artikel als een eerdere rij (bv. hetzelfde artikelnummer twee keer in dezelfde sheet). Voor zo'n
          duplicaat wordt enkel de LAATSTE rij bewaard — geen crash, maar wel iets om na te kijken in het
          bronbestand.
        </div>
      )}

      {footer}
    </div>
  );
}
