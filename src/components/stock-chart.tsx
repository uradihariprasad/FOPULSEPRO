"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  LineStyle,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, SRZone, TradePlan } from "@/lib/engine/types";
import { bollingerSeries, ema, vwapSeries } from "@/lib/engine/indicators";

export interface ChartLineSpec {
  price: number;
  color: string;
  title: string;
  style?: "solid" | "dashed" | "dotted";
}

function heightFor(w: number): number {
  if (w < 560) return 300;
  if (w < 1024) return 380;
  return 460;
}

/** ADDITIVE: dynamic S/R zone band drawn on the chart with hover details. */
export interface DynamicZoneBand {
  id: string;
  side: "SUPPORT" | "RESISTANCE";
  /** exact S/R price (market-confirmed level or OI dynamic center) */
  level: number;
  low: number;
  high: number;
  confidence: number;
  statusLabel: string;
  tests: number;
  volume: string;
  futures: string;
  options: string;
}

export function StockChart({
  candles,
  zones,
  optionLines,
  plan,
  dynamicZones = [],
}: {
  candles: Candle[];
  zones: SRZone[];
  optionLines: ChartLineSpec[];
  plan: TradePlan | null;
  dynamicZones?: DynamicZoneBand[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverZone, setHoverZone] = useState<{ z: DynamicZoneBand; x: number; y: number } | null>(null);
  const dynRef = useRef<DynamicZoneBand[]>(dynamicZones);
  dynRef.current = dynamicZones;
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    candle: ISeriesApi<"Candlestick"> | null;
    volume: ISeriesApi<"Histogram"> | null;
    lines: ISeriesApi<"Line">[];
  }>({ candle: null, volume: null, lines: [] });
  const priceLinesRef = useRef<ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]>[]>([]);

  const prepared = useMemo(() => {
    const bars = candles
      .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.o))
      .map((c) => ({
        time: Math.floor(c.t / 1000) as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        value: c.v,
      }));
    // de-dup by time (exchange can resend)
    const seen = new Set<number>();
    const uniq = bars.filter((b) => (seen.has(b.time as number) ? false : (seen.add(b.time as number), true)));
    const closes = uniq.map((b) => b.close);
    const e9 = ema(closes, 9);
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    const vw = vwapSeries(candles.length === uniq.length ? candles : candles.slice(0, uniq.length));
    const bb = bollingerSeries(closes, 20, 2);
    const map = (arr: (number | null)[]) =>
      uniq.flatMap((b, i) => (arr[i] != null ? [{ time: b.time, value: arr[i] as number }] : []));
    return {
      uniq,
      volume: uniq.map((b) => ({
        time: b.time,
        value: b.value,
        color: b.close >= b.open ? "rgba(52,211,153,0.35)" : "rgba(251,113,133,0.35)",
      })),
      ema9: map(e9),
      ema20: map(e20),
      ema50: map(e50),
      vwap: map(vw),
      bbU: uniq.flatMap((b, i) => (bb[i] ? [{ time: b.time, value: bb[i]!.upper }] : [])),
      bbL: uniq.flatMap((b, i) => (bb[i] ? [{ time: b.time, value: bb[i]!.lower }] : [])),
    };
  }, [candles]);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8b9dbd",
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(22,32,58,0.5)" },
        horzLines: { color: "rgba(22,32,58,0.5)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#16203a" },
      timeScale: {
        borderColor: "#16203a",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (t: number) => {
          const d = new Date(t * 1000);
          return new Intl.DateTimeFormat("en-IN", {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(d);
        },
      },
      width: ref.current.clientWidth,
      height: heightFor(ref.current.clientWidth),
    });
    chartRef.current = chart;

    const volume = chart.addHistogramSeries({
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#34d399",
      downColor: "#fb7185",
      borderUpColor: "#34d399",
      borderDownColor: "#fb7185",
      wickUpColor: "rgba(52,211,153,0.7)",
      wickDownColor: "rgba(251,113,133,0.7)",
    });
    seriesRef.current.candle = candleSeries;
    seriesRef.current.volume = volume;

    const mkLine = (color: string, width: 1 | 2 = 1, style: LineStyle = LineStyle.Solid) => {
      const s = chart.addLineSeries({ color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      seriesRef.current.lines.push(s);
      return s;
    };
    const [ema9s, ema20s, ema50s, vwaps, bbUs, bbLs] = [
      mkLine("#38bdf8"),
      mkLine("#a78bfa"),
      mkLine("#fbbf24"),
      mkLine("#f0f6ff", 2, LineStyle.Dashed),
      mkLine("rgba(139,157,189,0.5)"),
      mkLine("rgba(139,157,189,0.5)"),
    ];

    const onResize = () => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth, height: heightFor(ref.current.clientWidth) });
    };
    window.addEventListener("resize", onResize);

    // ADDITIVE: hover tooltip for dynamic S/R zones (confidence + sources)
    chart.subscribeCrosshairMove((param) => {
      const price = param.point && candleSeries
        ? candleSeries.coordinateToPrice(param.point.y)
        : null;
      if (price == null || !param.point) {
        setHoverZone(null);
        return;
      }
      const hit = dynRef.current.find((z) => price >= z.low && price <= z.high);
      setHoverZone(hit ? { z: hit, x: param.point.x, y: param.point.y } : null);
    });

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = { candle: null, volume: null, lines: [] };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const c = seriesRef.current.candle;
    if (!c) return;
    const [ema9s, ema20s, ema50s, vwaps, bbUs, bbLs] = seriesRef.current.lines;
    c.setData(prepared.uniq);
    seriesRef.current.volume?.setData(prepared.volume);
    ema9s?.setData(prepared.ema9);
    ema20s?.setData(prepared.ema20);
    ema50s?.setData(prepared.ema50);
    vwaps?.setData(prepared.vwap);
    bbUs?.setData(prepared.bbU);
    bbLs?.setData(prepared.bbL);

    // price lines: zones, option strikes, plan levels
    for (const pl of priceLinesRef.current) c.removePriceLine(pl);
    priceLinesRef.current = [];
    const addPL = (price: number | null | undefined, color: string, title: string, style: LineStyle = LineStyle.Solid) => {
      if (price == null || !Number.isFinite(price)) return;
      const pl = c.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
      priceLinesRef.current.push(pl);
    };
    for (const z of zones.slice(0, 5)) {
      addPL(z.center, z.kind === "SUPPORT" ? "#34d399" : "#fb7185", `${z.id} ${z.strength}`, LineStyle.Dashed);
    }
    for (const ol of optionLines) {
      addPL(ol.price, ol.color, ol.title, LineStyle.Dotted);
    }
    if (plan) {
      addPL(plan.entryRef ?? plan.entryHigh, "#38bdf8", "ENTRY", LineStyle.Solid);
      addPL(plan.stop, "#fb7185", "SL", LineStyle.Solid);
      addPL(plan.target1, "#34d399", "T1", LineStyle.Solid);
      addPL(plan.target2, "#34d39966", "T2", LineStyle.Dotted);
    }

    // ADDITIVE: dynamic S/R drawn as ONE exact-price line per level —
    // stronger levels are bolder. (Zone bounds remain available on hover.)
    for (const z of dynamicZones) {
      const price = Number.isFinite(z.level) ? z.level : z.high;
      if (!Number.isFinite(price)) continue;
      const strong = z.confidence >= 75;
      const mid = z.confidence >= 55;
      const base = z.side === "SUPPORT" ? "52,211,153" : "251,113,133";
      const color = `rgba(${base},${strong ? 1 : mid ? 0.72 : 0.42})`;
      const w: 1 | 2 | 3 = strong ? 3 : mid ? 2 : 1;
      const pl = c.createPriceLine({
        price,
        color,
        lineWidth: w,
        lineStyle: strong ? LineStyle.Solid : LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${z.id} ${z.confidence}%`,
      });
      priceLinesRef.current.push(pl);
    }
    chartRef.current?.timeScale().scrollToRealTime();
  }, [prepared, zones, optionLines, plan, dynamicZones]);

  if (!candles.length) {
    return (
      <div className="flex h-[300px] md:h-[460px] items-center justify-center text-xs text-ink-faint px-4 text-center">
        INTRADAY CANDLE DATA UNAVAILABLE — chart appears once Upstox returns 1-minute candles for this symbol.
      </div>
    );
  }
  return (
    <div>
      <div ref={wrapRef} className="relative w-full">
        <div ref={ref} className="w-full" />
        {hoverZone && (
          <div
            className="pointer-events-none absolute z-20 rounded-lg border border-line-bright bg-panel/95 px-2.5 py-2 text-[10px] leading-4 shadow-xl backdrop-blur-sm"
            style={{
              left: Math.min(Math.max(hoverZone.x + 14, 4), (wrapRef.current?.clientWidth ?? 400) - 190),
              top: Math.max(hoverZone.y - 10, 4),
              width: 182,
            }}
          >
            <div className={`font-bold ${hoverZone.z.side === "SUPPORT" ? "text-profit" : "text-loss"}`}>
              {hoverZone.z.side === "SUPPORT" ? "Support" : "Resistance"} Level {hoverZone.z.id}
            </div>
            <div className="num text-ink text-[12px] font-bold">₹{hoverZone.z.level.toFixed(2)}</div>
            <div className="num text-[9px] text-ink-faint">zone {hoverZone.z.low.toFixed(2)}–{hoverZone.z.high.toFixed(2)}</div>
            <div className="mt-1 space-y-0.5 text-ink-dim num">
              <div>Confidence: <span className="text-ink font-bold">{hoverZone.z.confidence}%</span></div>
              <div>Tests: <span className="text-ink">{hoverZone.z.tests}</span></div>
              <div>Volume: <span className="text-ink">{hoverZone.z.volume}</span></div>
              <div>Futures: <span className="text-ink">{hoverZone.z.futures}</span></div>
              <div>Options: <span className="text-ink">{hoverZone.z.options}</span></div>
              <div>Status: <span className="text-info">{hoverZone.z.statusLabel}</span></div>
            </div>
          </div>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[9px] tracking-wider text-ink-faint">
        <LegendDot color="#38bdf8" label="EMA 9" />
        <LegendDot color="#a78bfa" label="EMA 20" />
        <LegendDot color="#fbbf24" label="EMA 50" />
        <LegendDot color="#f0f6ff" label="VWAP" />
        <LegendDot color="rgba(139,157,189,0.7)" label="BOLLINGER 20,2" />
        <LegendDot color="#34d399" label="S SUPPORT · · ·" />
        <LegendDot color="#fb7185" label="R RESISTANCE · · ·" />
        {dynamicZones.length > 0 && <span className="text-info">DYNAMIC ZONES — hover a band for confidence & confirmations</span>}
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-1.5 w-3 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
