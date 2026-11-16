"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The content width of an element, kept up to date with a ResizeObserver.
 * Zero until mounted, so a chart renders a fixed-height placeholder on the
 * server and draws only in the browser (Recharts draws SVG from a measured
 * width; the hit layer and end labels use the same number).
 *
 * A callback ref: when the element is replaced (a chart switched to its
 * Table view and back mounts a new plot box), the new one is measured and
 * observed, so the chart draws again.
 */
export function useElementWidth<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  const ref = useCallback((el: T | null) => setElement(el), []);
  useEffect(() => {
    if (!element) return;
    const measure = () =>
      setWidth(Math.floor(element.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(element);
    return () => ro.disconnect();
  }, [element]);
  return { ref, width };
}
