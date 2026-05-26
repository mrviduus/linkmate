/**
 * T016 — MV3 service-worker keep-alive helper (Phase A foundation, v1.1).
 *
 * Per Constitution v1.1 §VII (Service Worker Lifecycle, NON-NEGOTIABLE):
 *   MV3 SWs suspend after ~30s of event-loop idle. Long-running flows
 *   (SSI capture in a background tab, profile-capture WebLLM inference,
 *   model cold-load) must wrap themselves in keepAlive.start()/stop() to
 *   prevent the SW from being killed mid-operation.
 *
 * Pattern (per plan.md §"MV3 service-worker keep-alive"):
 *   - start() opens a long-lived chrome.runtime.connect port to ourselves
 *     and sends a no-op 'ping' every 20s. Active ports keep the SW alive.
 *   - stop() clears the interval and disconnects the port.
 *   - Idempotent: repeated start() reuses the existing port + interval.
 *
 * Call ONLY from the background service worker. Never from popup or
 * content scripts (they don't need to keep themselves alive).
 */

const PING_INTERVAL_MS = 20_000;
const PORT_NAME = 'linkmate.keep-alive';

let port: chrome.runtime.Port | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;

function safePing(): void {
  if (!port) return;
  try {
    port.postMessage('ping');
  } catch {
    // Port closed under us (e.g. SW already woke a new instance); next stop() cleans up.
  }
}

function startInternal(): void {
  if (intervalId !== null) return; // already running — idempotent
  port = chrome.runtime.connect({ name: PORT_NAME });
  intervalId = setInterval(safePing, PING_INTERVAL_MS);
}

function stopInternal(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (port) {
    try {
      port.disconnect();
    } catch {
      // already disconnected — fine
    }
    port = null;
  }
}

export const keepAlive = {
  start: startInternal,
  stop: stopInternal,
};
