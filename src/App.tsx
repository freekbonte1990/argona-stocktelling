import { useEffect, useState } from "react";
import { AppHeader } from "./ui/components/AppHeader";
import { ImportPage } from "./ui/pages/ImportPage";
import { HomePage } from "./ui/pages/HomePage";
import { NewSessionPage } from "./ui/pages/NewSessionPage";
import { LocationOverviewPage } from "./ui/pages/LocationOverviewPage";
import { CountingPage } from "./ui/pages/CountingPage";
import { ArticlesPage } from "./ui/pages/ArticlesPage";
import { SettingsPage } from "./ui/pages/SettingsPage";
import { useAllOffices, useOffice, useSession } from "./ui/hooks/useLiveData";
import { countSessionService, countingRepository } from "./application/container";

type Route =
  | { screen: "import"; fromOfficeId?: string }
  | { screen: "home"; officeId: string }
  | { screen: "newSession"; officeId: string }
  | { screen: "locationOverview"; sessionId: string }
  | { screen: "counting"; sessionId: string; locationId: string }
  | { screen: "articles"; officeId: string }
  | { screen: "settings"; officeId: string };

export default function App() {
  const offices = useAllOffices();
  const [route, setRoute] = useState<Route | null>(null);

  // Bepaal het startscherm zodra we weten of er al een kantoor geïmporteerd is.
  // Dit is ook hoe "app sluiten en heropenen" werkt: er is geen aparte
  // navigatiestatus bewaard, alles wordt afgeleid uit wat in IndexedDB staat
  // (incl. welk kantoor laatst geselecteerd was — multi-kantoor).
  //
  // Let op: dit gebruikt bewust een eenmalige async call naar
  // countingRepository.getSelectedOfficeId() in plaats van een reactieve
  // live-query hook. Een live-query die nog niet is opgelost geeft ook
  // `undefined` terug, exact hetzelfde als "er is nog geen rij" — dat is niet
  // van elkaar te onderscheiden. Op een verse installatie (nul kantoren,
  // dus ook nooit een appState-rij) zou de app dan voor altijd op een blanco
  // scherm blijven hangen. Een Promise heeft dat probleem niet: die resolvet
  // ondubbelzinnig, ook naar `undefined` wanneer er echt niets bewaard is.
  useEffect(() => {
    if (route !== null || offices === undefined) return;
    if (offices.length === 0) {
      setRoute({ screen: "import" });
      return;
    }
    let cancelled = false;
    (async () => {
      const selectedOfficeId = await countingRepository.getSelectedOfficeId();
      if (cancelled) return;
      const preferredOffice = offices.find((o) => o.id === selectedOfficeId) ?? offices[0];
      setRoute({ screen: "home", officeId: preferredOffice.id });
    })();
    return () => {
      cancelled = true;
    };
  }, [offices, route]);

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
    route.screen === "settings"
      ? route.officeId
      : undefined;
  const office = useOffice(directOfficeId);
  const session = useSession(
    route.screen === "locationOverview" || route.screen === "counting" ? route.sessionId : undefined,
  );
  const sessionOffice = useOffice(session?.officeId);

  if (route.screen === "import") {
    if (!route.fromOfficeId) return null;
    return (
      <AppHeader
        breadcrumb="Ander kantoor importeren"
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
  // counting
  const location = sessionOffice?.locations.find((l) => l.id === route.locationId);
  return (
    <AppHeader
      breadcrumb={`${sessionOffice?.name ?? ""} > ${location?.name ?? ""}`}
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
    case "import":
      return (
        <ImportPage
          onImported={(officeId) => onNavigate({ screen: "home", officeId })}
          onCancel={
            route.fromOfficeId
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
          onImportNewOffice={() => onNavigate({ screen: "import", fromOfficeId: route.officeId })}
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
          onSessionCompleted={async () => {
            const session = await countingRepository.getSession(route.sessionId);
            if (session) onNavigate({ screen: "home", officeId: session.officeId });
          }}
        />
      );
    case "counting":
      return <CountingPage sessionId={route.sessionId} locationId={route.locationId} />;
    case "articles":
      return <ArticlesPage officeId={route.officeId} />;
    case "settings":
      return <SettingsPage officeId={route.officeId} />;
  }
}
