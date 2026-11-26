import { openDatabase } from './database.provider';
import { EmailAuthRepository } from './email-auth.repository';

describe('EmailAuthRepository', () => {
  it('deleteExpiredCodes removes expired rows and keeps unexpired ones', () => {
    const repo = new EmailAuthRepository(openDatabase(':memory:'));
    repo.saveCode('old@example.com', 'h1', 1_000);
    repo.saveCode('new@example.com', 'h2', 10_000);

    expect(repo.deleteExpiredCodes(5_000)).toBe(1);
    expect(repo.getCode('old@example.com')).toBeUndefined();
    expect(repo.getCode('new@example.com')).toBeDefined();
  });

  it('clears its sweep timer on destroy', () => {
    const clearSpy = jest.spyOn(global, 'clearInterval');
    const repo = new EmailAuthRepository(openDatabase(':memory:'));
    repo.onModuleInit();
    repo.onModuleDestroy();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
