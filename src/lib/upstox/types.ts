/** Raw Upstox API response types (v2 quotes/options, v3 candles, instruments). */

/* ------------------------- Instrument master ------------------------- */

export interface UpstoxInstrument {
  segment?: string;
  name?: string;
  exchange?: string;
  isin?: string;
  instrument_type?: string;
  instrument_key?: string;
  exchange_token?: string;
  trading_symbol?: string;
  short_name?: string;
  expiry?: number | string;
  strike_price?: number;
  tick_size?: number;
  lot_size?: number;
  freeze_quantity?: number;
  underlying_key?: string;
  underlying_symbol?: string;
  underlying_type?: string;
  weekly?: boolean;
  option_type?: string;
}

/* ----------------------------- V3 candles ----------------------------- */

export interface V3CandleResponse {
  status: string;
  data?: {
    candles?: [string, number, number, number, number, number, number][];
  };
}

/* ------------------------- V2 full market quote ------------------------ */

export interface FullMarketQuote {
  instrument_token?: string;
  symbol?: string;
  last_price?: number;
  last_quantity?: number;
  average_price?: number;
  volume?: number;
  net_change?: number;
  oi?: number | boolean;
  ohlc?: { open?: number; high?: number; low?: number; close?: number };
  depth?: {
    buy?: { price: number; quantity: number; orders: number }[];
    sell?: { price: number; quantity: number; orders: number }[];
  };
  lower_circuit_limit?: number | null;
  upper_circuit_limit?: number | null;
  last_trade_time?: string;
  timestamp?: string;
  oi_day_high?: number;
  oi_day_low?: number;
  total_buy_quantity?: number;
  total_sell_quantity?: number;
}

export interface FullQuoteResponse {
  status: string;
  data?: Record<string, FullMarketQuote>;
}

/* ----------------------------- Option chain ---------------------------- */

export interface OptionSideData {
  instrument_key?: string;
  market_data?: {
    ltp?: number;
    volume?: number;
    oi?: number;
    prev_oi?: number;
    bid_price?: number;
    ask_price?: number;
    close_price?: number;
  };
  option_greeks?: Record<string, number>;
}

export interface OptionChainStrike {
  expiry?: string;
  pcr?: number;
  strike_price?: number;
  underlying_key?: string;
  underlying_spot_price?: number;
  call_options?: OptionSideData;
  put_options?: OptionSideData;
}

export interface OptionChainResponse {
  status: string;
  data?: OptionChainStrike[];
}

export interface OptionContract {
  expiry?: string;
  instrument_key?: string;
  trading_symbol?: string;
  strike_price?: number;
  instrument_type?: string;
  underlying_symbol?: string;
  weekly?: boolean;
}

export interface OptionContractsResponse {
  status: string;
  data?: OptionContract[];
}

/* ------------------------------ Profiles ------------------------------ */

export interface UserProfileResponse {
  status: string;
  data?: {
    user_id?: string;
    user_name?: string;
    email?: string;
    broker?: string;
    exchanges?: string[];
    products?: string[];
  };
}

export interface MarketStatusResponse {
  status: string;
  data?: { exchange?: string; status?: string } | Record<string, unknown>[];
}
