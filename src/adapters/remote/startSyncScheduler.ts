import { onLocalDataChanged } from "../storage/db";
import type { RemoteSyncService } from "../../application/services/RemoteSyncService";

export interface SyncSchedulerOptions {
  /** Periodieke pull/push zolang de pagina zichtbaar is. */
  intervalMs?: number;
  /** Wachttijd na een lokale wijziging, zodat een reeks schrijfacties in één synchronisatie valt. */
  debounceMs?: number;
}

/**
 * Start de automatische synchronisatie: bij opstarten, na elke lokale wijziging (debounced), wanneer het
 * toestel weer online komt, wanneer de pagina weer zichtbaar wordt en periodiek. Waarschuwt bij het sluiten
 * van de pagina zolang er nog niet-gesynchroniseerde wijzigingen zijn. Geeft een stopfunctie terug.
 */
export function startSyncScheduler(service: RemoteSyncService, options: SyncSchedulerOptions = {}): () => void {
  if (service.getStatus().state === "disabled") return () => {};
  const intervalMs = options.intervalMs ?? 15_000;
  const debounceMs = options.debounceMs ?? 2_000;

  const run = () => {
    void service.syncNow();
  };
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const stopListening = onLocalDataChanged(() => {
    clearTimeout(debounce);
    debounce = setTimeout(run, debounceMs);
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") run();
  };
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    const { pending, state } = service.getStatus();
    if (pending > 0 || state === "error") {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  const interval = setInterval(() => {
    if (document.visibilityState === "visible") run();
  }, intervalMs);

  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("beforeunload", onBeforeUnload);
  run();

  return () => {
    clearTimeout(debounce);
    clearInterval(interval);
    stopListening();
    window.removeEventListener("online", run);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
}
