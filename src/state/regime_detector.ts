import { now } from '../utils/time.js';
import type { RegimeState } from './types.js';

/**
 * Stub regime detector — returns "normal" regime with full confidence.
 * Real implementation (HMM-style classification from feature z-scores)
 * is built in Phase 3.
 */
export function detectRegime(): RegimeState {
  return {
    current_regime: 'normal',
    regime_since: now(),
    confidence: 1.0,
    features: {
      avg_spread_z_score: 0,
      volume_z_score: 0,
      wallet_activity_z_score: 0,
      resolution_rate: 0,
      new_market_rate: 0,
    },
  };
}
