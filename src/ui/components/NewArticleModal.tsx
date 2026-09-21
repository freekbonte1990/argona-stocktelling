import { useState } from "react";
import { newArticleService } from "../../application/container";
import type { ArticleCountFrequency, Location } from "../../domain/types";
import { BigButton } from "./BigButton";

const FREQUENCY_OPTIONS: { value: ArticleCountFrequency; label: string }[] = [
  { value: "MONTHLY", label: "Maand" },
  { value: "QUARTERLY", label: "Kwartaal" },
  { value: "YEARLY", label: "Jaar" },
  { value: "NOT_APPLICABLE", label: "N.v.t." },
  { value: "TO_BE_DETERMINED", label: "Nog te bepalen" },
];

interface NewArticleModalProps {
  officeId: string;
  activeLocations: Location[];
  onClose: () => void;
  onCreated: (articleId: string) => void;
}

/**
 * "+ Nieuw artikel" (v0.2.1 correctieronde §3A): het volledige, rustige
 * beheerformulier vanuit het Artikels-overzicht. Verplicht: Omschrijving,
 * Productgroep, Eenheid, Telperiode. Optioneel: Leverancier, Kostprijs,
 * Opmerking, en één of meerdere stocklocaties.
 *
 * AANNAME (gedocumenteerd, expliciet toegelaten door de spec: "indien het
 * model dit makkelijk ondersteunt"): er is BEWUST geen apart veld
 * "Artikelnummer leverancier" toegevoegd — dat bestaat vandaag nergens in
 * het domeinmodel (`Article`), en het toevoegen ervan zou een schemawijziging
 * zijn die niets met deze correctieronde te maken heeft. Zie het eindrapport.
 */
export function NewArticleModal({ officeId, activeLocations, onClose, onCreated }: NewArticleModalProps) {
  const [description, setDescription] = useState("");
  const [productGroup, setProductGroup] = useState("");
  const [unit, setUnit] = useState("");
  const [countPeriod, setCountPeriod] = useState<ArticleCountFrequency>("MONTHLY");
  const [supplier, setSupplier] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [comment, setComment] = useState("");
  const [locationIds, setLocationIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = description.trim() !== "" && productGroup.trim() !== "" && unit.trim() !== "";

  function toggleLocation(id: string) {
    setLocationIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      const article = await newArticleService.createArticle(officeId, {
        description,
        productGroup,
        unit,
        countPeriod,
        supplier: supplier.trim() || null,
        costPrice: costPrice.trim() === "" ? null : Number(costPrice),
        comment: comment.trim() || null,
        locationIds: Array.from(locationIds),
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
        <p style={{ margin: 0, fontWeight: 700 }}>Nieuw artikel</p>
        <p className="screen-subtitle" style={{ margin: 0 }}>
          Krijgt automatisch een tijdelijk artikelnummer. Het officiële artikelnummer wordt later door
          eBuddy toegekend.
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

        {activeLocations.length > 0 && (
          <div className="form-field">
            <span>Stocklocatie(s)</span>
            <div className="filter-row">
              {activeLocations.map((location) => (
                <button
                  key={location.id}
                  type="button"
                  className={`chip ${locationIds.has(location.id) ? "chip--active" : ""}`}
                  onClick={() => toggleLocation(location.id)}
                >
                  {location.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="stack">
          <BigButton variant="primary" disabled={!canSubmit || busy} onClick={handleSubmit}>
            Artikel aanmaken
          </BigButton>
          <BigButton variant="ghost" disabled={busy} onClick={onClose}>
            Annuleren
          </BigButton>
        </div>
      </div>
    </div>
  );
}
