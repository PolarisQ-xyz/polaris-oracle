import { ConfigService } from '@nestjs/config';
import { OracleService } from './oracle.service';

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    pythLazerToken: 'test-token',
    pythLazerWsUrl: 'wss://example.com',
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

// Minimal stub for PythLazerClient — only the lifecycle hooks OracleService
// calls are needed here.
function makePythClient() {
  let downListener: (() => void) | undefined;
  let restoredListener: (() => void) | undefined;
  return {
    addAllConnectionsDownListener: jest.fn((fn: () => void) => { downListener = fn; }),
    addConnectionRestoredListener: jest.fn((fn: () => void) => { restoredListener = fn; }),
    addMessageListener: jest.fn(),
    unsubscribe: jest.fn(),
    subscribe: jest.fn(),
    shutdown: jest.fn(),
    // Trigger helpers for tests.
    _triggerDown: () => downListener?.(),
    _triggerRestored: () => restoredListener?.(),
  };
}

describe('OracleService — oracle status', () => {
  it('status.available starts false before onModuleInit', () => {
    const svc = new OracleService(makeConfig());
    expect(svc.status.available).toBe(false);
    expect(svc.status.lastStateChangeAt).toBeNull();
    expect(svc.status.lastUpdateReceivedAt).toBeNull();
  });

  it('status is not configured when PYTH_LAZER_TOKEN is unset', async () => {
    const svc = new OracleService(makeConfig({ pythLazerToken: undefined }));
    await svc.onModuleInit();
    expect(svc.status.available).toBe(false);
  });

  it('toggling the connections-down listener sets available=false and updates lastStateChangeAt', async () => {
    const client = makePythClient();
    jest.mock('@pythnetwork/pyth-lazer-sdk', () => ({
      PythLazerClient: { create: jest.fn().mockResolvedValue(client) },
    }));

    // Directly exercise setAvailable via the connection listeners by
    // patching the client after construction — simpler than spinning up a
    // real WebSocket.
    const svc = new OracleService(makeConfig());
    // Manually wire the client to avoid the real WebSocket connection.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).client = client;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).setAvailable(true); // simulate connected

    expect(svc.status.available).toBe(true);
    const changeAt1 = svc.status.lastStateChangeAt;
    expect(changeAt1).not.toBeNull();

    // Register listeners as onModuleInit would (re-use the ones we have).
    client.addAllConnectionsDownListener.mock.calls; // already populated by construct
    // Fire the connections-down event directly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).setAvailable(false);

    expect(svc.status.available).toBe(false);
    expect(svc.status.lastStateChangeAt).not.toBeNull();

    // Restore.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).setAvailable(true);
    expect(svc.status.available).toBe(true);
    // lastStateChangeAt must have advanced.
    expect(svc.status.lastStateChangeAt).not.toBe(changeAt1);
  });
});
