// StockUI — Reference Interaction layer providing dashboard, priority queue, and QSO sequencing (R15, R16).

export interface StockUiOptions {
  theme?: "dark" | "light";
}

export function renderStockUiScript(options: StockUiOptions = {}): string {
  return `
    (function(digiDx, container) {
      container.innerHTML = \`
        <div style="font-family: system-ui, sans-serif; display: flex; flex-direction: column; gap: 1rem; height: 100%;">
          <!-- Header Bar -->
          <div style="display:flex; justify-content:space-between; align-items:center; background:#1e293b; padding:0.75rem 1rem; border-radius:6px;">
            <div>
              <span id="ui-call" style="font-size:1.25rem; font-weight:bold; color:#38bdf8;">--</span>
              <span id="ui-grid" style="color:#94a3b8; margin-left:0.5rem;">--</span>
            </div>
            <div id="ui-alerts" style="color:#fbbf24; font-weight:bold; font-size:0.9rem;"></div>
            <div>
              <button id="btn-call-cq" style="background:#0284c7; color:white; border:none; padding:0.4rem 0.8rem; border-radius:4px; cursor:pointer;">Call CQ</button>
              <button id="btn-halt" style="background:#ef4444; color:white; border:none; padding:0.4rem 0.8rem; border-radius:4px; cursor:pointer; margin-left:0.5rem;">Halt</button>
            </div>
          </div>

          <!-- Main Panels -->
          <div style="display:flex; gap:1rem; flex:1; min-height:0;">
            <!-- Priority Caller Queue Panel -->
            <div style="flex:1; background:#1e293b; border-radius:6px; padding:1rem; display:flex; flex-direction:column;">
              <h3 style="margin-top:0; color:#f8fafc; font-size:1rem; border-bottom:1px solid #334155; padding-bottom:0.5rem;">Priority Caller Queue</h3>
              <div id="queue-list" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:0.5rem;">
                <p style="color:#64748b; font-size:0.85rem;">No callers queued</p>
              </div>
            </div>

            <!-- Active QSO & Decodes Panel -->
            <div style="flex:2; display:flex; flex-direction:column; gap:1rem;">
              <!-- Active QSO Card -->
              <div style="background:#1e293b; border-radius:6px; padding:1rem;">
                <h3 style="margin-top:0; color:#f8fafc; font-size:1rem; border-bottom:1px solid #334155; padding-bottom:0.5rem;">Active Contact</h3>
                <div id="active-qso-card" style="color:#cbd5e1; font-size:0.9rem;">
                  <p style="color:#64748b; margin:0;">Station Idle</p>
                </div>
              </div>

              <!-- Decodes Feed -->
              <div style="flex:1; background:#1e293b; border-radius:6px; padding:1rem; display:flex; flex-direction:column; min-height:0;">
                <h3 style="margin-top:0; color:#f8fafc; font-size:1rem; border-bottom:1px solid #334155; padding-bottom:0.5rem;">Live Decodes</h3>
                <div id="decodes-table" style="flex:1; overflow-y:auto; font-family:monospace; font-size:0.8rem; color:#94a3b8; display:flex; flex-direction:column; gap:0.25rem;">
                </div>
              </div>
            </div>
          </div>
        </div>
      \`;

      const queueList = container.querySelector('#queue-list');
      const activeQsoCard = container.querySelector('#active-qso-card');
      const decodesTable = container.querySelector('#decodes-table');
      const uiCall = container.querySelector('#ui-call');
      const uiGrid = container.querySelector('#ui-grid');
      const uiAlerts = container.querySelector('#ui-alerts');

      function updateQueue(state) {
        if (!queueList) return;
        if (!state.callerQueue || state.callerQueue.length === 0) {
          queueList.innerHTML = '<p style="color:#64748b; font-size:0.85rem;">No callers queued</p>';
          return;
        }
        queueList.innerHTML = '';
        state.callerQueue.forEach(function(caller) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:#0f172a; padding:0.5rem; border-radius:4px;';
          row.innerHTML = \`
            <div>
              <span style="font-weight:bold; color:#e2e8f0;">\${caller.call}</span>
              <span style="color:#94a3b8; font-size:0.8rem; margin-left:0.5rem;">\${caller.grid || ''}</span>
              <span style="color:#38bdf8; font-size:0.8rem; margin-left:0.5rem;">\${caller.distanceKm ? caller.distanceKm + ' km' : ''}</span>
            </div>
            <button style="background:#0284c7; color:white; border:none; padding:0.25rem 0.5rem; border-radius:3px; cursor:pointer;">Answer</button>
          \`;
          row.querySelector('button').onclick = function() {
            digiDx.transmit({ af: 1200, slot: 'even', message: caller.call + ' ' + (uiCall.textContent || '') + ' ' + (uiGrid.textContent || '') });
          };
          queueList.appendChild(row);
        });
      }

      // Initial state sync
      const initialState = digiDx.getPolicyState();
      if (initialState) updateQueue(initialState);

      // Listen for policy updates
      digiDx.on('policyStateChange', function(state) {
        updateQueue(state);
      });

      // Listen for decodes
      digiDx.on('decode', function(d) {
        if (!decodesTable) return;
        const line = document.createElement('div');
        line.textContent = '[' + new Date(d.ts).toISOString().slice(11, 19) + '] ' + d.snr + 'dB ' + d.af + 'Hz: ' + d.message;
        decodesTable.prepend(line);
      });

      // Listen for alerts
      digiDx.on('log', function(l) {
        if (uiAlerts && l.level === 'warn') {
          uiAlerts.textContent = l.message;
          setTimeout(function() { uiAlerts.textContent = ''; }, 4000);
        }
      });

      container.querySelector('#btn-call-cq').onclick = function() {
        digiDx.transmit({ af: 1200, slot: 'even', message: 'CQ ' + uiCall.textContent + ' ' + uiGrid.textContent });
      };

      container.querySelector('#btn-halt').onclick = function() {
        digiDx.haltTx();
      };
    })(digiDx, container);
  `;
}
