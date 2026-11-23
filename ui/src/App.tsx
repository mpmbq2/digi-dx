import { useCallback, useEffect, useState } from "preact/hooks";
import { EventStreamDrawer } from "./components/EventStreamDrawer";
import { LogbookPanel } from "./components/LogbookPanel";
import { OperatingConsole } from "./components/OperatingConsole";
import { RadioInfoPanel } from "./components/RadioInfoPanel";
import { SetupSplash } from "./components/SetupSplash";
import { SlotClockBar } from "./components/SlotClockBar";
import { useDaemonSocket } from "./hooks/useDaemonSocket";

type Route =
  | { view: "splash" }
  | { view: "logbook" }
  | { view: "radio"; radioId: string; tab: "info" | "ft8" };

function parseHashRoute(hash: string): Route {
  const clean = hash.replace(/^#/, "");
  if (clean === "/logbook") {
    return { view: "logbook" };
  }
  const radioMatch = clean.match(/^\/radio\/([^/]+)\/(info|ft8)$/);
  if (radioMatch) {
    return {
      view: "radio",
      radioId: decodeURIComponent(radioMatch[1]),
      tab: radioMatch[2] as "info" | "ft8",
    };
  }
  return { view: "splash" };
}

function routeToHash(route: Route): string {
  switch (route.view) {
    case "splash":
      return "#/";
    case "logbook":
      return "#/logbook";
    case "radio":
      return `#/radio/${encodeURIComponent(route.radioId)}/${route.tab}`;
  }
}

export function App() {
  const daemon = useDaemonSocket();
  const [route, setRoute] = useState<Route>(() =>
    parseHashRoute(window.location.hash)
  );
  const [eventsOpen, setEventsOpen] = useState<boolean>(false);

  useEffect(() => {
    const onHashChange = () => {
      setRoute(parseHashRoute(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    const targetHash = routeToHash(next);
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
    setRoute(next);
  }, []);

  const activeRadio =
    route.view === "radio"
      ? daemon.radios.find((r) => r.profile.radio_id === route.radioId) ?? null
      : null;

  const showClock =
    (route.view === "radio" && route.tab === "ft8") ||
    Boolean(daemon.session?.active);

  return (
    <div class="app-shell">
      <header class="topbar">
        <div
          class="brand"
          role="button"
          tabIndex={0}
          onClick={() => navigate({ view: "splash" })}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              navigate({ view: "splash" });
            }
          }}
        >
          <div class="brand-mark">DX</div>
          <div>
            <h1>Digi-Dx v2</h1>
            <p class="muted">Local FT8 &amp; Transceiver Console</p>
          </div>
        </div>

        <div class="topbar-right">
          <nav class="main-nav" aria-label="Primary Views">
            <button
              type="button"
              data-testid="nav-setup"
              class={`btn btn-sm ${
                route.view === "splash" ? "btn-primary" : "btn-secondary"
              }`}
              onClick={() => navigate({ view: "splash" })}
            >
              {route.view === "radio" ? "← All Radios" : "Hardware & Setup"}
            </button>

            {route.view === "radio" && (
              <>
                {daemon.radios.length > 1 && (
                  <select
                    class="input-sm"
                    aria-label="Switch Transceiver"
                    value={route.radioId}
                    onChange={(e) => {
                      const nextId = (e.currentTarget as HTMLSelectElement).value;
                      if (nextId) {
                        navigate({
                          view: "radio",
                          radioId: nextId,
                          tab: route.tab,
                        });
                      }
                    }}
                  >
                    {daemon.radios.map((r) => (
                      <option key={r.profile.radio_id} value={r.profile.radio_id}>
                        {r.profile.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  data-testid="tab-radio-info"
                  class={`btn btn-sm ${
                    route.tab === "info" ? "btn-primary" : "btn-secondary"
                  }`}
                  onClick={() =>
                    navigate({
                      view: "radio",
                      radioId: route.radioId,
                      tab: "info",
                    })
                  }
                >
                  Radio Info &amp; Controls
                </button>
                <button
                  type="button"
                  data-testid="tab-radio-ft8"
                  class={`btn btn-sm ${
                    route.tab === "ft8" ? "btn-primary" : "btn-secondary"
                  }`}
                  onClick={() =>
                    navigate({
                      view: "radio",
                      radioId: route.radioId,
                      tab: "ft8",
                    })
                  }
                >
                  FT8 Operation
                </button>
              </>
            )}

            <button
              type="button"
              data-testid="nav-logbook"
              class={`btn btn-sm ${
                route.view === "logbook" ? "btn-primary" : "btn-secondary"
              }`}
              onClick={() => {
                navigate({ view: "logbook" });
                void daemon.refreshQsos(false);
                void daemon.refreshQsos(true);
              }}
            >
              Logbook &amp; ADIF
            </button>
          </nav>

          <span
            class={`conn-indicator ${
              daemon.connectionState === "connected" ? "is-live" : "is-warn"
            }`}
          >
            <span class="dot" />
            WS: {daemon.connectionState}
          </span>

          <button
            type="button"
            class={`btn btn-sm ${eventsOpen ? "btn-primary" : "btn-secondary"}`}
            data-testid="toggle-events-btn"
            onClick={() => setEventsOpen((o) => !o)}
          >
            Events ({daemon.events.length})
          </button>
        </div>
      </header>

      {daemon.session?.active && daemon.session.is_demo && (
        <div class="demo-banner" data-testid="demo-banner" role="alert">
          <strong>DEMO MODE ACTIVE</strong> — Simulated `QQ*` peer station (no RF transmitted; isolated from real QSO log and ADIF exports · scale{" "}
          {daemon.slotClock?.scale ?? 1}x)
        </div>
      )}

      {showClock && <SlotClockBar spec={daemon.slotClock} />}

      <main class="main-content">
        {route.view === "splash" && (
          <SetupSplash
            daemon={daemon}
            onOpenRadio={(radioId, tab) =>
              navigate({ view: "radio", radioId, tab })
            }
          />
        )}

        {route.view === "radio" && !activeRadio && (
          <section class="panel">
            <div class="panel-header">
              <div>
                <h2>Radio Not Found</h2>
                <p class="muted">
                  Waiting for profile `{route.radioId}` or it was deleted.
                </p>
              </div>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                onClick={() => navigate({ view: "splash" })}
              >
                ← Back to Hardware &amp; Setup
              </button>
            </div>
          </section>
        )}

        {route.view === "radio" && activeRadio && route.tab === "info" && (
          <RadioInfoPanel
            daemon={daemon}
            radio={activeRadio}
            onOpenFt8={() =>
              navigate({
                view: "radio",
                radioId: activeRadio.profile.radio_id,
                tab: "ft8",
              })
            }
            onDeleted={() => navigate({ view: "splash" })}
          />
        )}

        {route.view === "radio" && activeRadio && route.tab === "ft8" && (
          <OperatingConsole
            daemon={daemon}
            radio={activeRadio}
            onNavigateInfo={() =>
              navigate({
                view: "radio",
                radioId: activeRadio.profile.radio_id,
                tab: "info",
              })
            }
          />
        )}

        {route.view === "logbook" && (
          <LogbookPanel
            realQsos={daemon.realQsos}
            demoQsos={daemon.demoQsos}
            onRefresh={daemon.refreshQsos}
          />
        )}

        <EventStreamDrawer
          events={daemon.events}
          actor={daemon.actor}
          isOpen={eventsOpen}
          onClose={() => setEventsOpen(false)}
        />
      </main>
    </div>
  );
}
