/**
 * T015 — MV3 service-worker keep-alive helper spec.
 * Drives src/keep-alive.ts (T016).
 *
 * Pattern (per plan.md §"MV3 service-worker keep-alive"):
 *   - start() opens chrome.runtime.connect port + sends 'ping' every 20s
 *   - stop() clears interval + disconnects port
 *   - idempotent (double-start does not leak ports)
 */

import { keepAlive } from '../src/keep-alive';

interface FakePort {
  postMessage: jest.Mock;
  disconnect: jest.Mock;
  name: string;
}

function installPortMock(): {
  ports: FakePort[];
  connectMock: jest.Mock;
} {
  const ports: FakePort[] = [];
  const connectMock = jest.fn().mockImplementation((info: chrome.runtime.ConnectInfo) => {
    const port: FakePort = {
      postMessage: jest.fn(),
      disconnect: jest.fn(),
      name: info.name ?? 'unnamed',
    };
    ports.push(port);
    return port;
  });
  (chrome.runtime as unknown as { connect: jest.Mock }).connect = connectMock;
  return { ports, connectMock };
}

describe('keep-alive (T015)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    keepAlive.stop(); // ensure clean state across tests
  });

  afterEach(() => {
    keepAlive.stop();
    jest.useRealTimers();
  });

  it('start() opens exactly one port and starts a 20s ping interval', () => {
    const { ports } = installPortMock();
    keepAlive.start();
    expect(ports).toHaveLength(1);
    expect(ports[0].postMessage).not.toHaveBeenCalled();

    jest.advanceTimersByTime(20_000);
    expect(ports[0].postMessage).toHaveBeenCalledTimes(1);
    expect(ports[0].postMessage).toHaveBeenCalledWith('ping');

    jest.advanceTimersByTime(20_000);
    expect(ports[0].postMessage).toHaveBeenCalledTimes(2);
  });

  it('uses a recognizable port name (helps debug from chrome://serviceworker-internals)', () => {
    const { ports } = installPortMock();
    keepAlive.start();
    expect(ports[0].name).toMatch(/keep-alive/);
  });

  it('stop() clears interval and disconnects the port', () => {
    const { ports } = installPortMock();
    keepAlive.start();
    keepAlive.stop();
    expect(ports[0].disconnect).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);
    expect(ports[0].postMessage).not.toHaveBeenCalled();
  });

  it('is idempotent: double start() does not leak ports', () => {
    const { ports } = installPortMock();
    keepAlive.start();
    keepAlive.start();
    keepAlive.start();
    expect(ports).toHaveLength(1);
  });

  it('start() then immediate stop() does not throw and disconnects cleanly', () => {
    const { ports } = installPortMock();
    expect(() => {
      keepAlive.start();
      keepAlive.stop();
    }).not.toThrow();
    expect(ports[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('stop() before any start() is a no-op (does not throw)', () => {
    installPortMock();
    expect(() => keepAlive.stop()).not.toThrow();
  });

  it('start() after stop() opens a fresh port', () => {
    const { ports } = installPortMock();
    keepAlive.start();
    keepAlive.stop();
    keepAlive.start();
    expect(ports).toHaveLength(2);
    expect(ports[0].disconnect).toHaveBeenCalled();
  });
});
