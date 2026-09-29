"use client";

import { useEffect, useRef, useState } from "react";
import { MoveHorizontal } from "lucide-react";

/**
 * Mobile-friendly data table wrapper.
 *
 * Keeps EVERY column available on phones by scrolling horizontally rather
 * than hiding data, while making the table usable:
 *   - sticky header row (column headers stay visible while scrolling)
 *   - sticky first column (the symbol is always in view)
 *   - an animated swipe hint on touch devices that fades out after use
 *
 * The parent supplies the <table> itself so existing markup is unchanged;
 * this component only supplies the scroll container and chrome.
 */
export function DataTable({
  children,
  minWidthClass = "min-w-[900px]",
  className = "",
}: {
  children: React.ReactNode;
  minWidthClass?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hinted, setHinted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollLeft > 24) setHinted(true);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="dt-wrap">
      <div className={`dt-hint ${hinted ? "is-hidden" : ""}`}>
        <MoveHorizontal className="h-3.5 w-3.5" />
        <span>swipe to see all columns</span>
      </div>
      <div ref={ref} className={`scrollable-x ${className}`}>
        {children}
      </div>
    </div>
  );
}

/** Applies the sticky-table classes to a <table> element. */
export function dtTableClass(minWidthClass: string): string {
  return `dt ${minWidthClass} w-full text-[11px]`;
}
