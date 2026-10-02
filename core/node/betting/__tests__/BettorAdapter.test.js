/**
 * Tests for BettorAdapter base class
 */

const { BettorAdapter, BetErrorTypes } = require('../BettorAdapter.js');

describe('BettorAdapter', () => {
    let adapter;
    
    beforeEach(() => {
        adapter = new BettorAdapter({ bookmakerName: 'TestBookmaker' });
    });
    
    describe('parseError', () => {
        test('should detect odds changed errors', () => {
            const testCases = [
                { error: 'Odds have changed' },
                { error: 'Kvota je promenjena' },
                { error: 'coefficient changed' },
                { error: 'SBV_CHANGED error' },
            ];
            
            testCases.forEach(response => {
                const result = adapter.parseError(response);
                expect(result.type).toBe(BetErrorTypes.ODDS_CHANGED);
                expect(result.retryable).toBe(true);
            });
        });
        
        test('should detect match closed errors', () => {
            const testCases = [
                { error: 'Match is closed' },
                { error: 'Market suspended' },
                { error: 'Zatvoreno za klađenje' },
                { error: 'Utakmica završena' },
                { error: 'Tip nije dozvoljen za klađenje Supra du Quebec : Pacific FC<br/> [PK.4]' },
            ];
            
            testCases.forEach(response => {
                const result = adapter.parseError(response);
                expect(result.type).toBe(BetErrorTypes.MATCH_CLOSED);
                expect(result.retryable).toBe(false);
            });
        });
        
        test('should detect balance errors', () => {
            const testCases = [
                { error: 'Insufficient balance' },
                { error: 'Nema dovoljno sredstava' },
                { error: 'Nemate dovoljno sredstva na računu' },
                { error: 'Balance too low' },
            ];
            
            testCases.forEach(response => {
                const result = adapter.parseError(response);
                expect(result.type).toBe(BetErrorTypes.INSUFFICIENT_BALANCE);
                expect(result.retryable).toBe(false);
            });
        });
        
        test('should detect session errors', () => {
            const testCases = [
                { error: 'Session expired' },
                { error: '401 Unauthorized' },
                { error: 'Token invalid' },
                { error: 'Prijavite se ponovo' },
            ];
            
            testCases.forEach(response => {
                const result = adapter.parseError(response);
                expect(result.type).toBe(BetErrorTypes.SESSION_EXPIRED);
                expect(result.retryable).toBe(true);
            });
        });
        
        test('should detect limit exceeded errors', () => {
            const testCases = [
                { error: 'Limit exceeded' },
                { error: 'Maximum stake reached' },
                { error: 'Maksimalni ulog' },
            ];
            
            testCases.forEach(response => {
                const result = adapter.parseError(response);
                expect(result.type).toBe(BetErrorTypes.LIMIT_EXCEEDED);
                expect(result.retryable).toBe(false);
            });
        });
        
        test('should return unknown for unrecognized errors', () => {
            const result = adapter.parseError({ error: 'Some random error' });
            expect(result.type).toBe(BetErrorTypes.UNKNOWN);
            expect(result.retryable).toBe(false);
        });
    });
    
    describe('validateOdds', () => {
        test('should pass when odds match', () => {
            const result = adapter.validateOdds(2.50, 2.50);
            expect(result.valid).toBe(true);
            expect(result.diff).toBe(0);
        });
        
        test('should pass when within threshold', () => {
            const result = adapter.validateOdds(2.505, 2.50);
            expect(result.valid).toBe(true);
            expect(result.diff).toBeCloseTo(0.005);
        });
        
        test('should fail when outside threshold', () => {
            const result = adapter.validateOdds(2.55, 2.50);
            expect(result.valid).toBe(false);
            expect(result.diff).toBeCloseTo(0.05);
            expect(result.error).toContain('Odds changed');
        });
        
        test('should handle null values gracefully', () => {
            expect(adapter.validateOdds(null, 2.50).valid).toBe(true);
            expect(adapter.validateOdds(2.50, null).valid).toBe(true);
        });
        
        test('should respect custom threshold', () => {
            const result = adapter.validateOdds(2.55, 2.50, 0.1);
            expect(result.valid).toBe(true);
        });
    });
    
    describe('exactNameMatch', () => {
        test('should match exact names', () => {
            expect(adapter.exactNameMatch('Real Madrid', 'Real Madrid')).toBe(true);
        });
        
        test('should NOT match partial names', () => {
            expect(adapter.exactNameMatch('Real Madrid CF', 'Real Madrid')).toBe(false);
            expect(adapter.exactNameMatch('Real Madrid', 'Real Madrid CF')).toBe(false);
        });
        
        test('should be case insensitive', () => {
            expect(adapter.exactNameMatch('REAL MADRID', 'real madrid')).toBe(true);
        });
        
        test('should handle dots and spaces normalization', () => {
            // After normalization: "fc porto" === "fc porto"
            expect(adapter.exactNameMatch('F.C. Porto', 'FC Porto')).toBe(true);
        });
        
        test('should reject non-matching names', () => {
            expect(adapter.exactNameMatch('Real Madrid', 'Barcelona')).toBe(false);
        });
        
        test('should reject similar but not identical names', () => {
            expect(adapter.exactNameMatch('Real', 'Real Madrid')).toBe(false);
            expect(adapter.exactNameMatch('Real Sociedad', 'Real Madrid')).toBe(false);
        });
    });
    
    describe('normalizeName', () => {
        test('should lowercase', () => {
            expect(adapter.normalizeName('REAL MADRID')).toBe('real madrid');
        });
        
        test('should remove dots', () => {
            expect(adapter.normalizeName('F.C. Porto')).toBe('fc porto');
        });
        
        test('should collapse multiple spaces', () => {
            expect(adapter.normalizeName('Real   Madrid')).toBe('real madrid');
        });
        
        test('should handle null/undefined', () => {
            expect(adapter.normalizeName(null)).toBe('');
            expect(adapter.normalizeName(undefined)).toBe('');
        });
    });
    
    describe('getOutcomeType', () => {
        test('should extract total types', () => {
            expect(adapter.getOutcomeType('T> 2.5')).toBe('T>');
            expect(adapter.getOutcomeType('T< 3.5')).toBe('T<');
        });
        
        test('should extract team total types', () => {
            expect(adapter.getOutcomeType('IT1> 1.5')).toBe('IT1>');
            expect(adapter.getOutcomeType('IT2< 2.5')).toBe('IT2<');
        });
        
        test('should extract handicap types', () => {
            expect(adapter.getOutcomeType('H1 -1.5')).toBe('H1');
            expect(adapter.getOutcomeType('H2 2.5')).toBe('H2');
        });
        
        test('should extract 1X2 types', () => {
            expect(adapter.getOutcomeType('1')).toBe('1');
            expect(adapter.getOutcomeType('X')).toBe('X');
            expect(adapter.getOutcomeType('2')).toBe('2');
        });
        
        test('should extract period-specific types', () => {
            expect(adapter.getOutcomeType('P1T> 0.5')).toBe('P1T>');
            expect(adapter.getOutcomeType('P2IT1< 1.5')).toBe('P2IT1<');
            expect(adapter.getOutcomeType('P3H1 -2.5')).toBe('P3H1');
        });
    });
});
