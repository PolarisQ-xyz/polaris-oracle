import { MetricsService } from './metrics.service';

describe('MetricsService (issue #162)', () => {
  let svc: MetricsService;

  beforeEach(() => {
    svc = new MetricsService();
  });

  it('renders settle counters in Prometheus text format', () => {
    svc.recordSettle('success');
    svc.recordSettle('success');
    svc.recordSettle('failure');
    const text = svc.renderText();
    expect(text).toContain('polaris_settle_total{outcome="success"} 2');
    expect(text).toContain('polaris_settle_total{outcome="failure"} 1');
  });

  it('renders rpc retry counter with label and contract_id', () => {
    svc.recordRpcRetry('settle', 'CCONTRACT');
    svc.recordRpcRetry('settle', 'CCONTRACT');
    const text = svc.renderText();
    expect(text).toContain('polaris_rpc_retry_total{label="settle",contract_id="CCONTRACT"} 2');
  });

  it('renders gauges injected at render time', () => {
    const text = svc.renderText({ 'polaris_markets_total{status="watching"}': 5 });
    expect(text).toContain('polaris_markets_total{status="watching"} 5');
  });

  it('escapes double-quotes in label values', () => {
    svc.recordRpcRetry('a"b', 'C');
    const text = svc.renderText();
    expect(text).toContain('label="a\\"b"');
  });

  it('accumulates counters across multiple calls', () => {
    for (let i = 0; i < 10; i++) svc.recordRelaySubmit('success');
    const text = svc.renderText();
    expect(text).toContain('polaris_relay_submit_total{outcome="success"} 10');
  });
});
