/**
 * Tests for LimitsManager
 */

const { LimitsManager } = require('../LimitsManager.js');

describe('LimitsManager', () => {
    let manager;
    
    beforeEach(() => {
        manager = new LimitsManager({
            maxBets: 5,
            maxSuccessful: 3,
            maxBetsPerMatch: 2,
            maxStakePerBet: null,
            maxStakePerStrategy: 10
        });
    });
    
    describe('Goal Limits', () => {
        test('should allow bets when under limits', () => {
            const result = manager.checkGoalLimits();
            expect(result.allowed).toBe(true);
        });
        
        test('should block when max attempts reached', () => {
            manager.betAttempts = 5;
            const result = manager.checkGoalLimits();
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('attempts');
        });
        
        test('should block when max successful reached', () => {
            manager.betsPlaced = 3;
            const result = manager.checkGoalLimits();
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('successful');
        });
        
        test('should increment counters correctly', () => {
            expect(manager.betAttempts).toBe(0);
            expect(manager.betsPlaced).toBe(0);
            
            manager.recordAttempt();
            expect(manager.betAttempts).toBe(1);
            
            manager.recordSuccess();
            expect(manager.betsPlaced).toBe(1);
        });
    });
    
    describe('Match Key Generation', () => {
        test('should normalize match keys', () => {
            const key1 = manager.generateMatchKey('Real Madrid', 'Barcelona');
            const key2 = manager.generateMatchKey('real-madrid', 'barcelona');
            expect(key1).toBe(key2);
        });
        
        test('should handle special characters', () => {
            const key = manager.generateMatchKey('F.C. Porto', 'S.L. Benfica');
            expect(key).toBe('fcporto_slbenfica');
        });
    });
    
    describe('Local Limits', () => {
        test('should allow first bet on match', () => {
            const result = manager.checkLocalLimits('match1', 'fast', 5);
            expect(result.allowed).toBe(true);
            expect(result.adjustedStake).toBe(5);
        });
        
        test('should block when match bet limit reached', () => {
            manager.recordBet('match1', 'T>2.5', 'fast', 5);
            manager.recordBet('match1', 'H1-1.5', 'slow', 5);
            
            const result = manager.checkLocalLimits('match1', 'fast', 5);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Match limit');
        });
        
        test('should block when strategy stake limit reached', () => {
            manager.recordBet('match1', 'T>2.5', 'fast', 10);
            
            const result = manager.checkLocalLimits('match1', 'fast', 5);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Strategy stake');
        });
        
        test('should adjust stake to remaining amount', () => {
            manager.recordBet('match1', 'T>2.5', 'fast', 7);
            
            const result = manager.checkLocalLimits('match1', 'fast', 5);
            expect(result.allowed).toBe(true);
            expect(result.adjustedStake).toBe(3); // 10 - 7 = 3
        });

        test('should allow per-strategy override for telegram sources', () => {
            manager.recordBet('match1', 'T>2.5', 'telegram_vip', 7);

            const result = manager.checkLocalLimits('match1', 'telegram_vip', 5, {
                maxStakePerStrategy: 12
            });

            expect(result.allowed).toBe(true);
            expect(result.adjustedStake).toBe(5);
        });

        test('should respect per-task max bets per match override', () => {
            manager.recordBet('match1', 'T>2.5', 'telegram_vip', 5);
            manager.recordBet('match1', '1', 'telegram_regular', 5);

            const result = manager.checkLocalLimits('match1', 'telegram_vip', 5, {
                maxBetsPerMatch: 2
            });

            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Match limit');
        });

        test('should allow two telegram bets with 5 per bet and 10 total per match', () => {
            const first = manager.checkLocalLimits('match1', 'telegram_default', 10, {
                maxStakePerBet: 5,
                maxStakePerStrategy: 10,
                maxBetsPerMatch: 2
            });

            expect(first.allowed).toBe(true);
            expect(first.adjustedStake).toBe(5);
            manager.recordBet('match1', '1', 'telegram_default', first.adjustedStake);

            const second = manager.checkLocalLimits('match1', 'telegram_default', 10, {
                maxStakePerBet: 5,
                maxStakePerStrategy: 10,
                maxBetsPerMatch: 2
            });

            expect(second.allowed).toBe(true);
            expect(second.adjustedStake).toBe(5);
            manager.recordBet('match1', '2', 'telegram_default', second.adjustedStake);

            const third = manager.checkLocalLimits('match1', 'telegram_default', 10, {
                maxStakePerBet: 5,
                maxStakePerStrategy: 10,
                maxBetsPerMatch: 2
            });

            expect(third.allowed).toBe(false);
            expect(third.reason).toContain('Match limit');
        });
    });
    
    describe('Bet Recording', () => {
        test('should record bets in history', () => {
            manager.recordBet('match1', 'T>2.5', 'fast', 5);
            
            const stats = manager.getMatchStats('match1', 'fast');
            expect(stats.count).toBe(1);
            expect(stats.totalStaked).toBe(5);
            expect(stats.hasBetForSource).toBe(true);
        });
        
        test('should track multiple bets on same match', () => {
            manager.recordBet('match1', 'T>2.5', 'fast', 5);
            manager.recordBet('match1', 'H1-1.5', 'slow', 6);
            
            const stats = manager.getMatchStats('match1');
            expect(stats.count).toBe(2);
            expect(stats.totalStaked).toBe(11);
        });
    });
    
    describe('State Persistence', () => {
        test('should save and restore state', () => {
            manager.betAttempts = 3;
            manager.betsPlaced = 2;
            
            const state = manager.getState();
            expect(state.betAttempts).toBe(3);
            expect(state.betsPlaced).toBe(2);
            
            const newManager = new LimitsManager({});
            newManager.restoreState(state);
            
            expect(newManager.betAttempts).toBe(3);
            expect(newManager.betsPlaced).toBe(2);
        });
    });
});
