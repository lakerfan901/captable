"use client";

import { useEffect } from "react";

/**
 * While `dirty`, closing or reloading the tab (or following a plain link out
 * of the app) asks the browser's "Leave site? Changes you made may not be
 * saved" question. In-app client navigations are not covered: guard those
 * links with `confirmDiscard`.
 */
export function useUnsavedChangesGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers need a returnValue to show the prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}

/** For an in-app link or button that would drop unsaved changes: true to go on. */
export function confirmDiscard(dirty: boolean): boolean {
  return (
    !dirty ||
    window.confirm("You have unsaved changes. Leave without saving them?")
  );
}
