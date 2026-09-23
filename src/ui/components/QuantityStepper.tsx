import { useEffect, useState } from "react";
import { isValidQuantity } from "../../domain/quantityValidation";

interface QuantityStepperProps {
  value: number | null;
  onChange: (value: number | null) => void;
  step?: number;
  /**
   * v0.3 §1: Enter in het hoeveelheidveld slaat de huidige waarde op als
   * geteld en springt naar het volgende artikel — zelfde actie als de
   * "✓ Geteld & volgende"-knop. Wordt enkel aangeroepen wanneer er al een
   * geldige waarde is (0 telt als geldig, null niet) — zelfde voorwaarde als
   * de knop zelf (`disabled={quantity === null}` in ArticleCard).
   */
  onEnter?: () => void;
  /** v0.3 §1: laat de ouder dit invoerveld programmatisch focussen (bv. zodra deze kaart "actief" wordt). */
  inputRef?: (el: HTMLInputElement | null) => void;
}

/**
 * Hoeveelheid-invoer die zowel snel tikken met een numeriek toetsenbord
 * ondersteunt (direct "25" intikken) als de +/- knoppen. Decimalen zijn
 * toegestaan omdat sommige eenheden (bv. meter) geen gehele getallen zijn.
 */
export function QuantityStepper({ value, onChange, step = 1, onEnter, inputRef }: QuantityStepperProps) {
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
    // Data-integriteit-sprint §6: harde validatie ook hier, aan het
    // inputcomponent zelf — negatieve getallen, NaN en Infinity worden
    // simpelweg niet doorgegeven (het tekstveld toont dan gewoon de
    // ingetikte, nog niet aanvaarde tekst verder, zonder `onChange` te vuren).
    if (isValidQuantity(parsed)) {
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
        ref={inputRef}
        className="quantity-stepper__input"
        type="text"
        inputMode="decimal"
        placeholder="0"
        value={text}
        onChange={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (value === null) return; // zelfde voorwaarde als de knop: geen geldige waarde, geen actie.
          onEnter?.();
        }}
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
