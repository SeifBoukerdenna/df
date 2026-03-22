import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const CONFIG_DIR = resolve(PROJECT_ROOT, 'config');

// Load .env from project root
dotenvConfig({ path: resolve(PROJECT_ROOT, '.env') });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolymarketConfig {
  clob_ws_url: string;
  rest_url: string;
  gamma_url: string;
  fee_rate: number;
  chain_id: number;
  rpc_url: string;
}

export interface IngestionConfig {
  book_poll_interval_ms: number;
  metadata_poll_interval_ms: number;
  gas_poll_interval_ms: number;
  health_check_interval_ms: number;
  ws_reconnect_base_ms: number;
  ws_reconnect_max_ms: number;
  dedup_cache_ttl_ms: number;
  stale_data_threshold_ms: number;
  raw_events_dir: string;
  min_market_liquidity: number;
  max_markets: number;
}

export interface StateConfig {
  market_graph_rebuild_interval_ms: number;
  regime_detection_interval_ms: number;
  volatility_windows_ms: number[];
  autocorrelation_window_ms: number;
  snapshots_dir: string;
  snapshot_interval_ms: number;
}

export interface LedgerConfig {
  dir: string;
  rotation_interval_ms: number;
  snapshot_interval_ms: number;
  checksum_algorithm: string;
}

export interface FeaturesConfig {
  dir: string;
  capture_interval_ms: number;
}

export interface ResearchConfig {
  dir: string;
  min_sample_size: number;
  significance_level: number;
  walk_forward_training_days: number;
  walk_forward_test_days: number;
  walk_forward_step_days: number;
  min_trades_per_window: number;
  oos_degradation_limit: number;
  parameter_perturbation_pct: number;
  min_oos_sharpe: number;
  decay_check_interval_days: number;
  decay_sharpe_warn_threshold: number;
  decay_sharpe_retire_threshold: number;
  exploration_budget_min_pct: number;
  exploration_budget_max_pct: number;
  target_portfolio_sharpe: number;
}

export interface RiskConfig {
  max_position_pct: number;
  max_total_exposure_pct: number;
  max_daily_loss_pct: number;
  max_drawdown_pct: number;
  max_single_trade_loss_pct: number;
  max_correlated_exposure_pct: number;
  max_strategy_concentration_pct: number;
  max_single_event_exposure_pct: number;
  drawdown_tier_1_pct: number;
  drawdown_tier_1_size_reduction: number;
  drawdown_tier_2_pct: number;
  drawdown_tier_2_size_reduction: number;
  drawdown_tier_3_pct: number;
  drawdown_tier_4_pct: number;
  kelly_fraction: number;
  min_confidence_scalar_trades: number;
  correlation_limit: number;
  cluster_correlation_limit: number;
  regime_unknown_size_reduction: number;
}

export interface LatencyBudgetConfig {
  signal_to_plan_ms: number;
  plan_to_submit_ms: number;
  submit_to_ack_ms: number;
  ack_to_first_fill_ms: number;
  end_to_end_ms: number;
  alert_signal_to_plan_ms: number;
  alert_plan_to_submit_ms: number;
  alert_submit_to_ack_ms: number;
  alert_ack_to_first_fill_ms: number;
  alert_end_to_end_ms: number;
}

export interface ExecutionConfig {
  min_viable_size: number;
  cancel_repost_interval_ms: number;
  stale_order_timeout_ms: number;
  book_thin_threshold_pct: number;
  spread_widened_threshold_factor: number;
  latency_budget: LatencyBudgetConfig;
}

export interface StrategyConfig {
  enabled: boolean;
  paper_only: boolean;
  capital_allocation: number;
  max_position_size: number;
  min_ev_threshold: number;
  max_concurrent_positions: number;
  cooldown_after_loss_ms: number;
  allowed_regimes: string[];
  min_statistical_confidence_t: number;
  max_parameter_sensitivity: number;
  signal_half_life_ms: number;
  [key: string]: unknown;
}

export interface StrategiesConfig {
  wallet_follow: StrategyConfig;
  complement_arb: StrategyConfig;
  book_imbalance: StrategyConfig;
  large_trade_reaction: StrategyConfig;
  stale_book: StrategyConfig;
  cross_market_consistency: StrategyConfig;
  microprice_dislocation: StrategyConfig;
}

export interface AnalyticsConfig {
  metrics_update_interval_ms: number;
  rolling_sharpe_windows_days: number[];
  pnl_snapshot_interval_ms: number;
}

export interface WalletIntelConfig {
  tracked_wallets: string[];
  classification_min_trades: number;
  sniper_max_hold_seconds: number;
  swing_min_hold_seconds: number;
  swing_min_sharpe: number;
  noise_max_sharpe: number;
  delay_buckets_seconds: number[];
  min_significance_p: number;
  recency_window_days: number;
}

export interface LoggingConfig {
  level: string;
  pretty: boolean;
}

export interface Config {
  paper_mode: boolean;
  polymarket: PolymarketConfig;
  ingestion: IngestionConfig;
  state: StateConfig;
  ledger: LedgerConfig;
  features: FeaturesConfig;
  research: ResearchConfig;
  risk: RiskConfig;
  execution: ExecutionConfig;
  strategies: StrategiesConfig;
  analytics: AnalyticsConfig;
  wallet_intel: WalletIntelConfig;
  logging: LoggingConfig;
  // Secrets — populated from env, never from files
  secrets: {
    private_key: string | null;
    api_key: string | null;
    api_secret: string | null;
    api_passphrase: string | null;
    relayer_api_key: string | null;
    wallet_address: string | null;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadJson(filePath: string): Record<string, unknown> {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Deep-merges `override` into `base`. Arrays are replaced, not concatenated.
 * Returns a new object — neither argument is mutated.
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overrideVal = override[key];

    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      result[key] = overrideVal;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const REQUIRED_STRING_PATHS: string[] = [
  'polymarket.clob_ws_url',
  'polymarket.rest_url',
  'polymarket.rest_url',
  'ledger.dir',
  'ingestion.raw_events_dir',
  'state.snapshots_dir',
];

const REQUIRED_NUMBER_PATHS: string[] = [
  'polymarket.fee_rate',
  'risk.max_position_pct',
  'risk.max_total_exposure_pct',
  'risk.max_daily_loss_pct',
  'risk.max_drawdown_pct',
];

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
      return (cur as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function validateConfig(raw: Record<string, unknown>): void {
  const errors: string[] = [];

  for (const path of REQUIRED_STRING_PATHS) {
    const val = getNestedValue(raw, path);
    if (typeof val !== 'string' || val.trim() === '') {
      errors.push(`Config missing required string: ${path}`);
    }
  }

  for (const path of REQUIRED_NUMBER_PATHS) {
    const val = getNestedValue(raw, path);
    if (typeof val !== 'number' || !isFinite(val)) {
      errors.push(`Config missing required number: ${path}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n  ${errors.join('\n  ')}`);
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function loadConfig(): Config {
  const env = process.env['NODE_ENV'] ?? 'development';

  const base = loadJson(`${CONFIG_DIR}/default.json`);
  const envOverride = loadJson(`${CONFIG_DIR}/${env}.json`);
  const merged = deepMerge(base, envOverride);

  validateConfig(merged);

  const config = merged as unknown as Config;

  // RPC URL may contain an API key — load from env if set, fall back to config file.
  if (process.env['POLYMARKET_RPC_URL']) {
    config.polymarket.rpc_url = process.env['POLYMARKET_RPC_URL'];
  }

  // Secrets come exclusively from env vars — never from config files.
  // Supports both POLYMARKET_* env vars and .env-style keys (apiKey, secret, passphrase).
  config.secrets = {
    private_key: process.env['POLYMARKET_PRIVATE_KEY'] ?? null,
    api_key: process.env['POLYMARKET_API_KEY'] ?? process.env['apiKey'] ?? null,
    api_secret: process.env['POLYMARKET_API_SECRET'] ?? process.env['secret'] ?? null,
    api_passphrase: process.env['POLYMARKET_API_PASSPHRASE'] ?? process.env['passphrase'] ?? null,
    relayer_api_key: process.env['relayer_api_key'] ?? null,
    wallet_address: process.env['adress'] ?? process.env['POLYMARKET_WALLET_ADDRESS'] ?? null,
  };

  // Auto-add wallet address to tracked wallets if not already present
  if (config.secrets.wallet_address && !config.wallet_intel.tracked_wallets.includes(config.secrets.wallet_address)) {
    config.wallet_intel.tracked_wallets.push(config.secrets.wallet_address);
  }

  return config;
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const config: Config = loadConfig();
