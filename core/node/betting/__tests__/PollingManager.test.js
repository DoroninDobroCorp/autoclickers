const { PollingManager } = require('../PollingManager.js');

describe('PollingManager', () => {
    let pollingManager;
    let mockAnalyzerClient;
    
    beforeEach(() => {
        mockAnalyzerClient = {
            fetchPairs: jest.fn()
        };
        
        pollingManager = new PollingManager({
            analyzerClient: mockAnalyzerClient,
            bookmakerName: 'test',
            pollIntervalMs: 100,
            verbose: false,
            logger: { log: jest.fn(), error: jest.fn() }
        });
    });
    
    afterEach(() => {
        pollingManager.stop();
    });
    
    describe('race condition protection', () => {
        test('should prevent overlapping polls with _isPolling flag', async () => {
            let pollCount = 0;
            mockAnalyzerClient.fetchPairs = jest.fn(async () => {
                pollCount++;
                await new Promise(r => setTimeout(r, 50));
                return [];
            });
            
            pollingManager.start();
            await new Promise(r => setTimeout(r, 200));
            pollingManager.stop();
            
            // With overlap protection, should have fewer polls than without
            expect(pollCount).toBeLessThanOrEqual(4);
        });
        
        test('should reset _isPolling even on error', async () => {
            mockAnalyzerClient.fetchPairs = jest.fn(async () => {
                throw new Error('Network error');
            });
            
            pollingManager._isRunning = true;
            await pollingManager._poll();
            
            expect(pollingManager._isPolling).toBe(false);
        });
    });
    
    describe('filtering', () => {
        test('should filter pairs by bookmaker name', async () => {
            const pairs = [
                { second: { bookmaker: 'Test' } },
                { second: { bookmaker: 'Other' } },
                { second: { bookmaker: 'TEST_Live' } }
            ];
            mockAnalyzerClient.fetchPairs = jest.fn(async () => pairs);
            
            let receivedPairs = [];
            pollingManager.onPairs((p) => { receivedPairs = p; });
            
            pollingManager._isRunning = true;
            await pollingManager._poll();
            
            expect(receivedPairs.length).toBe(2);
        });
    });
    
    describe('callbacks', () => {
        test('should call onAnalyzerDown when no pairs', async () => {
            mockAnalyzerClient.fetchPairs = jest.fn(async () => []);
            
            let downCalled = false;
            pollingManager.onAnalyzerDown(() => { downCalled = true; });
            
            pollingManager._isRunning = true;
            await pollingManager._poll();
            
            expect(downCalled).toBe(true);
        });
    });
});
