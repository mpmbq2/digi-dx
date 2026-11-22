import type { EventLogItem } from "../types";

interface Props {
  events: EventLogItem[];
  actor: string;
}

export function EventStreamDrawer({ events, actor }: Props) {
  return (
    <section class="panel" aria-label="Live WebSocket Event Feed">
      <div class="panel-header">
        <div>
          <h2>Live Daemon Event Stream</h2>
          <p class="muted mono">Actor: {actor}</p>
        </div>
      </div>
      {events.length === 0 ? (
        <p class="muted">Waiting for WebSocket frames...</p>
      ) : (
        <ul class="event-log">
          {events.map((ev) => (
            <li key={ev.id} class="event-row mono">
              <span class="event-time">{ev.at}</span>
              <span class="event-kind">{ev.kind}</span>
              <span class="event-summary">{ev.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
