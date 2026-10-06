import { useEffect, useState } from "react";
import { centralHistorySyncService } from "../../application/container";
import { BigButton } from "../components/BigButton";
import { useCentralHistoryStatus } from "../hooks/useLiveData";

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("nl-BE");
}

/**
 * Instellingen → "Centrale historiek": ALLEEN-LEZEN weergave van de status
 * van de centrale historiek (laatste succesvolle sync, discrete waarschuwing)
 * plus het instellen van de toegangscode op dit toestel en een handmatige
 * "Nu synchroniseren". Er is hier bewust geen enkele manier om data naar de
 * centrale bron te PUBLICEREN (dat gebeurt via script/git/Vercel, zie
 * docs/CENTRAL_HISTORY.md).
 */
export function CentralHistorySection({ officeId }: { officeId: string }) {
  const status = useCentralHistoryStatus(officeId);
  const [hasCode, setHasCode] = useState<boolean | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    centralHistorySyncService
      .hasAccessCode()
      .then((value) => {
        if (!cancelled) setHasCode(value);
      })
      .catch(() => {
        if (!cancelled) setHasCode(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runSync = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await centralHistorySyncService.syncOffice(officeId, { force: true });
      if (result.outcome === "synced" && result.message === null) {
        setFeedback(
          result.addedSessionCount > 0
            ? `${result.addedSessionCount} nieuwe telling(en) toegevoegd.`
            : "Alles is al up-to-date.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCode = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      await centralHistorySyncService.saveAccessCode(codeInput);
      setCodeInput("");
      setHasCode(await centralHistorySyncService.hasAccessCode());
    } finally {
      setBusy(false);
    }
    await runSync();
  };

  const handleClearCode = async () => {
    await centralHistorySyncService.clearAccessCode();
    setHasCode(false);
    setFeedback("Toegangscode verwijderd. Reeds gesynchroniseerde tellingen blijven beschikbaar.");
  };

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Centrale historiek</h2>
      <p className="screen-subtitle" style={{ margin: 0 }}>
        Afgeronde historische tellingen worden centraal beheerd en hier enkel gelezen (alleen-lezen). Na
        één geslaagde synchronisatie blijft alles ook offline beschikbaar. Nieuwe tellingen worden niet
        vanuit deze app gepubliceerd.
      </p>

      <div className="stack stack--tight">
        <div>
          <strong>Laatst gesynchroniseerd:</strong> {formatDateTime(status?.lastSuccessAt)}
        </div>
        {status?.lastGeneratedAt && (
          <div className="screen-subtitle" style={{ margin: 0 }}>
            Centrale gegevens van {formatDateTime(status.lastGeneratedAt)}
          </div>
        )}
        {status?.lastError && <div className="warning-banner">{status.lastError}</div>}
        {feedback && <div className="screen-subtitle" style={{ margin: 0 }}>{feedback}</div>}
      </div>

      {hasCode === false && (
        <div className="stack stack--tight">
          <label htmlFor="central-history-code" className="screen-subtitle" style={{ margin: 0 }}>
            Toegangscode (kreeg je van de beheerder)
          </label>
          <input
            id="central-history-code"
            className="search-input"
            type="password"
            autoComplete="off"
            value={codeInput}
            onChange={(event) => setCodeInput(event.target.value)}
          />
          <BigButton variant="primary" disabled={busy || codeInput.trim() === ""} onClick={handleSaveCode}>
            Opslaan en synchroniseren
          </BigButton>
        </div>
      )}

      {hasCode === true && (
        <div className="stack stack--tight">
          <BigButton variant="primary" disabled={busy} onClick={runSync}>
            {busy ? "Bezig met synchroniseren..." : "Nu synchroniseren"}
          </BigButton>
          <BigButton variant="ghost" disabled={busy} onClick={handleClearCode}>
            Toegangscode verwijderen
          </BigButton>
        </div>
      )}
    </div>
  );
}
