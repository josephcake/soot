/**
 * @soot/dashboard — optional local dashboard (ADR-031). Loaded only by `soot dashboard`; no
 * engine package or headless entry point imports it.
 */
export {
  DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
  parsePort,
  startDashboard,
  type DashboardHandle,
  type DashboardOptions,
} from './server.js';
export { usageCharts, type UsageCharts, type UsageRow, type UsageSide } from './charts.js';
export {
  SAVINGS_NOTE,
  toDashboardRun,
  toRunList,
  type DashboardRun,
  type DashboardSource,
  type RunListItem,
  type SourceResult,
} from './view.js';
