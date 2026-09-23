import { useState } from "react";
import { newArticleService } from "../../application/container";
import { isValidQuantity } from "../../domain/quantityValidation";
import type { ArticleCountFrequency, CountSession } from "../../domain/types";
import { BigButton } from "./BigButton";

const FREQUENCY_OPTIONS: { value: ArticleCountFrequency; label: string }[] = [
  { value: "MONTHLY", label: "Maand" },
  { value: "QUARTERLY", label: "Kwartaal" },
  { value: "YEARLY", label: "Jaar" },
  { value: "NOT_APPLICABLE", label: "N.v.t." },
  { value: "TO_BE_DETERMINED", label: "Nog te bepalen" },
];

interface NewArticleFoundModalProps {
  session: CountSession;
  locationId: string;
  locationName: string;
  onClose: () => void;
  onCreated: (articleId: string) => void;
}

/**
 * "+ Nieuw artikel gevonden" (v0.2.1 correctieronde §3B): een SNELLERE
 * variant van het volledige beheerformulier, bedoeld voor tijdens het
 * fysiek tellen. Kantoor en huidige locatie staan al vast (locatie is hier
 * altijd `locationName`, niet aanpasbaar) — enkel omschrijving, productgroep,
 * eenheid, telperiode en de getelde hoeveelheid zijn verplicht; leverancier/
 * kostprijs/opmerking blijven optioneel. Een expliciete hoeveelheid van 0 is
 * een geldige invoer (geen leeg veld).
 */
export function NewArticleFoundModal({
  session,
  locationId,
  locationName,
  onClose,
  onCreated,
}: NewArticleFoundModalProps) {
  const [description, setDescription] = useState("");
  const [productGroup, setProductGroup] = useState("");
  const [unit, setUnit] = useState("");
  const [countPeriod, setCountPeriod] = useState<ArticleCountFrequency>("MONTHLY");
  const [quantity, setQuantity] = useState("");
  const [supplier, setSupplier] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Expliciete "0" moet geldig zijn: enkel een LEEG veld (of iets dat geen
  // getal is) blokkeert het opslaan — nooit `!quantity`, want dat zou "0"
  // ook als ongeldig behandelen.
  const parsedQuantity = quantity.trim() === "" ? null : Number(quantity);
  // Data-integriteit-sprint §6: naast "geen getal", ook negatief/Infinity
  // hier al blokkeren — niet enkel vertrouwen op de service-laagcontrole.
  const canSubmit =
    description.trim() !== "" &&
    productGroup.trim() !== "" &&
    unit.trim() !== "" &&
    parsedQuantity !== null &&
    isValidQuantity(parsedQuantity);

  async function handleSubmit() {
    if (!canSubmit || parsedQuantity === null) return;
    setError(null);
    setBusy(true);
    try {
      const article = await newArticleService.createArticleFoundDuringCounting(session, locationId, {
        description,
        productGroup,
        unit,
        countPeriod,
        quantity: parsedQuantity,
        supplier: supplier.trim() || null,
        costPrice: costPrice.trim() === "" ? null : Number(costPrice),
        comment: comment.trim() || null,
      });
      onCreated(article.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout bij het aanmaken van het artikel.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-card stack">
        <p style={{ margin: 0, fontWeight: 700 }}>Nieuw artikel gevonden</p>
        <p className="screen-subtitle" style={{ margin: 0 }}>
          Op {locationName}. Krijgt automatisch een tijdelijk artikelnummer en wordt meteen hier geteld.
        </p>

        {error && <div className="error-banner">{error}</div>}

        <label className="form-field">
          <span>Omschrijving *</span>
          <input
            className="search-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            autoFocus
          />
        </label>

        <label className="form-field">
          <span>Productgroep *</span>
          <input className="search-input" value={productGroup} onChange={(e) => setProductGroup(e.target.value)} />
        </label>

        <label className="form-field">
          <span>Eenheid *</span>
          <input className="search-input" value={unit} onChange={(e) => setUnit(e.target.value)} />
        </label>

        <label className="form-field">
          <span>Telperiode *</span>
          <select
            className="search-input"
            value={countPeriod}
            onChange={(e) => setCountPeriod(e.target.value as ArticleCountFrequency)}
          >
            {FREQUENCY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <label className="form-field">
          <span>Getelde hoeveelheid *</span>
          <input
            className="search-input"
            type="number"
            step="1"
            min="0"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>

        <label className="form-field">
          <span>Leverancier</span>
          <input className="search-input" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </label>

        <label className="form-field">
          <span>Kostprijs</span>
          <input
            className="search-input"
            type="number"
            step="0.01"
            value={costPrice}
            onChange={(e) => setCostPrice(e.target.value)}
          />
        </label>

        <label className="form-field">
          <span>Opmerking</span>
          <input className="search-input" value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>

        <div className="stack">
          <BigButton variant="primary" disabled={!canSubmit || busy} onClick={handleSubmit}>
            Opslaan en tellen
          </BigButton>
          <BigButton variant="ghost" disabled={busy} onClick={onClose}>
            Annuleren
          </BigButton>
        </div>
      </div>
    </div>
  );
}
