import { useEffect, useState } from "react";

interface QuantityStepperProps {
  value: number | null;
  onChange: (value: number | null) => void;
  step?: number;
}

/**
 * Hoeveelheid-invoer die zowel snel tikken met een numeriek toetsenbord
 * ondersteunt (direct "25" intikken) als de +/- knoppen. Decimalen zijn
 * toegestaan omdat sommige eenheden (bv. meter) geen gehele getallen zijn.
 */
export function QuantityStepper({ value, onChange, step = 1 }: QuantityStepperProps) {
  const [text, setText] = useState(value === null ? "" : String(value));

  useEffect(() => {
    setText(value === null ? "" : String(value));
  }, [value]);

  function commit(nextText: string) {
    setText(nextText);
    const normalized = nextText.trim().replace(",", ".");
    if (normalized === "" || normalized === "-") {
      onChange(null);
      return;
    }
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      onChange(parsed);
    }
  }

  function adjust(delta: number) {
    const current = value ?? 0;
    const next = Math.max(0, roundToStep(current + delta, step));
    onChange(next);
  }

  return (
    <div className="quantity-stepper">
      <button
        type="button"
        className="quantity-stepper__button"
        onClick={() => adjust(-step)}
        aria-label="Minder"
      >
        −
      </button>
      <input
        className="quantity-stepper__input"
        type="text"
        inputMode="decimal"
        placeholder="0"
        value={text}
        onChange={(e) => commit(e.target.value)}
      />
      <button
        type="button"
        className="quantity-stepper__button"
        onClick={() => adjust(step)}
        aria-label="Meer"
      >
        +
      </button>
    </div>
  );
}

function roundToStep(value: number, step: number): number {
  const precision = step < 1 ? String(step).split(".")[1]?.length ?? 0 : 0;
  return Number(value.toFixed(precision));
}
