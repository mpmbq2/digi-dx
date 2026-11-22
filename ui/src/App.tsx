import { EventStreamDrawer } from "./components/EventStreamDrawer";
import { PreflightPanel } from "./components/PreflightPanel";
import { RadioControlPanel } from "./components/RadioControlPanel";
import { SlotClockBar } from "./components/SlotClockBar";
import { StationAndHardwarePanel } from "./components/StationAndHardwarePanel";
import { SystemHealthGrid } from "./components/SystemHealthGrid";
import { useDaemonSocket } from "./hooks/useDaemonSocket";

export function App() {
  const daemon = useDaemonSocket();

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

      <SlotClockBar spec={daemon.slotClock} />

      <main class="main-content">
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

        <EventStreamDrawer events={daemon.events} actor={daemon.actor} />
      </main>
    </div>
  );
}
