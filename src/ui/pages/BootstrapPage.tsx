import { useCallback, useEffect, useState } from "react";
import { centralDataSyncService, countingRepository } from "../../application/container";
import type { CentralOfficeSummary } from "../../domain/centralMasterFile";
import { BigButton } from "../components/BigButton";

interface BootstrapPageProps {
  /** Het kantoor staat nu lokaal (master toegepast, historiek geprobeerd); de app kan normaal openen. */
  onBootstrapped: (officeId: string) => void;
  /** Gebruiker kiest bewust voor de Excel-fallback. */
  onUseExcel: () => void;
  /** Aanwezig vanaf het tweede kantoor: dit is dan geen verplicht startscherm. */
  onCancel?: () => void;
}

type State =
  | { step: "checking" }
  | { step: "choose"; offices: CentralOfficeSummary[]; localOfficeIds: Set<string> }
  | { step: "working"; officeName: string }
  | { step: "error"; message: string; offices: CentralOfficeSummary[] | null; localOfficeIds: Set<string> };

/**
 * Eenmalig startscherm op een nieuw toestel (of bij een nieuw kantoor):
 *
 *   1. kantoor kiezen uit de centrale lijst
 *   2. masterdata ophalen → valideren → lokaal opslaan → historiek ophalen
 *   3. de app opent normaal en werkt daarna lokaal/offline verder
 *
 * Geen toegangscode, login of auth-scherm: de centrale bronnen vragen niets.
 * Een Excelbestand importeren blijft als fallback beschikbaar.
 */
export function BootstrapPage({ onBootstrapped, onUseExcel, onCancel }: BootstrapPageProps) {
  const [state, setState] = useState<State>({ step: "checking" });

  const loadOffices = useCallback(async () => {
    const [result, localOffices] = await Promise.all([
      centralDataSyncService.listOffices(),
      countingRepository.getAllOffices(),
    ]);
    const localOfficeIds = new Set(localOffices.map((o) => o.id));
    if (result.ok) {
      setState({ step: "choose", offices: result.offices, localOfficeIds });
    } else {
      setState({ step: "error", message: result.message, offices: null, localOfficeIds });
    }
  }, []);

  useEffect(() => {
    void loadOffices().catch(() =>
      setState({
        step: "error",
        message: "Centrale gegevens niet bereikbaar — probeer opnieuw of importeer een Excelbestand.",
        offices: null,
        localOfficeIds: new Set(),
      }),
    );
  }, [loadOffices]);

  async function handlePick(office: CentralOfficeSummary, offices: CentralOfficeSummary[], localOfficeIds: Set<string>) {
    setState({ step: "working", officeName: office.name });
    const result = await centralDataSyncService.bootstrapOffice(office.id);
    if (result.ok) {
      onBootstrapped(office.id);
      return;
    }
    setState({
      step: "error",
      message: result.message ?? "Het kantoor kon niet opgehaald worden.",
      offices,
      localOfficeIds,
    });
  }

  const excelButton = (
    <BigButton variant="ghost" onClick={onUseExcel}>
      Liever een Excelbestand importeren
    </BigButton>
  );
  const cancelButton = onCancel ? (
    <BigButton variant="ghost" onClick={onCancel}>
      Annuleren
    </BigButton>
  ) : null;

  if (state.step === "checking") {
    return (
      <div className="stack">
        <h1 className="screen-title">Argona Stocktelling</h1>
        <p className="screen-subtitle">Bezig met laden...</p>
      </div>
    );
  }

  if (state.step === "working") {
    return (
      <div className="stack">
        <h1 className="screen-title">{state.officeName}</h1>
        <p className="screen-subtitle">
          Artikelen, locaties en historiek worden opgehaald. Dit duurt enkele seconden...
        </p>
      </div>
    );
  }

  const offices = state.offices;
  const localOfficeIds = state.localOfficeIds;
  return (
    <div className="stack">
      <h1 className="screen-title">Kies je kantoor</h1>
      {state.step === "error" && <div className="error-banner">{state.message}</div>}
      {state.step === "error" && offices === null && (
        <BigButton variant="primary" onClick={() => void loadOffices()}>
          Opnieuw proberen
        </BigButton>
      )}
      {offices !== null && offices.length === 0 && (
        <p className="empty-state">Er zijn nog geen kantoren centraal gepubliceerd.</p>
      )}
      {offices !== null &&
        offices.map((office) => {
          const already = localOfficeIds.has(office.id);
          return (
            <BigButton
              key={office.id}
              variant="primary"
              onClick={() => void handlePick(office, offices, localOfficeIds)}
            >
              {office.name}
              {already ? " (al op dit toestel — opnieuw ophalen)" : ""}
            </BigButton>
          );
        })}
      {excelButton}
      {cancelButton}
    </div>
  );
}
