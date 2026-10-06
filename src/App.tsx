import { useEffect, useState } from "react";
import { AppHeader } from "./ui/components/AppHeader";
import { ImportPage } from "./ui/pages/ImportPage";
import { BootstrapPage } from "./ui/pages/BootstrapPage";
import { HomePage } from "./ui/pages/HomePage";
import { NewSessionPage } from "./ui/pages/NewSessionPage";
import { LocationOverviewPage } from "./ui/pages/LocationOverviewPage";
import { WithoutLocationPage } from "./ui/pages/WithoutLocationPage";
import { CountingPage } from "./ui/pages/CountingPage";
import { ReviewPage } from "./ui/pages/ReviewPage";
import { AnalysisPage } from "./ui/pages/AnalysisPage";
import { ComparisonPage } from "./ui/pages/ComparisonPage";
import { LegacySnapshotPage } from "./ui/pages/LegacySnapshotPage";
import { isLegacySnapshotId } from "./domain/legacySnapshotView";
import { ArticlesPage } from "./ui/pages/ArticlesPage";
import { ArticleDetailPage } from "./ui/pages/ArticleDetailPage";
import { SettingsPage } from "./ui/pages/SettingsPage";
import { useOffice, useSession } from "./ui/hooks/useLiveData";
import { centralDataSyncService, countSessionService, countingRepository } from "./application/container";

type Route =
  | { screen: "bootstrap"; fromOfficeId?: string }
  | { screen: "import"; fromOfficeId?: string; fromBootstrap?: boolean }
  | { screen: "home"; officeId: string }
  | { screen: "newSession"; officeId: string }
  | { screen: "locationOverview"; sessionId: string }
  | { screen: "withoutLocation"; sessionId: string }
  | { screen: "counting"; sessionId: string; locationId: string; focusArticleId?: string }
  | { screen: "review"; sessionId: string }
  | { screen: "analysis"; sessionId: string }
  | { screen: "comparison"; sessionId: string; officeId?: string }
  | { screen: "legacySnapshot"; officeId: string; snapshotId: string }
  | { screen: "articles"; officeId: string }
  | { screen: "articleDetail"; officeId: string; articleId: string }
  | { screen: "settings"; officeId: string };

/**
 * v0.3-hotfix (blokkerende bug, gemeld tijdens mobiel testen): de route leefde
 * tot nu toe UITSLUITEND in React-state (`useState`), nergens bewaard. Op een
 * telefoon wordt een achtergrondtab regelmatig door het besturingssysteem
 * herladen (geheugendruk, schermvergrendeling, app-wissel) — de JS-context
 * start dan volledig opnieuw, `route` valt terug op `null`, en de
 * initialisatie-effect hieronder stuurde je dan altijd terug naar "Home",
 * ongeacht waar je was ("terug naar het hoofdmenu" — exact het gemelde
 * gedrag, en verklaart ook de "locatie verspringt"-indruk: je moet na zo'n
 * herlaad handmatig opnieuw naar de juiste locatie navigeren).
 *
 * FIX: bij elke routewijziging bewaren we de route (puur een UI-
 * comfortfunctie, geen businessdata); bij het opstarten proberen we die
 * eerst te herstellen — ALTIJD gevalideerd tegen de immutabele
 * `location.id`/`sessionId`/`officeId` (nooit `location.number`, index of
 * sorteervolgorde), en enkel als de onderliggende data nog echt bestaat.
 * Bestaat ze niet meer (bv. een oude/kapotte route), dan valt alles terug op
 * de bestaande "Home"-afleiding hieronder — nooit een crash of blanco scherm.
 *
 * Aanvulling ("bij opstart wil ik dit menu [Home], nu opent hij precies
 * altijd het laatst geopende venster"): bewust `sessionStorage` in plaats van
 * `localStorage`. `sessionStorage` hoort bij de browsing-sessie (het tabblad/
 * de app-instantie) en overleeft dus nog steeds precies het scenario waar
 * deze hotfix voor gebouwd is — een door het OS geherladen ACHTERGRONDtab,
 * want dat blijft dezelfde sessie — maar wordt, anders dan `localStorage`,
 * geleegd zodra je de app/het tabblad écht sluit en opnieuw opent. Een
 * bewuste herstart van de app landt daardoor weer op Home, zoals gevraagd,
 * zonder de mobiele achtergrond-herlaad-fix hierboven ongedaan te maken.
 */
const ROUTE_STORAGE_KEY = "argona-stocktelling:lastRoute";

function loadPersistedRoute(): Route | null {
  try {
    const raw = sessionStorage.getItem(ROUTE_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Route;
  } catch {
    return null;
  }
}

function savePersistedRoute(route: Route | null) {
  try {
    if (route) {
      sessionStorage.setItem(ROUTE_STORAGE_KEY, JSON.stringify(route));
    } else {
      sessionStorage.removeItem(ROUTE_STORAGE_KEY);
    }
  } catch {
    // Privénavigatie / volle opslagquota op mobiel — routeherstel is puur
    // comfort, nooit een reden om de app te laten crashen.
  }
}

/**
 * Bevestigt dat een bewaarde route nog naar bestaande data wijst, aan de
 * hand van de immutabele id's (nooit `location.number`/index/volgorde).
 * Een locatie die intussen inactief is gemaakt telt nog als geldig (zie
 * CountingPage: dat blokkeert tellen niet), enkel een écht verdwenen
 * kantoor/sessie/locatie-id maakt de route ongeldig.
 */
async function isPersistedRouteStillValid(route: Route): Promise<boolean> {
  switch (route.screen) {
    case "bootstrap":
    case "import":
      if (!route.fromOfficeId) return true;
      return !!(await countingRepository.getOffice(route.fromOfficeId));
    case "home":
    case "newSession":
    case "articles":
    case "articleDetail":
    case "settings":
      return !!(await countingRepository.getOffice(route.officeId));
    case "legacySnapshot":
      return !!(await countingRepository.getOffice(route.officeId));
    case "comparison":
      if (route.officeId && isLegacySnapshotId(route.sessionId)) {
        return !!(await countingRepository.getOffice(route.officeId));
      }
      return !!(await countingRepository.getSession(route.sessionId));
    case "locationOverview":
    case "withoutLocation":
    case "review":
    case "analysis":
      return !!(await countingRepository.getSession(route.sessionId));
    case "counting": {
      const session = await countingRepository.getSession(route.sessionId);
      if (!session) return false;
      const office = await countingRepository.getOffice(session.officeId);
      return !!office?.locations.some((l) => l.id === route.locationId);
    }
  }
}

export default function App() {
  const [route, setRoute] = useState<Route | null>(null);

  // Bepaal het startscherm zodra we weten of er al een kantoor geïmporteerd is.
  // Dit is ook hoe "app sluiten en heropenen" werkt: er is geen aparte
  // navigatiestatus bewaard (afgezien van de route-herstel-cache
  // hierboven), alles wordt afgeleid uit wat in IndexedDB staat (incl. welk
  // kantoor laatst geselecteerd was — multi-kantoor).
  //
  // Let op: dit gebruikt bewust eenmalige async calls naar
  // countingRepository (getAllOffices/getSelectedOfficeId) in plaats van een
  // reactieve live-query hook. `useAllOffices()` geeft synchroon een lege
  // array terug ZOLANG de query nog niet is opgelost — niet van "er zijn
  // écht nul kantoren" te onderscheiden. Op een bestaande installatie kon
  // die tijdelijke lege array deze beslissing daardoor onterecht en
  // ONOMKEERBAAR naar het importscherm sturen (route wordt niet-null, dus
  // dit effect loopt daarna nooit meer opnieuw) — precies het soort
  // "onverwacht wegnavigeren" waar deze hotfix voor bedoeld is. Een Promise
  // heeft dat probleem niet: die resolvet ondubbelzinnig, pas als de data er
  // echt is.
  useEffect(() => {
    if (route !== null) return;
    let cancelled = false;
    (async () => {
      // v0.3-hotfix: eerst proberen de laatst bewaarde route te herstellen
      // (bv. na een mobiele achtergrond-herlaad) — enkel als die nog
      // geldig blijkt (zie isPersistedRouteStillValid hierboven).
      const persisted = loadPersistedRoute();
      if (persisted) {
        const stillValid = await isPersistedRouteStillValid(persisted);
        if (cancelled) return;
        if (stillValid) {
          setRoute(persisted);
          return;
        }
        savePersistedRoute(null);
      }
      const offices = await countingRepository.getAllOffices();
      if (cancelled) return;
      if (offices.length === 0) {
        // Nieuw toestel: eerst het eenmalige bootstrap-scherm (code → kantoor → master → historiek);
        // de Excel-import blijft daar als fallback bereikbaar.
        setRoute({ screen: "bootstrap" });
        return;
      }
      const selectedOfficeId = await countingRepository.getSelectedOfficeId();
      if (cancelled) return;
      const preferredOffice = offices.find((o) => o.id === selectedOfficeId) ?? offices[0];
      setRoute({ screen: "home", officeId: preferredOffice.id });
    })();
    return () => {
      cancelled = true;
    };
  }, [route]);

  // Centrale sync (masterdata → historiek → "Vorige telling"): bij het openen van
  // de app en bij elke terugkeer naar Home / kantoorwissel STIL en op de
  // achtergrond. Fire-and-forget: `syncOffice` gooit nooit, wacht nooit op de UI
  // en blokkeert dus nooit het tellen — offline of bij een fout blijft gewoon alle
  // lokale data beschikbaar. Tijdens een actieve telling wordt een nieuwe master
  // wel opgehaald maar pas toegepast ná die telling (zie CentralMasterSyncService).
  // Zie docs/CENTRAL_MASTER.md en docs/CENTRAL_HISTORY.md.
  const homeOfficeId = route?.screen === "home" ? route.officeId : null;
  useEffect(() => {
    if (!homeOfficeId) return;
    void centralDataSyncService.syncOffice(homeOfficeId);
  }, [homeOfficeId]);

  // v0.3-hotfix: elke navigatie meteen bewaren, zodat een onverwachte
  // herlaad (zie hierboven) je exact terugbrengt naar dezelfde route.
  useEffect(() => {
    if (route) savePersistedRoute(route);
  }, [route]);

  if (!route) {
    return <div className="app-shell" />;
  }

  return (
    <div className="app-shell">
      <RouteHeader route={route} onNavigate={setRoute} />
      <main className="app-main">
        <RouteBody route={route} onNavigate={setRoute} />
      </main>
    </div>
  );
}

function RouteHeader({
  route,
  onNavigate,
}: {
  route: Route;
  onNavigate: (route: Route) => void;
}) {
  const directOfficeId =
    route.screen === "home" ||
    route.screen === "newSession" ||
    route.screen === "articles" ||
    route.screen === "articleDetail" ||
    route.screen === "settings" ||
    route.screen === "legacySnapshot"
      ? route.officeId
      : route.screen === "comparison"
        ? route.officeId
        : undefined;
  const office = useOffice(directOfficeId);
  const session = useSession(
    route.screen === "locationOverview" ||
      route.screen === "withoutLocation" ||
      route.screen === "counting" ||
      route.screen === "review" ||
      route.screen === "analysis" ||
      route.screen === "comparison"
      ? route.sessionId
      : undefined,
  );
  const sessionOffice = useOffice(session?.officeId);

  if (route.screen === "bootstrap") {
    if (!route.fromOfficeId) return null;
    return (
      <AppHeader
        breadcrumb="Kantoor toevoegen"
        onBack={() => onNavigate({ screen: "home", officeId: route.fromOfficeId as string })}
      />
    );
  }
  if (route.screen === "import") {
    if (route.fromBootstrap) {
      return (
        <AppHeader
          breadcrumb="Excel importeren"
          onBack={() => onNavigate({ screen: "bootstrap", fromOfficeId: route.fromOfficeId })}
        />
      );
    }
    if (!route.fromOfficeId) return null;
    return (
      <AppHeader
        breadcrumb="Excel importeren"
        onBack={() => onNavigate({ screen: "home", officeId: route.fromOfficeId as string })}
      />
    );
  }
  if (route.screen === "home") {
    return <AppHeader breadcrumb="Argona Stocktelling" subtitle={office?.name} />;
  }
  if (route.screen === "newSession") {
    return (
      <AppHeader
        breadcrumb="Nieuwe telling"
        subtitle={office?.name}
        onBack={() => onNavigate({ screen: "home", officeId: route.officeId })}
      />
    );
  }
  if (route.screen === "articles") {
    return (
      <AppHeader
        breadcrumb="Artikels"
        subtitle={office?.name}
        onBack={() => onNavigate({ screen: "home", officeId: route.officeId })}
      />
    );
  }
  if (route.screen === "articleDetail") {
    return (
      <AppHeader
        breadcrumb="Artikeldetail"
        subtitle={office?.name}
        onBack={() => onNavigate({ screen: "articles", officeId: route.officeId })}
      />
    );
  }
  if (route.screen === "settings") {
    return (
      <AppHeader
        breadcrumb="Instellingen"
        subtitle={office?.name}
        onBack={() => onNavigate({ screen: "home", officeId: route.officeId })}
      />
    );
  }
  if (route.screen === "locationOverview") {
    return (
      <AppHeader
        breadcrumb={sessionOffice?.name ?? ""}
        onBack={() =>
          sessionOffice && onNavigate({ screen: "home", officeId: sessionOffice.id })
        }
      />
    );
  }
  if (route.screen === "withoutLocation") {
    return (
      <AppHeader
        breadcrumb={`${sessionOffice?.name ?? ""} > Zonder locatie`}
        onBack={() => onNavigate({ screen: "locationOverview", sessionId: route.sessionId })}
      />
    );
  }
  if (route.screen === "review") {
    return (
      <AppHeader
        breadcrumb={`${sessionOffice?.name ?? ""} — controle`}
        onBack={() => {
          if (!session) return;
          if (session.status === "ACTIVE") {
            onNavigate({ screen: "locationOverview", sessionId: route.sessionId });
          } else {
            onNavigate({ screen: "home", officeId: session.officeId });
          }
        }}
      />
    );
  }
  if (route.screen === "analysis") {
    return (
      <AppHeader
        breadcrumb={`${sessionOffice?.name ?? ""} — analyse telling`}
        onBack={() => {
          if (!session) return;
          onNavigate({ screen: "home", officeId: session.officeId });
        }}
      />
    );
  }
  if (route.screen === "legacySnapshot") {
    return (
      <AppHeader
        breadcrumb={`${office?.name ?? ""} — historische snapshot`}
        onBack={() => onNavigate({ screen: "home", officeId: route.officeId })}
      />
    );
  }
  if (route.screen === "comparison") {
    return (
      <AppHeader
        breadcrumb={`${(route.officeId ? office : sessionOffice)?.name ?? ""} — vergelijking tellingen`}
        onBack={() => {
          const officeId = route.officeId ?? session?.officeId;
          if (!officeId) return;
          onNavigate({ screen: "home", officeId });
        }}
      />
    );
  }
  // counting
  // Mobile/tablet UX-fix: CountingPage toonde voorheen ZELF ook nog een
  // eigen "<kantoor> > <locatie>"-titel (dubbele weergave) — dat is er nu
  // uit; deze ene, compacte globale header toont de locatienaam als
  // primaire breadcrumb en het kantoor subtiel eronder als `subtitle`.
  const location = sessionOffice?.locations.find((l) => l.id === route.locationId);
  return (
    <AppHeader
      breadcrumb={location?.name ?? ""}
      subtitle={sessionOffice?.name}
      onBack={() => onNavigate({ screen: "locationOverview", sessionId: route.sessionId })}
    />
  );
}

function RouteBody({
  route,
  onNavigate,
}: {
  route: Route;
  onNavigate: (route: Route) => void;
}) {
  switch (route.screen) {
    case "bootstrap":
      return (
        <BootstrapPage
          onBootstrapped={(officeId) => onNavigate({ screen: "home", officeId })}
          onUseExcel={() => onNavigate({ screen: "import", fromOfficeId: route.fromOfficeId, fromBootstrap: true })}
          onCancel={
            route.fromOfficeId
              ? () => onNavigate({ screen: "home", officeId: route.fromOfficeId as string })
              : undefined
          }
        />
      );
    case "import":
      return (
        <ImportPage
          onImported={(officeId) => onNavigate({ screen: "home", officeId })}
          onCancel={
            route.fromBootstrap
              ? () => onNavigate({ screen: "bootstrap", fromOfficeId: route.fromOfficeId })
              : route.fromOfficeId
                ? () => onNavigate({ screen: "home", officeId: route.fromOfficeId as string })
                : undefined
          }
        />
      );
    case "home":
      return (
        <HomePage
          officeId={route.officeId}
          onStartNewSession={() => onNavigate({ screen: "newSession", officeId: route.officeId })}
          onResumeSession={async () => {
            const session = await countSessionService.getActiveSession(route.officeId);
            if (session) onNavigate({ screen: "locationOverview", sessionId: session.id });
          }}
          onOpenArticles={() => onNavigate({ screen: "articles", officeId: route.officeId })}
          onOpenSettings={() => onNavigate({ screen: "settings", officeId: route.officeId })}
          onSwitchOffice={async (officeId) => {
            await countingRepository.setSelectedOfficeId(officeId);
            onNavigate({ screen: "home", officeId });
          }}
          onLoadCentralOffice={async (officeId) => {
            const result = await centralDataSyncService.bootstrapOffice(officeId);
            if (!result.ok) return result.message ?? "Kantoor kon niet geladen worden.";
            onNavigate({ screen: "home", officeId });
            return null;
          }}
          onOpenReview={(sessionId) => onNavigate({ screen: "analysis", sessionId })}
          onOpenLegacySnapshot={(snapshotId) =>
            onNavigate({ screen: "legacySnapshot", officeId: route.officeId, snapshotId })
          }
          onCancelSession={(sessionId) => countSessionService.cancelSession(sessionId)}
        />
      );
    case "newSession":
      return (
        <NewSessionPage
          officeId={route.officeId}
          onStarted={(sessionId) => onNavigate({ screen: "locationOverview", sessionId })}
        />
      );
    case "locationOverview":
      return (
        <LocationOverviewPage
          sessionId={route.sessionId}
          onOpenLocation={(locationId) =>
            onNavigate({ screen: "counting", sessionId: route.sessionId, locationId })
          }
          onOpenReview={() => onNavigate({ screen: "review", sessionId: route.sessionId })}
          onOpenWithoutLocation={() => onNavigate({ screen: "withoutLocation", sessionId: route.sessionId })}
        />
      );
    case "withoutLocation":
      return (
        <WithoutLocationPage
          sessionId={route.sessionId}
          onOpenArticle={(officeId, articleId) => onNavigate({ screen: "articleDetail", officeId, articleId })}
        />
      );
    case "counting":
      return (
        <CountingPage
          sessionId={route.sessionId}
          locationId={route.locationId}
          focusArticleId={route.focusArticleId}
        />
      );
    case "review":
      return (
        <ReviewPage
          sessionId={route.sessionId}
          onRecount={(locationId, articleId) =>
            onNavigate({ screen: "counting", sessionId: route.sessionId, locationId, focusArticleId: articleId })
          }
          onCompleted={async () => {
            const session = await countingRepository.getSession(route.sessionId);
            if (session) onNavigate({ screen: "home", officeId: session.officeId });
          }}
          onOpenLocationOverview={() => onNavigate({ screen: "locationOverview", sessionId: route.sessionId })}
          onOpenLocation={(locationId) =>
            onNavigate({ screen: "counting", sessionId: route.sessionId, locationId })
          }
        />
      );
    case "analysis":
      return (
        <AnalysisPage
          sessionId={route.sessionId}
          onOpenArticle={async (articleId) => {
            const session = await countingRepository.getSession(route.sessionId);
            if (session) onNavigate({ screen: "articleDetail", officeId: session.officeId, articleId });
          }}
          onOpenComparison={(sessionId) => onNavigate({ screen: "comparison", sessionId })}
        />
      );
    case "legacySnapshot":
      return (
        <LegacySnapshotPage
          officeId={route.officeId}
          snapshotId={route.snapshotId}
          onOpenComparison={(snapshotId) =>
            onNavigate({ screen: "comparison", sessionId: snapshotId, officeId: route.officeId })
          }
        />
      );
    case "comparison":
      return (
        <ComparisonPage
          sessionId={route.sessionId}
          officeId={route.officeId}
          onOpenArticle={async (articleId) => {
            const officeId = route.officeId ?? (await countingRepository.getSession(route.sessionId))?.officeId;
            if (officeId) onNavigate({ screen: "articleDetail", officeId, articleId });
          }}
          onOpenAnalysis={async (sessionId) => {
            if (isLegacySnapshotId(sessionId)) {
              const officeId = route.officeId ?? (await countingRepository.getSession(route.sessionId))?.officeId;
              if (officeId) onNavigate({ screen: "legacySnapshot", officeId, snapshotId: sessionId });
              return;
            }
            onNavigate({ screen: "analysis", sessionId });
          }}
        />
      );
    case "articles":
      return (
        <ArticlesPage
          officeId={route.officeId}
          onOpenArticle={(articleId) => onNavigate({ screen: "articleDetail", officeId: route.officeId, articleId })}
        />
      );
    case "articleDetail":
      return <ArticleDetailPage officeId={route.officeId} articleId={route.articleId} />;
    case "settings":
      return (
        <SettingsPage
          officeId={route.officeId}
          onImportNewOffice={() => onNavigate({ screen: "bootstrap", fromOfficeId: route.officeId })}
        />
      );
  }
}
