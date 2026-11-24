export type OverallStatus = "ok" | "ok_with_warnings" | "fatal";
export type CheckStatus = "pass" | "warn" | "fail" | "info";
export type CheckSeverity = "fatal" | "warn" | "info";
export type SlotParity = "even" | "odd";

export interface PlatformInfo {
  os: string;
  arch: string;
}

export interface PreflightCheck {
  id: string;
  status: CheckStatus;
  severity: CheckSeverity;
  detail: string;
  remediation: string | null;
}

export interface PreflightReport {
  overall_status: OverallStatus;
  checked_at_utc: string;
  platform: PlatformInfo;
  active_ft8_decoder: string;
  checks: PreflightCheck[];
}

export interface HealthResponse {
  status: string;
  version: string;
  uptime_sec: number;
  active_radios: number;
  active_ptt: boolean;
  preflight_status: OverallStatus;
  active_ft8_decoder: string;
}

export interface StationConfig {
  station_id: string;
  callsign: string | null;
  grid: string | null;
  updated_at_utc: string;
  auth_required?: boolean;
}

export interface SlotClockSpec {
  epoch_ms: number;
  anchor_wall_ms: number;
  slot_ms: number;
  scale: number;
}

export interface OutboxStats {
  pending_count: number;
  sent_count: number;
  dead_letter_count: number;
  sink_name: string;
  oldest_pending_utc: string | null;
}

export interface AudioDeviceSummary {
  index: number;
  name: string;
  supports_input: boolean;
  supports_output: boolean;
  max_input_channels: number;
  max_output_channels: number;
  supports_48khz: boolean;
  default_sample_rate: number | null;
  host_name: string;
  device_uid: string;
  card_id?: string | null;
  usb_vid?: string | null;
  usb_pid?: string | null;
  usb_serial?: string | null;
  usb_topology_path?: string | null;
  manufacturer?: string | null;
  product?: string | null;
}

export interface UsbInventoryEntry {
  device_key: string;
  os_path: string;
  real_tty_path: string | null;
  usb_vid: string | null;
  usb_pid: string | null;
  usb_serial: string | null;
  usb_interface: string | null;
  usb_topology_path: string | null;
  manufacturer: string | null;
  product: string | null;
  is_connected: boolean;
  assigned_radio_id: string | null;
  device_state: string;
  source: string;
  first_seen_utc?: string;
  last_seen_utc: string;
}

export interface HamlibModel {
  id: number;
  manufacturer: string;
  model: string;
  status: string;
}

export interface RadioProfile {
  radio_id: string;
  name: string;
  hamlib_model: number;
  is_dummy: boolean;
  serial_device_key: string | null;
  serial_baud_rate: number;
  civ_address: string | null;
  ptt_method: string;
  audio_device_uid?: string | null;
  audio_device_name?: string | null;
  audio_rx_channel?: string;
  audio_tx_gain_db?: number;
  rigctld_port: number;
  auto_connect: boolean;
}

export interface AgcLevelOption {
  value: number;
  label: string;
}

export interface RigCapabilities {
  model_id: number;
  modes: string[];
  vfos: string[];
  preamp_db: number[];
  att_db: number[];
  agc_levels: AgcLevelOption[];
  get_levels: string[];
  set_levels: string[];
  get_funcs: string[];
  set_funcs: string[];
  vfo_ops?: string[];
  max_rit_hz: number | null;
  max_xit_hz: number | null;
  has_split: boolean;
}

export interface RadioLiveSettings {
  vfo: string | null;
  split: boolean | null;
  tx_vfo: string | null;
  rit_hz: number | null;
  xit_hz: number | null;
  strength_db: number | null;
  rf_power_watts: number | null;
  levels: Record<string, number>;
  funcs: Record<string, boolean>;
}

export interface ChannelRosterEntry {
  is_demo: boolean;
  channel_key: string;
  callsign: string;
  mode: string;
  dial_freq_hz: number | null;
  band: string | null;
  grid: string | null;
  last_snr_db: number;
  last_dt_sec: number;
  last_af_hz: number;
  last_slot: SlotParity;
  last_message: string;
  is_cq: boolean;
  directed_cq: string | null;
  calling_me: boolean;
  station_role: "caller" | "hunter" | null;
  first_seen_ts_sec: number;
  last_seen_ts_sec: number;
  last_seen_wall_ms: number;
  decode_count: number;
}

export interface RadioSummary {
  profile: RadioProfile;
  lifecycle_state: string;
  freq_hz: number | null;
  band: string | null;
  mode: string | null;
  passband_hz: number | null;
  ptt: boolean;
  bound_serial_path: string | null;
  rigctld_pid: number | null;
  last_error: string | null;
  recovery_attempts: number;
  lease_holder: string | null;
  capabilities?: RigCapabilities | null;
  settings?: RadioLiveSettings | null;
}

export interface ControlLease {
  radio_id: string;
  lease_id: string;
  holder_actor: string;
  acquired_at_utc: string;
  expires_at_utc: string;
}

export interface TranscriptEntry {
  at_utc: string;
  direction: "rx" | "tx" | string;
  slot_ts: number;
  af_hz: number;
  snr_db: number | null;
  message: string;
}

export type SequencerMode = "auto_sequence" | "manual";

export interface CqState {
  qso_id: string;
  tx_slot: SlotParity;
  directed_cq: string | null;
  attempts: number;
  armed: boolean;
  started_at_utc: string;
}

export interface ActiveQso {
  qso_id: string;
  radio_id: string;
  is_demo: boolean;
  is_cq: boolean;
  directed_cq: string | null;
  my_call: string;
  my_grid: string;
  their_call: string;
  their_grid: string | null;
  their_role?: "caller" | "hunter" | null;
  tx_slot: SlotParity;
  step: string;
  status: "active" | "paused";
  attempts_on_step: number;
  last_their_snr_db: number | null;
  last_rx_slot_ts?: number | null;
  rst_sent: string | null;
  rst_rcvd: string | null;
  started_at_utc: string;
  updated_at_utc: string;
  transcript?: TranscriptEntry[];
}

export interface DecodeItem {
  ts_sec: number;
  slot: SlotParity;
  snr_db: number;
  dt_sec: number;
  af_hz: number;
  message: string;
  decoder_backend: string;
  decoder_metadata?: string | null;
}

export interface TxStateEvent {
  radio_id: string;
  state: "idle" | "armed" | "transmitting";
  af_hz: number | null;
  slot: SlotParity | null;
  message: string | null;
  ptt_elapsed_ms: number;
}

export interface WaterfallEvent {
  radio_id: string;
  min_hz: number;
  max_hz: number;
  bin_hz: number;
  bins_db: number[];
  rms_db: number;
  peak_db: number;
  clipped: boolean;
  even_occupied_hz: number[];
  odd_occupied_hz: number[];
}

export interface SessionSnapshot {
  active: boolean;
  radio_id: string | null;
  is_demo: boolean;
  decoder_backend: string | null;
  digital_mode?: "FT8" | "FT4";
  my_call: string | null;
  my_grid: string | null;
  slot_clock: SlotClockSpec;
  tx_af_hz: number;
  tx_af_occupied: boolean;
  tx_enabled: boolean;
  tx_state: "idle" | "armed" | "transmitting";
  armed_message: string | null;
  survey_active: boolean;
  sequencer_mode?: SequencerMode;
  armed_qso_id?: string | null;
  cq?: CqState | null;
  active_qsos: ActiveQso[];
  recent_decodes: DecodeItem[];
}

export interface CompletedSessionQso {
  qso: QsoLogItem;
  loggedSlotStartMs: number;
  slotMsAtLog: number;
  loggedAtWallMs: number;
}

export interface QsoLogItem {
  qso_id: string;
  radio_id: string | null;
  started_at_utc: string;
  completed_at_utc: string;
  my_call: string;
  my_grid: string;
  their_call: string;
  their_grid: string | null;
  mode: string;
  dial_freq_hz: number | null;
  band: string | null;
  af_hz: number | null;
  rst_sent: string | null;
  rst_rcvd: string | null;
  completion_reason: string;
  qrz_status?: "pending" | "synced" | "failed" | null;
  qrz_logid?: string | null;
  qrz_pushed_at_utc?: string | null;
  qrz_error?: string | null;
}

export interface QrzPushErrorItem {
  qso_id: string;
  their_call: string;
  reason: string;
}

export interface QrzPushSummary {
  total: number;
  pushed: number;
  duplicates: number;
  failed: number;
  skipped_demo: number;
  aborted_reason: string | null;
  errors: QrzPushErrorItem[];
  pushed_at_utc: string;
}

export interface QrzPushProgress {
  completed: number;
  total: number;
  pushed: number;
  duplicates: number;
  failed: number;
}

export interface QrzStatusSnapshot {
  configured: boolean;
  key_source: "env" | "database" | "none";
  key_hint: string | null;
  pending_count: number;
  failed_count: number;
  synced_count: number;
  in_progress: boolean;
  progress: QrzPushProgress | null;
  last_push_at_utc: string | null;
  last_push_summary: QrzPushSummary | null;
}

export interface CommandEnvelope {
  command_id: string;
  idempotency_key?: string;
  origin: "local_ui" | "cli" | "gcp_bridge";
  actor: string;
  radio_id?: string | null;
  kind: string;
  issued_at_utc: string;
  payload: Record<string, unknown>;
}

export interface CommandAck {
  type: "command_ack";
  command_id: string;
  status: "ok" | "rejected" | "failed";
  error_code: string | null;
  error_message: string | null;
  result: Record<string, unknown> | null;
  completed_at_utc: string;
}

export interface SnapshotEvent {
  type: "snapshot";
  server_version: string;
  uptime_sec: number;
  auth_required: boolean;
  station: StationConfig | null;
  slot_clock: SlotClockSpec;
  preflight: PreflightReport;
  outbox_stats: OutboxStats | null;
  qrz_status?: QrzStatusSnapshot | null;
  radios: RadioSummary[];
  usb_devices: UsbInventoryEntry[];
  leases: ControlLease[];
  session?: SessionSnapshot;
  active_qsos?: ActiveQso[];
  recent_decodes?: DecodeItem[];
}

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface EventLogItem {
  id: string;
  at: string;
  kind: string;
  summary: string;
}
