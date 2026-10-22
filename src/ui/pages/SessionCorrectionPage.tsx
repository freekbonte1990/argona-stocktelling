import { useMemo, useState } from "react";
import { sessionCorrectionService } from "../../application/container";
import { buildCorrectionExport } from "../../domain/sessionCorrection";
import { BigButton } from "../components/BigButton";
import { useFinalizedSessionResult, useSession } from "../hooks/useLiveData";
import { formatCount, formatDate } from "../../shared/format";

interface SessionCorrectionPageProps {
  sessionId: string;
  onDone: () => void;
}

const MAX_VISIBLE = 100;

/**
 * "Telling corrigeren": wijzig het getelde eindaantal van artikelen in een
 * AFGERONDE telling. De telling blijft bestaan (zelfde naam en datum); enkel de
 * aantallen van de aangepaste artikelen wijzigen. Correcties kunnen daarna
 * geëxporteerd worden om de centrale historiek bij te werken.
 */
export function SessionCorrectionPage({ sessionId, onDone }: SessionCorrectionPageProps) {
  const session = useSession(sessionId);
  const result = useFinalizedSessionResult(sessionId);
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!result) return [];
    const q = search.trim().toLowerCase();
    return result.snapshot.articles
      .filter((a) => a.status === "GETELD" || a.status === "0 BEVESTIGD")
      .filter(
        (a) =>
          q === "" ||
          a.article.articleNumber.toLowerCase().includes(q) ||
          a.article.description.toLowerCase().includes(q),
      );
  }, [result, search]);

  if (!session || !result) return <p>Telling laden…</p>;

  const correctionCount = buildCorrectionExport(session.officeId, result, "").corrections.length;
  const pending = Object.entries(drafts).filter(([, value]) => value.trim() !== "");
  const visible = search.trim() === "" && pending.length === 0 ? rows.slice(0, MAX_VISIBLE) : rows.slice(0, 400);

  async function save() {
    setError(null);
    setMessage(null);
    const inputs = pending.map(([articleId, value]) => ({
      articleId,
      newTotalCount: Number(value.replace(",", ".")),
    }));
    setBusy(true);
    try {
      const outcome = await sessionCorrectionService.correct(sessionId, inputs, reason || null);
      setDrafts({});
      setMessage(
        outcome.records.length === 0
          ? "Geen wijzigingen: de aantallen waren al gelijk."
          : `${outcome.records.length} artikel(s) gecorrigeerd.` +
              (outcome.previousCountUpdated ? " De 'vorige telling' voor de volgende telling is mee bijgewerkt." : ""),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout bij het corrigeren.");
    } finally {
      setBusy(false);
    }
  }

  async function exportCorrections() {
    setError(null);
    try {
      const file = await sessionCorrectionService.exportCorrections(sessionId);
      const blob = new Blob([JSON.stringify(file.content, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout bij het exporteren.");
    }
  }

  return (
    <div className="stack">
      <h1 className="screen-title">Telling corrigeren</h1>
      <p className="screen-subtitle">
        {result.snapshot.sessionName} · {formatDate(result.snapshot.snapshotDate)} — de telling blijft bestaan; enkel het
        getelde aantal van de aangepaste artikelen wijzigt.
      </p>

      <input
        type="search"
        className="input"
        placeholder="Zoek op artikelnummer of omschrijving"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        aria-label="Zoek artikel"
      />

      <ul className="stack" aria-label="Artikelen">
        {visible.map((a) => (
          <li key={a.articleId} className="card">
            <div>
              <strong>{a.article.articleNumber}</strong> — {a.article.description}
            </div>
            <div>
              Geteld: {a.totalCount === null ? "—" : formatCount(a.totalCount)}
              {a.note?.includes("Gecorrigeerd") ? " (gecorrigeerd)" : ""}
            </div>
            <input
              type="text"
              inputMode="decimal"
              className="input"
              placeholder="Nieuw aantal"
              aria-label={`Nieuw aantal voor ${a.article.articleNumber}`}
              value={drafts[a.articleId] ?? ""}
              onChange={(event) => setDrafts((d) => ({ ...d, [a.articleId]: event.target.value }))}
            />
          </li>
        ))}
      </ul>
      {rows.length > visible.length ? <p>Gebruik de zoekbalk om verder te filteren ({rows.length} artikelen).</p> : null}

      <input
        type="text"
        className="input"
        placeholder="Reden (optioneel)"
        aria-label="Reden"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />

      {error ? <p role="alert" className="error-text">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}

      <BigButton disabled={busy || pending.length === 0} onClick={() => void save()}>
        {pending.length === 0 ? "Correcties opslaan" : `Correcties opslaan (${pending.length})`}
      </BigButton>
      <BigButton variant="secondary" disabled={correctionCount === 0} onClick={() => void exportCorrections()}>
        Correcties exporteren{correctionCount > 0 ? ` (${correctionCount})` : ""}
      </BigButton>
      <BigButton variant="ghost" onClick={onDone}>
        Terug naar analyse
      </BigButton>
    </div>
  );
}
