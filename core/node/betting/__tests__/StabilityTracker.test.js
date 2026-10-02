const { StabilityTracker } = require('../StabilityTracker.js');

describe('StabilityTracker', () => {
    let tracker;
    
    beforeEach(() => {
        tracker = new StabilityTracker({
            fast: { durationSeconds: 1 },  // 1 sec for faster tests
            slow: { durationSeconds: 2 },
            minROI: 3,
            freshnessThreshold: 4000,  // 4 sec max gap
            verbose: false
        });
    });
    
    describe('ROI threshold tracking', () => {
        test('should not start tracking when ROI < minROI', () => {
            const result = tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 2,  // Below 3%
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            expect(result.tracker.lastGoodUpdateAt).toBeNull();
            expect(result.tracker.accumulatedStabilityMs).toBe(0);
        });
        
        test('should start tracking when ROI >= minROI', () => {
            const result = tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,  // Above 3%
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            expect(result.tracker.lastGoodUpdateAt).not.toBeNull();
            expect(result.tracker.accumulatedStabilityMs).toBe(0);  // First update - no accumulated time yet
        });
        
        test('should reset accumulated time when ROI drops below threshold', async () => {
            // First: ROI above threshold
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            await new Promise(r => setTimeout(r, 500));
            
            // Second: ROI still good, accumulates time
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            // Third: ROI drops - should reset
            const result = tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 2,  // Dropped below 3%
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            expect(result.tracker.lastGoodUpdateAt).toBeNull();
            expect(result.tracker.accumulatedStabilityMs).toBe(0);
        });
        
        test('should freeze accumulated time when market closes (odds = 0)', async () => {
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            await new Promise(r => setTimeout(r, 500));
            
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            const beforeClose = tracker.get(tracker.makeKey('match1', 'H1', 'fast')).accumulatedStabilityMs;

            const result = tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 0  // Market closed
            });
            
            expect(result.tracker.marketClosedSince).not.toBeNull();
            expect(result.tracker.accumulatedStabilityMs).toBe(beforeClose);
            expect(tracker.getStableTrackers().length).toBe(0);
        });
    });
    
    describe('accumulated stability (NEW LOGIC)', () => {
        test('should accumulate time between updates', async () => {
            // First update
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            await new Promise(r => setTimeout(r, 500));
            
            // Second update - should accumulate ~500ms
            const result = tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            expect(result.tracker.accumulatedStabilityMs).toBeGreaterThanOrEqual(400);
            expect(result.tracker.accumulatedStabilityMs).toBeLessThan(700);
        });
        
        test('should freeze accumulated time on first late update after data gap', async () => {
            // Create tracker with shorter freshness threshold for testing
            const shortTracker = new StabilityTracker({
                fast: { durationSeconds: 1 },
                minROI: 3,
                freshnessThreshold: 500,  // 0.5 sec max gap
                verbose: false
            });
            
            shortTracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            await new Promise(r => setTimeout(r, 300));
            
            // Second update - accumulates time
            shortTracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            // Wait too long (> 500ms threshold)
            await new Promise(r => setTimeout(r, 600));
            
            const beforeGap = shortTracker.get(shortTracker.makeKey('match1', 'H1', 'fast')).accumulatedStabilityMs;

            // Third update - gap too long, should FREEZE accumulated time
            const result = shortTracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            expect(result.tracker.dataGapSince).not.toBeNull();
            expect(result.tracker.accumulatedStabilityMs).toBe(beforeGap);
        });
        
        test('should become stable only after accumulating enough time', async () => {
            // First update
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                minUpdates: 2,
                odds: 1.5
            });
            
            await new Promise(r => setTimeout(r, 600));
            
            // Second update - ~600ms accumulated, not enough (need 1000ms)
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            expect(tracker.getStableTrackers().length).toBe(0);
            
            await new Promise(r => setTimeout(r, 600));
            
            // Third update - now ~1200ms accumulated, should be stable
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            expect(tracker.getStableTrackers().length).toBe(1);
        });
        
        test('should require minUpdates before becoming stable', async () => {
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                minUpdates: 3,  // Require 3 updates
                odds: 1.5
            });
            
            await new Promise(r => setTimeout(r, 600));
            
            // Only 2 updates, even though time accumulated
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            await new Promise(r => setTimeout(r, 600));
            
            // Still only 2 updates (but time > 1 sec)
            const stableTrackers = tracker.getStableTrackers();
            expect(stableTrackers.length).toBe(0);
            
            // Third update - now should be stable
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            expect(tracker.getStableTrackers().length).toBe(1);
        });
    });
    
    describe('fallback handling', () => {
        test('should promote fallback to value bet when ROI rises', () => {
            // Start as fallback (low ROI)
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 2,
                pair: {},
                outcomeData: {},
                type: 'fast',
                allowLowROI: true,
                odds: 1.5
            });
            
            // ROI rises above threshold
            const result = tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,  // Now above 3%
                pair: {},
                outcomeData: {},
                type: 'fast',
                odds: 1.5
            });
            
            expect(result.tracker.allowLowROI).toBe(false);
        });
    });

    describe('missing from poll handling', () => {
        test('should not remain stable while outcome is missing from poll', async () => {
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                minUpdates: 2,
                odds: 1.5
            });

            await new Promise(r => setTimeout(r, 600));

            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                minUpdates: 2,
                odds: 1.5
            });

            await new Promise(r => setTimeout(r, 600));

            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                minUpdates: 2,
                odds: 1.5
            });

            const key = tracker.makeKey('match1', 'H1', 'fast');
            expect(tracker.getStableTrackers().length).toBe(1);

            tracker.markMissingFromPoll(key);

            expect(tracker.get(key).missingFromPollSince).not.toBeNull();
            expect(tracker.getStableTrackers().length).toBe(0);
        });

        test('should preserve accumulated time and allow immediate bet on reappear within grace', async () => {
            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                minUpdates: 2,
                odds: 1.5
            });

            await new Promise(r => setTimeout(r, 600));

            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                minUpdates: 2,
                odds: 1.5
            });

            await new Promise(r => setTimeout(r, 600));

            tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                minUpdates: 2,
                odds: 1.5
            });

            const key = tracker.makeKey('match1', 'H1', 'fast');
            const accumulatedBeforeMissing = tracker.get(key).accumulatedStabilityMs;
            tracker.markMissingFromPoll(key);

            const result = tracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                minUpdates: 2,
                odds: 1.5
            });

            expect(result.tracker.missingFromPollSince).toBeNull();
            expect(result.tracker.accumulatedStabilityMs).toBe(accumulatedBeforeMissing);
            expect(tracker.getStableTrackers().length).toBe(1);
        });

        test('should reset after missing-from-poll grace expires', async () => {
            const shortTracker = new StabilityTracker({
                fast: { durationSeconds: 1 },
                minROI: 3,
                freshnessThreshold: 4000,
                missingPollGraceLive: 50,
                verbose: false
            });

            shortTracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                minUpdates: 2,
                odds: 1.5
            });

            await new Promise(r => setTimeout(r, 600));

            shortTracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                minUpdates: 2,
                odds: 1.5
            });

            const key = shortTracker.makeKey('match1', 'H1', 'fast');
            shortTracker.markMissingFromPoll(key);

            await new Promise(r => setTimeout(r, 80));

            const result = shortTracker.track({
                matchId: 'match1',
                outcome: 'H1',
                roi: 5,
                pair: {},
                outcomeData: {},
                type: 'fast',
                minUpdates: 2,
                odds: 1.5
            });

            expect(result.tracker.accumulatedStabilityMs).toBe(0);
            expect(result.tracker.updateCount).toBe(1);
            expect(shortTracker.getStableTrackers().length).toBe(0);
        });
    });
});
