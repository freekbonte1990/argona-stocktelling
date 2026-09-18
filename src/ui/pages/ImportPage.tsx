import { useRef, useState } from "react";
import { importService } from "../../application/container";
import type { ImportPreview, ImportSummary } from "../../application/services/ImportService";
import { BigButton } from "../components/BigButton";
import { SummaryTile } from "../components/SummaryTile";

interface ImportPageProps {
  onImported: (officeId: string) => void;
  /** Terugknop tonen (v.a. het tweede kantoor: dit is dan geen verplicht startscherm meer). */
  onCancel?: () => void;
}

type ImportState =
  | { step: "idle" }
  | { step: "loading" }
  | { step: "error"; message: string }
  | { step: "preview"; preview: ImportPreview }
  | { step: "committing"; preview: ImportPreview }
  | { step: "done"; summary: ImportSummary };

export function ImportPage({ onImported, onCancel }: ImportPageProps) {
  const [state, setState] = useState<ImportState>({ step: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setState({ step: "loading" });
    try {
      // Dynamische import: de xlsx-parser (en de xlsx-library, relatief zwaar)
      // wordt pas geladen op het moment dat er echt geïmporteerd wordt, niet
      // als onderdeel van de hoofdbundel van de app.
      const { createExcelStockSourceFromFile } = await import(
        "../../adapters/excel/ExcelStockSource"
      );
      const source = await createExcelStockSourceFromFile(file);
      const preview = await importService.prepareImport(source);
      setState({ step: "preview", preview });
    } catch (error) {
      setState({
        step: "error",
        message: error instanceof Error ? error.message : "Onbekende fout bij het importeren.",
      });
    }
  }

  async function handleCommit(preview: ImportPreview) {
    setState({ step: "committing", preview });
    try {
      const summary = await importService.commitImport(preview);
      setState({ step: "done", summary });
    } catch (error) {
      setState({
        step: "error",
        message: error instanceof Error ? error.message : "Onbekende fout bij het importeren.",
      });
    }
  }

  if (state.step === "preview" || state.step === "committing") {
    const { preview } = state;
    const b = preview.breakdown;
    const isCommitting = state.step === "committing";
    return (
      <div className="stack">
        <h1 className="screen-title">{preview.office.name}</h1>
        <p className="screen-subtitle">
          {preview.totalArticles.toLocaleString("nl-BE")} artikelen gevonden
        </p>
        <div className="summary-grid">
          <SummaryTile label="Maand" value={b.monthly} />
          <SummaryTile label="Kwartaal" value={b.quarterly} />
          <SummaryTile label="Jaar" value={b.yearly} />
          <SummaryTile label="NVT" value={b.notApplicable} />
          <SummaryTile label="Nog te bepalen" value={b.toBeDetermined} />
        </div>
        {b.toBeDetermined > 0 && (
          <div className="warning-banner">
            {b.toBeDetermined} artikel(en) hebben nog geen telfrequentie ("nog te bepalen"). Ze
            komen niet automatisch in een maand-, kwartaal- of jaartelling terecht — enkel bij een
            volledige telling. Bekijk deze artikelen later even na.
          </div>
        )}
        {preview.existing && (
          <div className="warning-banner">
            Er bestaat al een kantoor "{preview.existing.office.name}" met{" "}
            {preview.existing.articleCount.toLocaleString("nl-BE")} artikelen
            {preview.existing.importedAt
              ? `, laatst geïmporteerd op ${new Date(preview.existing.importedAt).toLocaleDateString("nl-BE")}`
              : ""}
            .{" "}
            {preview.existing.hasActiveSession &&
              "Er loopt momenteel nog een actieve telling voor dit kantoor. "}
            Verdergaan vervangt de artikelgegevens van dit kantoor met dit bestand. Locatienamen en
            lopende tellingen blijven behouden.
          </div>
        )}
        <div className="stack">
          {preview.existing ? (
            <>
              <BigButton
                variant="primary"
                disabled={isCommitting}
                onClick={() => handleCommit(preview)}
              >
                {isCommitting ? "Bezig met vervangen..." : "Vervangen en importeren"}
              </BigButton>
              <BigButton variant="ghost" disabled={isCommitting} onClick={() => setState({ step: "idle" })}>
                Annuleren
              </BigButton>
            </>
          ) : (
            <BigButton disabled={isCommitting} onClick={() => handleCommit(preview)}>
              {isCommitting ? "Bezig met importeren..." : "Doorgaan"}
            </BigButton>
          )}
        </div>
      </div>
    );
  }

  if (state.step === "done") {
    const { summary } = state;
    return (
      <div className="stack">
        <h1 className="screen-title">{summary.office.name}</h1>
        <p className="screen-subtitle">
          {summary.totalArticles.toLocaleString("nl-BE")} artikelen geïmporteerd
        </p>
        <BigButton onClick={() => onImported(summary.office.id)}>Verder</BigButton>
      </div>
    );
  }

  return (
    <div className="stack">
      <h1 className="screen-title">Argona Stocktelling</h1>
      <p className="screen-subtitle">Importeer eerst het gestandaardiseerde Excelbestand van je kantoor.</p>
      {state.step === "error" && <div className="error-banner">{state.message}</div>}
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
      <BigButton onClick={() => inputRef.current?.click()} disabled={state.step === "loading"}>
        {state.step === "loading" ? "Bezig met inlezen..." : "Excel importeren"}
      </BigButton>
      {onCancel && (
        <BigButton variant="ghost" onClick={onCancel}>
          Annuleren
        </BigButton>
      )}
    </div>
  );
}

