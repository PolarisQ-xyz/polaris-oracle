import { DEFAULT_FEED_CATALOG, parseFeedCatalog } from './configuration';

describe('parseFeedCatalog', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns the default catalog when FEED_CATALOG is unset', () => {
    const result = parseFeedCatalog(undefined);

    expect(result).toEqual(DEFAULT_FEED_CATALOG);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns a valid two-entry catalog verbatim', () => {
    const catalog = [
      { symbol: 'XLM/USD', hermesFeedId: 'abc123' },
      { symbol: 'BTC/USD', hermesFeedId: 'def456' },
    ];

    const result = parseFeedCatalog(JSON.stringify(catalog));

    expect(result).toEqual(catalog);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to the default catalog and warns on malformed JSON', () => {
    const result = parseFeedCatalog('{not valid json');

    expect(result).toEqual(DEFAULT_FEED_CATALOG);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to the default catalog and warns when an entry is missing hermesFeedId', () => {
    const catalog = [
      { symbol: 'XLM/USD', hermesFeedId: 'abc123' },
      { symbol: 'BTC/USD' },
    ];

    const result = parseFeedCatalog(JSON.stringify(catalog));

    expect(result).toEqual(DEFAULT_FEED_CATALOG);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to the default catalog and warns on non-array JSON', () => {
    const result = parseFeedCatalog(JSON.stringify({ symbol: 'XLM/USD', hermesFeedId: 'abc123' }));

    expect(result).toEqual(DEFAULT_FEED_CATALOG);
    expect(warnSpy).toHaveBeenCalled();
  });
});
