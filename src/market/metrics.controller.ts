import { Controller, Get, Header } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/**
 * Exposes GET /metrics in Prometheus text exposition format (#162).
 *
 * Not `AdminGuard`-gated by design: standard scrape configs expect a
 * publicly reachable `/metrics` path. Restrict at the network/ingress layer
 * if needed (firewall rules, Railway's private network, etc.).
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): string {
    return this.metrics.render();
  }
}
