import { useState } from "preact/hooks";
import { EventStreamDrawer } from "./components/EventStreamDrawer";
import { LogbookPanel } from "./components/LogbookPanel";
import { OperatingConsole } from "./components/OperatingConsole";
import { PreflightPanel } from "./components/PreflightPanel";
import { RadioControlPanel } from "./components/RadioControlPanel";
import { SlotClockBar } from "./components/SlotClockBar";
import { StationAndHardwarePanel } from "./components/StationAndHardwarePanel";
import { SystemHealthGrid } from "./components/SystemHealthGrid";
import { useDaemonSocket } from "./hooks/useDaemonSocket";

type NavTab = "operate" | "setup" | "logbook";

export function App() {
  const daemon = useDaemonSocket();
  const [activeTab, setActiveTab] = useState<NavTab>("operate");

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">DX</div>
          <div>
            <h1>Digi-Dx v2</h1>
            <p class="muted">Local FT8 &amp; Transceiver Daemon Console</p>
          </div>
        </div>
        <div class="topbar-right">
          <nav class="main-nav" aria-label="Primary Views">
            <button
              type="button"
              data-testid="nav-operate"
              class={`btn btn-sm ${activeTab === "operate" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setActiveTab("operate")}
            >
              Operating Console
            </button>
            <button
              type="button"
              data-testid="nav-setup"
              class={`btn btn-sm ${activeTab === "setup" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setActiveTab("setup")}
            >
              Hardware &amp; Setup
            </button>
            <button
              type="button"
              data-testid="nav-logbook"
              class={`btn btn-sm ${activeTab === "logbook" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => {
                setActiveTab("logbook");
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
          <a
            class="btn btn-secondary"
            href="/api/v1/preflight"
            target="_blank"
            rel="noreferrer"
          >
            Preflight JSON
          </a>
        </div>
      </header>

      {daemon.session?.active && daemon.session.is_demo && (
        <div class="demo-banner" data-testid="demo-banner" role="alert">
          <strong>DEMO MODE ACTIVE</strong> — Simulated `QQ*` peer station (no RF transmitted; isolated from real QSO log and ADIF exports · scale {daemon.slotClock?.scale ?? 1}x)
        </div>
      )}

      <SlotClockBar spec={daemon.slotClock} />

      <main class="main-content">
        {activeTab === "operate" && <OperatingConsole daemon={daemon} />}

        {activeTab === "setup" && (
          <>
            <SystemHealthGrid
              connectionState={daemon.connectionState}
              lastHeartbeatAt={daemon.lastHeartbeatAt}
              health={daemon.health}
              preflight={daemon.preflight}
              outboxStats={daemon.outboxStats}
              audioDevices={daemon.audioDevices}
              usbDevices={daemon.usbDevices}
              radios={daemon.radios}
            />

            <RadioControlPanel
              actor={daemon.actor}
              usbDevices={daemon.usbDevices}
              audioDevices={daemon.audioDevices}
              hamlibModels={daemon.hamlibModels}
              radios={daemon.radios}
              heldLeases={daemon.heldLeases}
              onSendCommand={daemon.sendCommand}
              onClaimLease={daemon.claimLease}
              onReleaseLease={daemon.releaseLease}
            />

            <div class="main-grid">
              <PreflightPanel
                report={daemon.preflight}
                onRefresh={() => daemon.refreshAll(true)}
              />
              <StationAndHardwarePanel
                station={daemon.station}
                authRequired={daemon.authRequired}
                authToken={daemon.authToken}
                onAuthTokenChange={daemon.setAuthToken}
                audioDevices={daemon.audioDevices}
                onSaveStation={(call, grid, token) =>
                  daemon.sendCommand(
                    "station.update_config",
                    { callsign: call, grid },
                    token
                  )
                }
              />
            </div>
          </>
        )}

        {activeTab === "logbook" && (
          <LogbookPanel
            realQsos={daemon.realQsos}
            demoQsos={daemon.demoQsos}
            onRefresh={daemon.refreshQsos}
          />
        )}

        <EventStreamDrawer events={daemon.events} actor={daemon.actor} />
      </main>
    </div>
  );
}
