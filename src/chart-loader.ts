/**
 * Chart.js loader with tree-shaken registry.
 *
 * Imports only the controllers + scales + plugins we actually render
 * (line + doughnut). Loaded via dynamic import from popup.ts so the
 * chart bundle splits out and only ships when the user opens the popup.
 *
 * Why this module exists: `await import('chart.js')` directly in popup.ts
 * makes Parcel bundle the entire chart.js (all controllers ~2 MB). Static
 * imports inside this wrapper let Parcel tree-shake to just what we use.
 */

import {
  ArcElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  DoughnutController,
  ArcElement,
  Tooltip,
  Filler
);

export { Chart };
