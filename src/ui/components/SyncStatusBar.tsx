import { remoteSyncService } from "../../application/container";
import type { RemoteSyncService } from "../../application/services/RemoteSyncService";
import { useSyncStatus } from "../hooks/useLiveData";

/**
 * Smalle statusbalk onder de header: toont altijd of de telling veilig op de server staat. Zo weet je op elk
 * moment (ook op een gsm) of je het toestel gerust kan sluiten.
 */
export function SyncStatusBar({ service = remoteSyncService }: { service?: RemoteSyncService }) {
  const status = useSyncStatus(service);

  let tone: "ok" | "busy" | "warn";
  let text: string;
  if (status.state === "disabled") {
    tone = "warn";
    text = "Server-opslag staat uit: tellingen staan alleen op dit toestel.";
  } else if (status.state === "error" || status.pending > 0) {
    tone = status.state === "syncing" ? "busy" : "warn";
    text =
      status.state === "syncing"
        ? `Synchroniseren… (${status.pending} wijzigingen)`
        : `Niet opgeslagen op de server${status.pending > 0 ? ` (${status.pending} wijzigingen)` : ""}. Sluit dit toestel nog niet. We proberen het automatisch opnieuw.`;
  } else if (status.state === "syncing") {
    tone = "busy";
    text = "Synchroniseren…";
  } else if (status.lastSyncedAt) {
    tone = "ok";
    text = `Opgeslagen op de server (${new Date(status.lastSyncedAt).toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" })})`;
  } else {
    tone = "busy";
    text = "Verbinden met de server…";
  }

  return (
    <div className={`sync-status sync-status--${tone}`} role="status" aria-live="polite">
      {text}
    </div>
  );
}
