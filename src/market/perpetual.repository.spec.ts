import { openDatabase } from './database.provider';
import { PerpetualRepository } from './perpetual.repository';
import type { WatchedPerpetual } from './perpetual.types';

function sample(overrides: Partial<WatchedPerpetual> = {}): WatchedPerpetual {
  const now = Date.now();
  return { contractId: 'CPERP1', status: 'watching', createdAt: now, updatedAt: now, ...overrides };
}

describe('PerpetualRepository', () => {
  it('round-trips a perpetual through upsert/getById', () => {
    const repo = new PerpetualRepository(openDatabase(':memory:'));
    repo.upsert(sample());
    expect(repo.getById('CPERP1')).toMatchObject({ contractId: 'CPERP1', status: 'watching' });
  });

  it('updates status on conflict instead of duplicating rows', () => {
    const repo = new PerpetualRepository(openDatabase(':memory:'));
    repo.upsert(sample({ status: 'watching' }));
    repo.upsert(sample({ status: 'terminated', terminateTxHash: 'deadbeef' }));

    expect(repo.getAll()).toHaveLength(1);
    expect(repo.getById('CPERP1')).toMatchObject({ status: 'terminated', terminateTxHash: 'deadbeef' });
  });

  it('getAll returns every tracked perpetual, newest first', () => {
    const repo = new PerpetualRepository(openDatabase(':memory:'));
    repo.upsert(sample({ contractId: 'COLD', createdAt: 1, updatedAt: 1 }));
    repo.upsert(sample({ contractId: 'CNEW', createdAt: 2, updatedAt: 2 }));
    expect(repo.getAll().map((p) => p.contractId)).toEqual(['CNEW', 'COLD']);
  });

  it('getById returns undefined for an unknown contract', () => {
    const repo = new PerpetualRepository(openDatabase(':memory:'));
    expect(repo.getById('NOPE')).toBeUndefined();
  });
});
