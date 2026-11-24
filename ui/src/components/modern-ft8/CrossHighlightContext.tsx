import { createContext } from "preact";
import type { RefObject } from "preact";
import { useContext } from "preact/hooks";
import type { HoverState } from "./types";

export interface CrossHighlightContextValue {
  hover: HoverState;
  hoverRef: RefObject<HoverState>;
  setHovered: (callsign: string | null, hz: number | null, color: string | null) => void;
}

const DEFAULT_HOVER: HoverState = {
  hoveredCallsign: null,
  hoveredFreqHz: null,
  hoveredColor: null,
};

export const CrossHighlightContext = createContext<CrossHighlightContextValue>({
  hover: DEFAULT_HOVER,
  hoverRef: { current: DEFAULT_HOVER },
  setHovered: () => {},
});

export function useCrossHighlight(): CrossHighlightContextValue {
  return useContext(CrossHighlightContext);
}
