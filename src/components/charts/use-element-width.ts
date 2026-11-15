"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The content width of an element, kept up to date with a ResizeObserver.
 * Zero until mounted, so a chart renders a fixed-height placeholder on the
 * server and draws only in the browser (Recharts draws SVG from a measured
 * width; the hit layer and end labels use the same number).
 */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setWidth(Math.floor(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}
