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
  complexityOf,
  complexitySignals,
  toOverview,
  toPromptIndexItem,
  taskCountsByModel,
  type Complexity,
  type ComplexityLevel,
  type ComplexitySignals,
  type Overview,
  type PromptIndexItem,
  type TaskModelFlow,
} from './overview.js';
export {
  SAVINGS_NOTE,
  toDashboardRun,
  toRunList,
  type DashboardRun,
  type DashboardSource,
  type RunListItem,
  type SourceResult,
  type TaskBreakdown,
} from './view.js';
